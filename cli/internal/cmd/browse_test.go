package cmd

import (
	"context"
	"errors"
	"sort"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/davidliyutong/blift/cli/internal/i18n"
)

// memSide is a side kept in memory: directories are keys ("", "docs", "docs/2026"), values their entries.
type memSide struct {
	name string
	tree map[string][]entry
	log  []string
}

func (s *memSide) label() string             { return s.name }
func (s *memSide) show(path []string) string { return s.name + ":" + strings.Join(path, "/") }
func (s *memSide) list(_ context.Context, path []string) ([]entry, error) {
	es, ok := s.tree[strings.Join(path, "/")]
	if !ok {
		return nil, errors.New("no such directory")
	}
	out := append([]entry{}, es...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].dir && !out[j].dir })
	return out, nil
}
func (s *memSide) mkdir(_ context.Context, path []string, name string) error {
	key := strings.Join(path, "/")
	s.tree[key] = append(s.tree[key], entry{name: name, dir: true})
	s.tree[strings.Join(append(append([]string{}, path...), name), "/")] = nil
	s.log = append(s.log, "mkdir "+name)
	return nil
}
func (s *memSide) rename(_ context.Context, path []string, e entry, name string) error {
	s.log = append(s.log, "rename "+e.name+" "+name)
	return nil
}
func (s *memSide) remove(_ context.Context, path []string, entries []entry) error {
	s.log = append(s.log, "rm "+strings.Join(path, "/"))
	return nil
}

// drive feeds a message to the model and runs the commands it returns to the end (but not the
// tick, which only re-arms itself while transfers run).
func drive(m *browser, msg tea.Msg) {
	_, cmd := m.Update(msg)
	run(m, cmd)
}

func run(m *browser, cmd tea.Cmd) {
	if cmd == nil {
		return
	}
	switch msg := cmd().(type) {
	case tea.BatchMsg:
		for _, c := range msg {
			run(m, c)
		}
	case nil, tickMsg, tea.QuitMsg:
	default:
		drive(m, msg)
	}
}

func press(m *browser, keys ...string) {
	for _, k := range keys {
		msg := tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)}
		switch k {
		case "enter":
			msg = tea.KeyMsg{Type: tea.KeyEnter}
		case "tab":
			msg = tea.KeyMsg{Type: tea.KeyTab}
		case "esc":
			msg = tea.KeyMsg{Type: tea.KeyEsc}
		case " ":
			msg = tea.KeyMsg{Type: tea.KeySpace, Runes: []rune(" ")}
		}
		drive(m, msg)
	}
}

func TestBrowser(t *testing.T) {
	i18n.SetLang("en")
	remote := &memSide{name: "server", tree: map[string][]entry{
		"":                {{name: "alice/demo", dir: true}},
		"alice/demo":      {{name: "docs", dir: true}, {name: "a.txt", size: 3}, {name: "数据 2026.csv", size: 2048}},
		"alice/demo/docs": {{name: "deep.pdf", size: 10}},
	}}
	local := &memSide{name: "local", tree: map[string][]entry{"": {{name: "notes.md", size: 5}}}}
	mk := func(fs side) *pane { return &pane{fs: fs, selected: map[string]bool{}, cursors: map[string]int{}} }
	m := &browser{ctx: context.Background(), panes: [2]*pane{mk(remote), mk(local)}, lists: map[string]*listing{}}
	run(m, m.Init())
	drive(m, tea.WindowSizeMsg{Width: 100, Height: 20})

	names := func() string {
		var out []string
		for _, e := range m.entries() {
			out = append(out, e.name)
		}
		return strings.Join(out, ",")
	}
	if names() != "alice/demo" {
		t.Fatalf("projects: %q", names())
	}
	// Into the project; the folder under the cursor is loaded for the third column.
	press(m, "l")
	if names() != "docs,a.txt,数据 2026.csv" || m.listingOf(m.cur(), []string{"alice/demo", "docs"}) == nil {
		t.Fatalf("project listing: %q", names())
	}
	view := m.View()
	for _, want := range []string{"docs/", "a.txt", "数据 2026.csv", "deep.pdf", "alice/demo", "2.0 KiB"} {
		if !strings.Contains(view, want) {
			t.Errorf("view lacks %q:\n%s", want, view)
		}
	}
	for _, line := range strings.Split(view, "\n") {
		if w := lipglossWidth(line); w > 100 {
			t.Errorf("line is %d cells wide: %q", w, line)
		}
	}
	// Down and into docs, back up: the cursor returns to docs.
	press(m, "j", "j", "k", "k", "enter")
	if names() != "deep.pdf" {
		t.Fatalf("docs: %q", names())
	}
	press(m, "h")
	if e, _ := m.under(); e.name != "docs" {
		t.Errorf("cursor after going up: %q", e.name)
	}
	// Selection and clipboard.
	press(m, "j", " ", " ")
	if got := m.picked(); len(got) != 2 || got[0].name != "a.txt" {
		t.Errorf("picked: %+v", got)
	}
	press(m, "y")
	if m.clip == nil || len(m.clip.entries) != 2 || m.clip.cut || m.clip.pane != 0 {
		t.Fatalf("clipboard: %+v", m.clip)
	}
	// A copy pasted on the same side is refused with a hint.
	press(m, "p")
	if !m.isErr || !strings.Contains(m.status, "other side") {
		t.Errorf("same-side paste: %q", m.status)
	}
	// New folder, rename (the input takes typed text, CJK included), delete after a yes.
	press(m, "n", "新", "x", "enter")
	press(m, "g", "r", "2", "enter")
	press(m, "d", "n")
	press(m, "d", "y")
	if got := strings.Join(remote.log, "; "); got != "mkdir 新x; rename docs docs2; rm alice/demo" {
		t.Errorf("operations: %q", got)
	}
	// The other side, and help.
	press(m, "tab")
	if names() != "notes.md" || !strings.Contains(m.View(), "notes.md") {
		t.Errorf("local side: %q", names())
	}
	press(m, "?")
	if !strings.Contains(m.View(), "paste here") {
		t.Error("help is not shown")
	}
	drive(m, tea.WindowSizeMsg{Width: 30, Height: 5})
	if !strings.Contains(m.View(), "too small") {
		t.Error("small terminal")
	}
}

func lipglossWidth(s string) int { return lipgloss.Width(s) }
