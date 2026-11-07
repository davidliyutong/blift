// Package ui has small terminal helpers: tables, sizes, times, prompts and progress bars.
package ui

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"golang.org/x/term"
)

func IsTTY(f *os.File) bool { return term.IsTerminal(int(f.Fd())) }

// Size formats bytes with binary units (KiB, MiB, ...).
func Size(n int64) string {
	if n < 1024 {
		return fmt.Sprintf("%d B", n)
	}
	v, units := float64(n), "KMGTPE"
	i := -1
	for v >= 1024 && i < len(units)-1 {
		v /= 1024
		i++
	}
	return fmt.Sprintf("%.1f %ciB", v, units[i])
}

// Time formats a unix-millisecond timestamp in local time ("-" for zero).
func Time(ms int64) string {
	if ms == 0 {
		return "-"
	}
	return time.UnixMilli(ms).Local().Format("2006-01-02 15:04")
}

// TimePtr is Time for nullable timestamps; nil renders as none.
func TimePtr(ms *int64, none string) string {
	if ms == nil {
		return none
	}
	return Time(*ms)
}

// Table writes an aligned table; an empty header is skipped (key/value layouts).
// Unlike text/tabwriter it measures display width, so CJK text lines up.
func Table(w io.Writer, header []string, rows [][]string) {
	if len(header) > 0 {
		rows = append([][]string{header}, rows...)
	}
	var widths []int
	for _, r := range rows {
		for i, c := range r {
			if i == len(widths) {
				widths = append(widths, 0)
			}
			widths[i] = max(widths[i], Width(c))
		}
	}
	for _, r := range rows {
		var b strings.Builder
		for i, c := range r {
			b.WriteString(c)
			if i < len(r)-1 {
				b.WriteString(strings.Repeat(" ", widths[i]-Width(c)+2))
			}
		}
		fmt.Fprintln(w, b.String())
	}
}

// Width is the terminal display width of s (East Asian wide characters count 2).
func Width(s string) int {
	w := 0
	for _, r := range s {
		w++
		if r >= 0x1100 && (r <= 0x115f || r == 0x2329 || r == 0x232a ||
			(r >= 0x2e80 && r <= 0xa4cf && r != 0x303f) || (r >= 0xac00 && r <= 0xd7a3) ||
			(r >= 0xf900 && r <= 0xfaff) || (r >= 0xfe30 && r <= 0xfe6f) || (r >= 0xff00 && r <= 0xff60) ||
			(r >= 0xffe0 && r <= 0xffe6) || (r >= 0x1f300 && r <= 0x1f64f) || (r >= 0x20000 && r <= 0x3fffd)) {
			w++
		}
	}
	return w
}

// Confirm asks a yes/no question on stderr and reads the answer from stdin.
func Confirm(prompt string) bool {
	fmt.Fprint(os.Stderr, prompt+" [y/N] ")
	line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes":
		return true
	}
	return false
}

// ReadPassword prompts on stderr and reads a line from the terminal without echo.
func ReadPassword(prompt string) (string, error) {
	fmt.Fprint(os.Stderr, prompt)
	b, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr)
	return string(b), err
}
