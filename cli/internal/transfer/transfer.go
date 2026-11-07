// Package transfer moves bytes between local files and S3 presigned URLs.
package transfer

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

var (
	// HTTP is used for presigned S3 requests (no overall timeout: files can be huge).
	HTTP = &http.Client{Transport: func() *http.Transport {
		t := http.DefaultTransport.(*http.Transport).Clone()
		t.ResponseHeaderTimeout = 2 * time.Minute
		t.MaxIdleConnsPerHost = 32
		return t
	}()}
	Retries    = 3           // retries after the first attempt, per part / chunk
	RetryDelay = time.Second // doubled on every retry

	RangeThreshold int64 = 64 << 20 // files larger than this are downloaded with parallel Range requests
	ChunkSize      int64 = 16 << 20 // size of each Range request
)

// Progress receives transferred byte counts (negative to roll back a failed attempt).
type Progress interface{ Add(int64) }

type nopProgress struct{}

func (nopProgress) Add(int64) {}

func orNop(p Progress) Progress {
	if p == nil {
		return nopProgress{}
	}
	return p
}

// counter forwards to a Progress while remembering how much this attempt reported.
type counter struct {
	p Progress
	n atomic.Int64
}

func (c *counter) Add(n int64) { c.n.Add(n); c.p.Add(n) }

// retry runs fn up to 1+Retries times with exponential backoff, undoing the
// progress of failed attempts.
func retry(ctx context.Context, p Progress, fn func(Progress) error) error {
	for attempt := 0; ; attempt++ {
		c := &counter{p: p}
		err := fn(c)
		if err == nil {
			return nil
		}
		p.Add(-c.n.Load())
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if attempt >= Retries {
			return err
		}
		select {
		case <-time.After(RetryDelay << attempt):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

type progressReader struct {
	r io.Reader
	p Progress
}

func (r *progressReader) Read(b []byte) (int, error) {
	n, err := r.r.Read(b)
	r.p.Add(int64(n))
	return n, err
}

type progressWriter struct {
	w io.Writer
	p Progress
}

func (w *progressWriter) Write(b []byte) (int, error) {
	n, err := w.w.Write(b)
	w.p.Add(int64(n))
	return n, err
}

// httpError turns a non-2xx S3 response into an error, using the S3 XML error body when present.
func httpError(resp *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
	var e struct{ Code, Message string }
	if xml.Unmarshal(body, &e) == nil && e.Code != "" {
		return fmt.Errorf("storage: %s: %s %s", resp.Status, e.Code, e.Message)
	}
	msg := strings.TrimSpace(string(body))
	if len(msg) > 200 {
		msg = msg[:200]
	}
	return fmt.Errorf("storage: %s %s", resp.Status, msg)
}
