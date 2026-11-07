package transfer

import (
	"context"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/davidliyutong/blift/cli/internal/api"
)

type UploadOptions struct {
	Name      string // blob name; default: base name of the file
	Overwrite bool
	Jobs      int // parallel part uploads (multipart only)
	Progress  Progress
}

// ContentType guesses the MIME type from the file extension.
func ContentType(name string) string {
	if ct := mime.TypeByExtension(filepath.Ext(name)); ct != "" {
		return ct
	}
	return "application/octet-stream"
}

// Upload sends one local file to a project: init → single PUT or multipart → complete.
// On any failure (including ctx cancellation) the pending upload is aborted.
func Upload(ctx context.Context, c *api.Client, projectID, path string, o UploadOptions) (_ *api.Blob, err error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	name := o.Name
	if name == "" {
		name = filepath.Base(path)
	}
	ct, size, prog := ContentType(name), st.Size(), orNop(o.Progress)

	up, err := c.InitUpload(ctx, projectID, api.UploadRequest{Name: name, Size: size, ContentType: ct, Overwrite: o.Overwrite})
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			actx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
			defer cancel()
			_ = c.AbortUpload(actx, up.BlobID)
		}
	}()

	var parts []api.Part
	switch up.Mode {
	case "single":
		_, err = put(ctx, up.URL, f, 0, size, ct, prog)
	case "multipart":
		parts, err = uploadParts(ctx, c, up, f, size, max(o.Jobs, 1), prog)
	default:
		err = fmt.Errorf("unknown upload mode %q", up.Mode)
	}
	if err != nil {
		return nil, err
	}
	return c.CompleteUpload(ctx, up.BlobID, parts)
}

// put uploads bytes [off, off+n) of f to a presigned URL with retries and returns the ETag.
func put(ctx context.Context, url string, f io.ReaderAt, off, n int64, ct string, prog Progress) (etag string, err error) {
	err = retry(ctx, prog, func(p Progress) error {
		var body io.Reader = http.NoBody
		if n > 0 {
			body = &progressReader{r: io.NewSectionReader(f, off, n), p: p}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, body)
		if err != nil {
			return err
		}
		req.ContentLength = n
		if ct != "" {
			req.Header.Set("Content-Type", ct)
		}
		resp, err := HTTP.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode/100 != 2 {
			return httpError(resp)
		}
		etag = resp.Header.Get("ETag")
		return nil
	})
	return etag, err
}

// uploadParts fetches part URLs in batches of ≤100 and PUTs the parts with `jobs` workers.
func uploadParts(ctx context.Context, c *api.Client, up *api.UploadInit, f io.ReaderAt, size int64, jobs int, prog Progress) ([]api.Part, error) {
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)

	type job struct {
		n   int
		url string
	}
	jobCh := make(chan job)
	parts := make([]api.Part, up.PartCount)
	var wg sync.WaitGroup
	for range jobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobCh {
				if ctx.Err() != nil {
					continue
				}
				off := int64(j.n-1) * up.PartSize
				etag, err := put(ctx, j.url, f, off, min(up.PartSize, size-off), "", prog)
				if err == nil && etag == "" {
					err = fmt.Errorf("storage: no ETag returned for part %d", j.n)
				}
				if err != nil {
					cancel(fmt.Errorf("part %d: %w", j.n, err))
					continue
				}
				parts[j.n-1] = api.Part{PartNumber: j.n, ETag: etag}
			}
		}()
	}

feed:
	for start := 1; start <= up.PartCount; start += 100 {
		nums := make([]int, 0, 100)
		for n := start; n <= min(start+99, up.PartCount); n++ {
			nums = append(nums, n)
		}
		urls, err := c.PartURLs(ctx, up.BlobID, nums)
		if err != nil {
			cancel(err)
			break
		}
		for _, n := range nums {
			u, ok := urls[strconv.Itoa(n)]
			if !ok {
				cancel(fmt.Errorf("server returned no URL for part %d", n))
				break feed
			}
			select {
			case jobCh <- job{n, u}:
			case <-ctx.Done():
				break feed
			}
		}
	}
	close(jobCh)
	wg.Wait()
	if err := context.Cause(ctx); err != nil {
		return nil, err
	}
	return parts, nil
}
