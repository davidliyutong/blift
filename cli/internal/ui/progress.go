package ui

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/term"
)

// Bar is a single-line progress bar on stderr. A nil *Bar is a valid no-op.
type Bar struct {
	name  string
	total int64
	cur   atomic.Int64
	start time.Time
	stop  chan struct{}
	wg    sync.WaitGroup
}

// NewBar returns a running bar, or nil when disabled (so callers need no checks).
func NewBar(name string, total int64, enabled bool) *Bar {
	if !enabled {
		return nil
	}
	b := &Bar{name: name, total: total, start: time.Now(), stop: make(chan struct{})}
	b.wg.Add(1)
	go func() {
		defer b.wg.Done()
		t := time.NewTicker(200 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				b.render()
			case <-b.stop:
				return
			}
		}
	}()
	return b
}

// Add records n transferred bytes (negative to roll back a failed retry).
func (b *Bar) Add(n int64) {
	if b != nil {
		b.cur.Add(n)
	}
}

// Finish stops the bar, drawing the final state and a newline.
func (b *Bar) Finish() {
	if b == nil {
		return
	}
	close(b.stop)
	b.wg.Wait()
	b.render()
	fmt.Fprintln(os.Stderr)
}

func (b *Bar) render() {
	cur := b.cur.Load()
	elapsed := time.Since(b.start).Seconds()
	speed := float64(cur) / max(elapsed, 0.001)
	pct := 100.0
	if b.total > 0 {
		pct = float64(cur) * 100 / float64(b.total)
	}
	eta := "--:--"
	if speed > 0 && cur < b.total {
		s := int(float64(b.total-cur) / speed)
		eta = fmt.Sprintf("%02d:%02d", s/60, s%60)
	} else if cur >= b.total {
		eta = fmt.Sprintf("%02d:%02d", int(elapsed)/60, int(elapsed)%60)
	}
	name := b.name
	if Width(name) > 24 {
		r := []rune(name)
		for Width(string(r)) > 23 {
			r = r[:len(r)-1]
		}
		name = string(r) + "…"
	}
	stats := fmt.Sprintf(" %5.1f%% %10s / %-10s %10s/s %s", pct, Size(cur), Size(b.total), Size(int64(speed)), eta)
	width := 80
	if w, _, err := term.GetSize(int(os.Stderr.Fd())); err == nil && w > 0 {
		width = w
	}
	barW := min(width-len(stats)-Width(name)-4, 30)
	bar := ""
	if barW >= 10 {
		fill := int(float64(barW) * min(pct, 100) / 100)
		bar = " [" + strings.Repeat("=", fill) + strings.Repeat(" ", barW-fill) + "]"
	}
	fmt.Fprintf(os.Stderr, "\r\033[K%s%s%s", name, bar, stats)
}
