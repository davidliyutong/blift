package transfer

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/davidliyutong/blift/cli/internal/api"
)

func init() { RetryDelay = time.Millisecond }

func randomFile(t *testing.T, size int) (string, []byte) {
	t.Helper()
	data := make([]byte, size)
	rand.New(rand.NewSource(int64(size))).Read(data)
	p := filepath.Join(t.TempDir(), "data.bin")
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return p, data
}

type sumProgress struct{ n atomic.Int64 }

func (p *sumProgress) Add(n int64) { p.n.Add(n) }

// fakeServer is a blift API + S3 stand-in for uploads.
type fakeServer struct {
	t         *testing.T
	srv       *httptest.Server
	mode      string
	partSize  int64
	partCount int

	mu        sync.Mutex
	stored    map[int][]byte // part number (0 = single) -> body
	completed []api.Part
	aborted   bool
	failOnce  map[int]bool // parts that fail on the first attempt
	init      api.UploadRequest
	ctype     string
	viaLink   bool   // the calls came through the upload link "tok"
	access    string // X-Share-Access sent with the link's init
}

// The fake upload link: its calls map onto the project ones, after checking the tokens.
const linkUploads = "/api/public/shares/tok/uploads"

func newFakeServer(t *testing.T, mode string, partSize int64, partCount int) *fakeServer {
	f := &fakeServer{t: t, mode: mode, partSize: partSize, partCount: partCount, stored: map[int][]byte{}, failOnce: map[int]bool{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeServer) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	path := r.URL.Path
	if rest, ok := strings.CutPrefix(path, linkUploads); ok {
		f.viaLink = true
		if rest == "" {
			f.access = r.Header.Get("X-Share-Access")
			path = "/api/projects/p1/uploads"
		} else {
			if got := r.Header.Get("X-Upload-Token"); got != "ut1" {
				f.t.Errorf("%s %s: upload token %q", r.Method, path, got)
			}
			path = "/api/uploads" + rest
		}
	}
	switch {
	case r.Method == "POST" && path == "/api/projects/p1/uploads":
		json.NewDecoder(r.Body).Decode(&f.init)
		res := api.ShareUploadInit{UploadInit: api.UploadInit{BlobID: "b1", Mode: f.mode}, UploadToken: "ut1"}
		if f.mode == "single" {
			res.URL = f.srv.URL + "/s3/obj"
		} else {
			res.PartSize, res.PartCount = f.partSize, f.partCount
		}
		json.NewEncoder(w).Encode(res)
	case r.Method == "POST" && path == "/api/uploads/b1/parts":
		var body struct {
			PartNumbers []int `json:"part_numbers"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if len(body.PartNumbers) > 100 {
			f.t.Errorf("requested %d part URLs in one call", len(body.PartNumbers))
		}
		urls := map[string]string{}
		for _, n := range body.PartNumbers {
			urls[strconv.Itoa(n)] = fmt.Sprintf("%s/s3/obj?partNumber=%d", f.srv.URL, n)
		}
		json.NewEncoder(w).Encode(map[string]any{"urls": urls})
	case r.Method == "PUT" && r.URL.Path == "/s3/obj":
		n, _ := strconv.Atoi(r.URL.Query().Get("partNumber"))
		if r.ContentLength < 0 || r.TransferEncoding != nil {
			f.t.Errorf("part %d: missing Content-Length", n)
		}
		body, _ := io.ReadAll(r.Body)
		if f.failOnce[n] {
			delete(f.failOnce, n)
			w.WriteHeader(http.StatusInternalServerError)
			w.Write([]byte(`<Error><Code>InternalError</Code><Message>boom</Message></Error>`))
			return
		}
		f.stored[n] = body
		if n == 0 {
			f.ctype = r.Header.Get("Content-Type")
		}
		w.Header().Set("ETag", fmt.Sprintf(`"%x"`, md5.Sum(body)))
	case r.Method == "POST" && path == "/api/uploads/b1/complete":
		var body struct{ Parts []api.Part }
		json.NewDecoder(r.Body).Decode(&body)
		f.completed = body.Parts
		if f.viaLink { // the link took a free name
			json.NewEncoder(w).Encode(api.ShareUploaded{Name: "data (1).bin", Size: f.init.Size})
			return
		}
		json.NewEncoder(w).Encode(api.Blob{ID: "b1", Name: f.init.Name, Size: f.init.Size})
	case r.Method == "DELETE" && path == "/api/uploads/b1":
		f.aborted = true
		w.WriteHeader(http.StatusNoContent)
	default:
		f.t.Errorf("unexpected %s %s", r.Method, r.URL)
		http.NotFound(w, r)
	}
}

func TestSingleUpload(t *testing.T) {
	path, data := randomFile(t, 1000)
	f := newFakeServer(t, "single", 0, 0)
	prog := &sumProgress{}
	b, err := Upload(context.Background(), api.New(f.srv.URL, "tok"), "p1", path,
		UploadOptions{Name: "notes.txt", Progress: prog})
	if err != nil {
		t.Fatal(err)
	}
	if b.Name != "notes.txt" || f.init.Size != 1000 || !strings.HasPrefix(f.init.ContentType, "text/plain") {
		t.Fatalf("init = %+v, blob = %+v", f.init, b)
	}
	if !bytes.Equal(f.stored[0], data) || f.completed != nil || prog.n.Load() != 1000 {
		t.Fatalf("stored %d bytes, completed %v, progress %d", len(f.stored[0]), f.completed, prog.n.Load())
	}
	if !strings.HasPrefix(f.ctype, "text/plain") {
		t.Fatalf("content-type %q", f.ctype)
	}
}

func TestMultipartUpload(t *testing.T) {
	const partSize, size = 1000, 250_500 // 251 parts → three part-URL batches; last part 500 bytes
	path, data := randomFile(t, size)
	f := newFakeServer(t, "multipart", partSize, 251)
	f.failOnce[7] = true // retried transparently
	prog := &sumProgress{}
	_, err := Upload(context.Background(), api.New(f.srv.URL, "tok"), "p1", path, UploadOptions{Jobs: 8, Progress: prog})
	if err != nil {
		t.Fatal(err)
	}
	if f.init.Name != "data.bin" || f.init.ContentType != "application/octet-stream" {
		t.Fatalf("init = %+v", f.init)
	}
	if len(f.completed) != 251 {
		t.Fatalf("completed with %d parts", len(f.completed))
	}
	var joined []byte
	for i, p := range f.completed {
		body := f.stored[i+1]
		want := partSize
		if i == 250 {
			want = 500
		}
		if p.PartNumber != i+1 || len(body) != want || p.ETag != fmt.Sprintf(`"%x"`, md5.Sum(body)) {
			t.Fatalf("part %d: %+v, %d bytes", i+1, p, len(body))
		}
		joined = append(joined, body...)
	}
	if !bytes.Equal(joined, data) || prog.n.Load() != size || f.aborted {
		t.Fatalf("data mismatch=%v progress=%d aborted=%v", !bytes.Equal(joined, data), prog.n.Load(), f.aborted)
	}
}

func TestUploadAbortsOnFailure(t *testing.T) {
	path, _ := randomFile(t, 5000)
	f := newFakeServer(t, "multipart", 1000, 5)
	for n := 1; n <= 5; n++ {
		f.failOnce[n] = true
	}
	old := Retries
	Retries = 0
	defer func() { Retries = old }()
	_, err := Upload(context.Background(), api.New(f.srv.URL, "tok"), "p1", path, UploadOptions{Jobs: 2})
	if err == nil || !strings.Contains(err.Error(), "InternalError") {
		t.Fatalf("want storage error, got %v", err)
	}
	if !f.aborted || f.completed != nil {
		t.Fatalf("aborted=%v completed=%v", f.aborted, f.completed)
	}
}

func TestUploadToLink(t *testing.T) {
	const partSize, size = 1000, 2500
	path, data := randomFile(t, size)
	f := newFakeServer(t, "multipart", partSize, 3)
	r, err := UploadToLink(context.Background(), api.New(f.srv.URL, ""), "tok", "acc", path, UploadOptions{Jobs: 2})
	if err != nil {
		t.Fatal(err)
	}
	if *r != (api.ShareUploaded{Name: "data (1).bin", Size: size}) || f.access != "acc" || len(f.completed) != 3 {
		t.Fatalf("result %+v, access %q, %d parts", r, f.access, len(f.completed))
	}
	if !bytes.Equal(append(append(f.stored[1], f.stored[2]...), f.stored[3]...), data) {
		t.Fatal("data mismatch")
	}
}

func TestUploadToLinkAbortsOnFailure(t *testing.T) {
	path, _ := randomFile(t, 100)
	f := newFakeServer(t, "single", 0, 0)
	f.failOnce[0] = true
	old := Retries
	Retries = 0
	defer func() { Retries = old }()
	if _, err := UploadToLink(context.Background(), api.New(f.srv.URL, ""), "tok", "", path, UploadOptions{}); err == nil {
		t.Fatal("want an error")
	}
	if !f.aborted || !f.viaLink { // the abort carried the upload token (checked by the server)
		t.Fatalf("aborted=%v viaLink=%v", f.aborted, f.viaLink)
	}
}

func TestRangedDownload(t *testing.T) {
	oldT, oldC := RangeThreshold, ChunkSize
	RangeThreshold, ChunkSize = 10_000, 3_333
	defer func() { RangeThreshold, ChunkSize = oldT, oldC }()

	_, data := randomFile(t, 100_001)
	var ranged, failed atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") == "" {
			t.Error("expected a Range request")
		}
		if r.Header.Get("Range") == "bytes=6666-9998" && failed.Add(1) == 1 {
			w.WriteHeader(http.StatusServiceUnavailable) // first attempt of one chunk fails
			return
		}
		ranged.Add(1)
		http.ServeContent(w, r, "x", time.Time{}, bytes.NewReader(data))
	}))
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "out.bin")
	prog := &sumProgress{}
	if err := Download(context.Background(), srv.URL, int64(len(data)), dest, 4, prog); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(dest)
	if !bytes.Equal(got, data) || ranged.Load() != 31 || prog.n.Load() != int64(len(data)) {
		t.Fatalf("equal=%v requests=%d progress=%d", bytes.Equal(got, data), ranged.Load(), prog.n.Load())
	}
	if _, err := os.Stat(dest + ".part"); !os.IsNotExist(err) {
		t.Fatal("temporary file left behind")
	}
}

func TestStreamDownload(t *testing.T) {
	_, data := randomFile(t, 5000)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != "" {
			t.Error("small files should not use Range")
		}
		w.Write(data)
	}))
	defer srv.Close()
	dest := filepath.Join(t.TempDir(), "out.bin")
	if err := Download(context.Background(), srv.URL, 5000, dest, 4, nil); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(dest); !bytes.Equal(got, data) {
		t.Fatal("content mismatch")
	}
	// size mismatch is an error and leaves no file behind
	dest2 := filepath.Join(t.TempDir(), "bad.bin")
	if err := Download(context.Background(), srv.URL, 4000, dest2, 1, nil); err == nil {
		t.Fatal("expected size mismatch error")
	}
	if _, err := os.Stat(dest2); !os.IsNotExist(err) {
		t.Fatal("partial file left behind")
	}
}
