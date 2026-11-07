package update

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestCompare(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want int
	}{
		{"v0.1.1", "0.1.1", 0},
		{"v0.1.1-3-gabc-dirty", "0.1.1", 0},
		{"v0.1.0", "0.1.1", -1},
		{"0.10.0", "0.9.9", 1},
		{"dev", "0.0.1", -1},
		{"v1.0.0", "v0.99.99", 1},
	} {
		if got := Compare(c.a, c.b); got != c.want {
			t.Errorf("Compare(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

// release builds a release archive like `make cli-dist` and its SHA256SUMS line.
func release(t *testing.T, version, goos, goarch string, binary []byte) (archive []byte, sums string) {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	dir := "blift_" + version + "_" + goos + "_" + goarch
	for name, body := range map[string][]byte{dir + "/blift": binary, dir + "/LICENSE": []byte("MIT")} {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		tw.Write(body)
	}
	tw.Close()
	gz.Close()
	sum := sha256.Sum256(buf.Bytes())
	return buf.Bytes(), hex.EncodeToString(sum[:]) + "  " + dir + ".tar.gz\n"
}

func TestFetchFallsBackAndVerifies(t *testing.T) {
	archive, sums := release(t, "9.9.9", "linux", "arm64", []byte("#!new binary"))
	relay := httptest.NewServer(http.NotFoundHandler()) // e.g. an older server without the relay
	defer relay.Close()
	served := sums
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v9.9.9/blift_9.9.9_linux_arm64.tar.gz":
			w.Write(archive)
		case "/v9.9.9/SHA256SUMS":
			w.Write([]byte(served))
		default:
			http.NotFound(w, r)
		}
	}))
	defer github.Close()

	u := New("test")
	var skipped []string
	bin, err := u.Fetch(context.Background(), []string{relay.URL, github.URL}, "9.9.9", "linux", "arm64", func(s string, _ error) {
		skipped = append(skipped, s)
	})
	if err != nil || string(bin) != "#!new binary" || len(skipped) != 1 || skipped[0] != relay.URL {
		t.Fatalf("bin=%q err=%v skipped=%v", bin, err, skipped)
	}

	served = "0000000000000000000000000000000000000000000000000000000000000000  blift_9.9.9_linux_arm64.tar.gz\n"
	if _, err := u.Fetch(context.Background(), []string{github.URL, relay.URL}, "9.9.9", "linux", "arm64", nil); !errors.Is(err, ErrChecksum) {
		t.Fatalf("tampered archive: err=%v, want ErrChecksum", err)
	}
}

func TestReplace(t *testing.T) {
	exe := filepath.Join(t.TempDir(), "blift")
	if err := os.WriteFile(exe, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := Replace(exe, []byte("new")); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(exe)
	st, _ := os.Stat(exe)
	if string(got) != "new" || st.Mode().Perm() != 0o755 {
		t.Fatalf("content %q mode %v", got, st.Mode())
	}
	if left, _ := filepath.Glob(filepath.Join(filepath.Dir(exe), ".blift-update-*")); len(left) != 0 {
		t.Fatalf("temp files left: %v", left)
	}
}

func TestLatestFromServer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/cli/latest" {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(`{"version":"1.2.3"}`))
	}))
	defer srv.Close()
	if v, err := New("test").Latest(context.Background(), srv.URL); err != nil || v != "1.2.3" {
		t.Fatalf("v=%q err=%v", v, err)
	}
}

func TestSources(t *testing.T) {
	t.Setenv("BLIFT_DOWNLOAD_URL", "")
	if s := Sources("https://files.example.com/"); len(s) != 2 || s[0] != "https://files.example.com/api/cli/download" || s[1] != Releases+"/download" {
		t.Fatalf("sources %v", s)
	}
	t.Setenv("BLIFT_DOWNLOAD_URL", "https://mirror.example.com/blift/")
	if s := Sources("https://files.example.com"); len(s) != 1 || s[0] != "https://mirror.example.com/blift" {
		t.Fatalf("mirror sources %v", s)
	}
}
