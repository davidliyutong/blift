package transfer

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
)

// Download fetches a presigned URL into dest. Files larger than RangeThreshold are
// fetched with `jobs` parallel Range requests into a preallocated file; smaller ones
// with a single stream. Data goes to dest+".part" and is renamed on success.
func Download(ctx context.Context, url string, size int64, dest string, jobs int, prog Progress) (err error) {
	prog = orNop(prog)
	tmp := dest + ".part"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_RDWR|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer func() {
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			os.Remove(tmp)
			return
		}
		err = os.Rename(tmp, dest)
	}()
	if size > RangeThreshold && jobs > 1 {
		return downloadRanged(ctx, url, f, size, jobs, prog)
	}
	return downloadStream(ctx, url, f, size, prog)
}

func get(ctx context.Context, url, rng string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if rng != "" {
		req.Header.Set("Range", rng)
	}
	return HTTP.Do(req)
}

func downloadStream(ctx context.Context, url string, f *os.File, size int64, prog Progress) error {
	resp, err := get(ctx, url, "")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return httpError(resp)
	}
	n, err := io.Copy(&progressWriter{w: f, p: prog}, resp.Body)
	if err == nil && n != size {
		err = fmt.Errorf("size mismatch: got %d bytes, expected %d", n, size)
	}
	return err
}

func downloadRanged(ctx context.Context, url string, f *os.File, size int64, jobs int, prog Progress) error {
	if err := f.Truncate(size); err != nil {
		return err
	}
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)

	offs := make(chan int64)
	var wg sync.WaitGroup
	for range jobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for off := range offs {
				if ctx.Err() != nil {
					continue
				}
				n := min(ChunkSize, size-off)
				if err := retry(ctx, prog, func(p Progress) error { return getRange(ctx, url, f, off, n, p) }); err != nil {
					cancel(err)
				}
			}
		}()
	}
	for off := int64(0); off < size && ctx.Err() == nil; off += ChunkSize {
		select {
		case offs <- off:
		case <-ctx.Done():
		}
	}
	close(offs)
	wg.Wait()
	return context.Cause(ctx)
}

func getRange(ctx context.Context, url string, f *os.File, off, n int64, p Progress) error {
	resp, err := get(ctx, url, fmt.Sprintf("bytes=%d-%d", off, off+n-1))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusPartialContent {
		if resp.StatusCode == http.StatusOK {
			return fmt.Errorf("storage ignored the Range header")
		}
		return httpError(resp)
	}
	got, err := io.Copy(&progressWriter{w: io.NewOffsetWriter(f, off), p: p}, io.LimitReader(resp.Body, n))
	if err == nil && got != n {
		err = io.ErrUnexpectedEOF
	}
	return err
}
