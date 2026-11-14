package cmd

// `blift browse`: a full-screen file browser in the manner of yazi and ranger. Two sides, the
// server and this machine, each shown as three columns (the directory above, the current one,
// and what the entry under the cursor holds). Yank on one side and paste on the other to upload
// or download; cut and paste on the server moves, which is one request whatever is moved.
//
// The model only keeps state; everything slow (listings, transfers) runs in commands and comes
// back as messages, so the interface never waits on the network.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/spf13/cobra"

	"github.com/davidliyutong/blift/cli/internal/api"
	"github.com/davidliyutong/blift/cli/internal/i18n"
	"github.com/davidliyutong/blift/cli/internal/transfer"
	"github.com/davidliyutong/blift/cli/internal/ui"
)

func browseCmd() *cobra.Command {
	return &cobra.Command{
		Use:               "browse [project[:path]]",
		Aliases:           []string{"tui"},
		Short:             i18n.T("cmd.browse"),
		Long:              i18n.T("cmd.browse.long"),
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: completeArgs(completeRef, completeNothing),
		RunE: func(cmd *cobra.Command, args []string) error {
			if !ui.IsTTY(os.Stdout) || !ui.IsTTY(os.Stdin) {
				return errors.New(i18n.T("browse.no_tty"))
			}
			rm, err := newRemote()
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			var start []string
			if len(args) == 1 {
				at := parseRef(args[0])
				p, _, err := rm.dir(ctx, at)
				if err != nil {
					return err
				}
				start = append([]string{projectLabel(p)}, strings.FieldsFunc(at.path, func(r rune) bool { return r == '/' })...)
			}
			cwd, err := os.Getwd()
			if err != nil {
				return err
			}
			m := newBrowser(ctx, &remoteSide{rm: rm, projects: map[string]*api.Project{}, dirs: map[string]string{}}, start, cwd)
			_, err = tea.NewProgram(m, tea.WithAltScreen(), tea.WithContext(ctx)).Run()
			if errors.Is(err, tea.ErrProgramKilled) {
				return nil
			}
			return err
		},
	}
}

// ---- The two sides

type entry struct {
	name  string
	dir   bool
	size  int64
	mtime int64 // unix ms
	id    string
	note  string // owner of a project, uploader of a file
}

// side is a tree the browser can show: the server (projects, then their folders) or the local
// file system. Paths are lists of names from its root.
type side interface {
	label() string
	list(ctx context.Context, path []string) ([]entry, error)
	mkdir(ctx context.Context, path []string, name string) error
	rename(ctx context.Context, path []string, e entry, name string) error
	remove(ctx context.Context, path []string, entries []entry) error
	show(path []string) string
}

func projectLabel(p *api.Project) string { return p.Owner.Username + "/" + p.Name }

// remoteSide: the root lists projects (as owner/name, which is unique), below are folders.
type remoteSide struct {
	rm       *remote
	mu       sync.Mutex
	projects map[string]*api.Project // by label
	dirs     map[string]string       // "label/a/b" → directory id
}

func (s *remoteSide) label() string { return i18n.T("browse.remote") }

func (s *remoteSide) show(path []string) string {
	if len(path) == 0 {
		return s.rm.c.Server
	}
	return path[0] + ":" + strings.Join(path[1:], "/")
}

// where resolves a path to its project and directory id ("" = the project's root).
func (s *remoteSide) where(ctx context.Context, path []string) (*api.Project, string, error) {
	if len(path) == 0 {
		return nil, "", errors.New(i18n.T("browse.pick_project"))
	}
	s.mu.Lock()
	p := s.projects[path[0]]
	id, known := s.dirs[strings.Join(path, "/")]
	s.mu.Unlock()
	if p == nil {
		var err error
		if p, err = resolveProject(ctx, s.rm.c, path[0]); err != nil {
			return nil, "", err
		}
		s.mu.Lock()
		s.projects[path[0]] = p
		s.mu.Unlock()
	}
	if len(path) == 1 || known {
		return p, id, nil
	}
	b, err := s.rm.c.Stat(ctx, p.ID, strings.Join(path[1:], "/"))
	if err != nil {
		return nil, "", err
	}
	s.remember(path, b.ID)
	return p, b.ID, nil
}

func (s *remoteSide) remember(path []string, id string) {
	s.mu.Lock()
	s.dirs[strings.Join(path, "/")] = id
	s.mu.Unlock()
}

func (s *remoteSide) list(ctx context.Context, path []string) ([]entry, error) {
	if len(path) == 0 {
		projects, err := s.rm.c.Projects(ctx)
		if err != nil {
			return nil, err
		}
		out := make([]entry, 0, len(projects))
		s.mu.Lock()
		for i := range projects {
			p := &projects[i]
			s.projects[projectLabel(p)] = p
			out = append(out, entry{name: projectLabel(p), dir: true, size: p.UsedBytes, mtime: p.UpdatedAt, id: p.ID, note: p.Role})
		}
		s.mu.Unlock()
		sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].name) < strings.ToLower(out[j].name) })
		return out, nil
	}
	p, dirID, err := s.where(ctx, path)
	if err != nil {
		return nil, err
	}
	blobs, err := listDir(ctx, s.rm.c, p.ID, dirID, 0)
	if err != nil {
		return nil, err
	}
	out := make([]entry, 0, len(blobs))
	for _, b := range blobs {
		if b.Kind == "dir" {
			s.remember(append(append([]string{}, path...), b.Name), b.ID)
		}
		out = append(out, entry{name: b.Name, dir: b.Kind == "dir", size: b.Size, mtime: b.CreatedAt, id: b.ID, note: uploaderOf(b)})
	}
	return out, nil
}

func (s *remoteSide) mkdir(ctx context.Context, path []string, name string) error {
	p, dirID, err := s.where(ctx, path)
	if err != nil {
		return err
	}
	_, err = s.rm.c.Mkdir(ctx, p.ID, dirID, name, false)
	return err
}

func (s *remoteSide) rename(ctx context.Context, path []string, e entry, name string) error {
	if len(path) == 0 {
		return errors.New(i18n.T("browse.not_here"))
	}
	_, err := s.rm.c.RenameBlob(ctx, e.id, name)
	return err
}

func (s *remoteSide) remove(ctx context.Context, path []string, entries []entry) error {
	p, _, err := s.where(ctx, path)
	if err != nil {
		return err
	}
	ids := make([]string, len(entries))
	for i, e := range entries {
		ids[i] = e.id
	}
	_, err = s.rm.c.DeleteBlobs(ctx, p.ID, ids)
	return err
}

// localSide: paths are the parts of an absolute path.
type localSide struct{}

func (localSide) label() string { return i18n.T("browse.local") }

func localPath(path []string) string {
	return string(filepath.Separator) + filepath.Join(path...)
}

func (localSide) show(path []string) string { return localPath(path) }

func (localSide) list(_ context.Context, path []string) ([]entry, error) {
	items, err := os.ReadDir(localPath(path))
	if err != nil {
		return nil, err
	}
	out := make([]entry, 0, len(items))
	for _, it := range items {
		fi, err := os.Stat(filepath.Join(localPath(path), it.Name())) // follows symlinks
		if err != nil {
			continue
		}
		out = append(out, entry{name: it.Name(), dir: fi.IsDir(), size: fi.Size(), mtime: fi.ModTime().UnixMilli()})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].dir != out[j].dir {
			return out[i].dir
		}
		return strings.ToLower(out[i].name) < strings.ToLower(out[j].name)
	})
	return out, nil
}

func (localSide) mkdir(_ context.Context, path []string, name string) error {
	return os.Mkdir(filepath.Join(localPath(path), name), 0o755)
}

func (localSide) rename(_ context.Context, path []string, e entry, name string) error {
	if strings.ContainsAny(name, `/\`) {
		return errors.New(i18n.T("download.bad_name", name))
	}
	return os.Rename(filepath.Join(localPath(path), e.name), filepath.Join(localPath(path), name))
}

// remove is not offered on this machine: a file browser that deletes local files with one key
// and no trash is a hazard, and the shell is right there.
func (localSide) remove(context.Context, []string, []entry) error {
	return errors.New(i18n.T("browse.no_local_rm"))
}

// ---- Model

type pane struct {
	fs       side
	path     []string
	cursor   int
	selected map[string]bool
	// cursors remembers where the cursor was in directories that were left.
	cursors map[string]int
}

func (p *pane) key(path []string) string { return p.fs.label() + "\x00" + strings.Join(path, "\x00") }

type listing struct {
	entries []entry
	err     error
	loading bool
}

type clipboard struct {
	pane    int
	path    []string
	entries []entry
	cut     bool
}

// job is a running transfer; its counters are read by the view while it runs.
type job struct {
	title        string
	total, done  atomic.Int64
	files, ready atomic.Int64
	failed       atomic.Int64
	lastErr      atomic.Value // string
	finished     atomic.Bool
	cancel       context.CancelFunc
	pane         int // the side to refresh when it ends
}

func (j *job) Add(n int64) { j.done.Add(n) }

type browser struct {
	ctx           context.Context
	panes         [2]*pane
	active        int
	lists         map[string]*listing
	clip          *clipboard
	jobs          []*job
	width, height int
	status        string
	isErr         bool
	help          bool
	// prompt: a one-line input (new folder, rename) or a yes/no question (delete).
	prompt  string
	input   []rune
	onInput func(string) tea.Cmd
	confirm func() tea.Cmd
}

type listMsg struct {
	key     string
	entries []entry
	err     error
}
type doneMsg struct {
	status string
	err    error
	reload []int
}
type tickMsg struct{}

func newBrowser(ctx context.Context, rs *remoteSide, remotePath []string, cwd string) *browser {
	local := strings.FieldsFunc(filepath.ToSlash(cwd), func(r rune) bool { return r == '/' })
	mk := func(fs side, path []string) *pane {
		return &pane{fs: fs, path: path, selected: map[string]bool{}, cursors: map[string]int{}}
	}
	return &browser{ctx: ctx, panes: [2]*pane{mk(rs, remotePath), mk(localSide{}, local)}, lists: map[string]*listing{}}
}

func (m *browser) cur() *pane { return m.panes[m.active] }

func (m *browser) listingOf(p *pane, path []string) *listing {
	if l, ok := m.lists[p.key(path)]; ok {
		return l
	}
	return nil
}

func (m *browser) entries() []entry {
	if l := m.listingOf(m.cur(), m.cur().path); l != nil {
		return l.entries
	}
	return nil
}

func (m *browser) under() (entry, bool) {
	es := m.entries()
	if p := m.cur(); p.cursor >= 0 && p.cursor < len(es) {
		return es[p.cursor], true
	}
	return entry{}, false
}

// load fetches a directory unless it is there already (force: again).
func (m *browser) load(pi int, path []string, force bool) tea.Cmd {
	p := m.panes[pi]
	key := p.key(path)
	if l, ok := m.lists[key]; ok && (l.loading || !force) {
		return nil
	}
	old := m.lists[key]
	l := &listing{loading: true}
	if old != nil {
		l.entries = old.entries // keep showing what was there while it reloads
	}
	m.lists[key] = l
	path = append([]string{}, path...)
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 30*time.Second)
		defer cancel()
		es, err := p.fs.list(ctx, path)
		return listMsg{key: key, entries: es, err: err}
	}
}

// around loads what the three columns of a pane show: the directory, the one above it, and the
// directory under the cursor.
func (m *browser) around(pi int, force bool) tea.Cmd {
	p := m.panes[pi]
	cmds := []tea.Cmd{m.load(pi, p.path, force)}
	if len(p.path) > 0 {
		cmds = append(cmds, m.load(pi, p.path[:len(p.path)-1], false))
	}
	if pi == m.active {
		if e, ok := m.under(); ok && e.dir {
			cmds = append(cmds, m.load(pi, append(append([]string{}, p.path...), e.name), false))
		}
	}
	return tea.Batch(cmds...)
}

func (m *browser) Init() tea.Cmd {
	return tea.Batch(m.around(0, false), m.around(1, false))
}

func (m *browser) say(format string, err error) {
	m.status, m.isErr = format, err != nil
	if err != nil {
		m.status = errMessage(err)
	}
}

func tick() tea.Cmd {
	return tea.Tick(150*time.Millisecond, func(time.Time) tea.Msg { return tickMsg{} })
}

func (m *browser) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil
	case listMsg:
		m.lists[msg.key] = &listing{entries: msg.entries, err: msg.err}
		for pi, p := range m.panes {
			if p.key(p.path) == msg.key {
				p.cursor = max(0, min(p.cursor, len(msg.entries)-1))
				if pi == m.active {
					return m, m.around(pi, false) // the entry under the cursor may be a directory
				}
			}
		}
		return m, nil
	case doneMsg:
		m.say(msg.status, msg.err)
		var cmds []tea.Cmd
		for _, pi := range msg.reload {
			m.panes[pi].selected = map[string]bool{}
			cmds = append(cmds, m.around(pi, true))
		}
		return m, tea.Batch(cmds...)
	case tickMsg:
		var cmds []tea.Cmd
		running := false
		keep := m.jobs[:0]
		for _, j := range m.jobs {
			if !j.finished.Load() {
				running = true
				keep = append(keep, j)
				continue
			}
			err, _ := j.lastErr.Load().(string)
			if n := j.failed.Load(); n > 0 {
				m.status, m.isErr = i18n.T("browse.job_failed", j.title, n, err), true
			} else {
				m.status, m.isErr = i18n.T("browse.job_done", j.title, j.ready.Load(), ui.Size(j.done.Load())), false
			}
			cmds = append(cmds, m.around(j.pane, true))
		}
		m.jobs = keep
		if running {
			cmds = append(cmds, tick())
		}
		return m, tea.Batch(cmds...)
	case tea.KeyMsg:
		return m.key(msg)
	}
	return m, nil
}

func (m *browser) key(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.onInput != nil {
		switch k.Type {
		case tea.KeyEsc, tea.KeyCtrlC:
			m.onInput, m.prompt = nil, ""
		case tea.KeyEnter:
			fn, text := m.onInput, strings.TrimSpace(string(m.input))
			m.onInput, m.prompt = nil, ""
			if text != "" {
				return m, fn(text)
			}
		case tea.KeyBackspace:
			if len(m.input) > 0 {
				m.input = m.input[:len(m.input)-1]
			}
		case tea.KeySpace:
			m.input = append(m.input, ' ')
		case tea.KeyRunes:
			m.input = append(m.input, k.Runes...)
		}
		return m, nil
	}
	if m.confirm != nil {
		fn := m.confirm
		m.confirm, m.prompt = nil, ""
		if s := k.String(); s == "y" || s == "Y" {
			return m, fn()
		}
		return m, nil
	}
	p := m.cur()
	es := m.entries()
	move := func(to int) (tea.Model, tea.Cmd) {
		p.cursor = max(0, min(to, len(es)-1))
		return m, m.around(m.active, false)
	}
	page := max(1, m.height-6)
	switch k.String() {
	case "q", "ctrl+c":
		for _, j := range m.jobs {
			j.cancel()
		}
		return m, tea.Quit
	case "?":
		m.help = !m.help
	case "esc":
		m.help, m.status = false, ""
		p.selected = map[string]bool{}
		m.clip = nil
	case "j", "down":
		return move(p.cursor + 1)
	case "k", "up":
		return move(p.cursor - 1)
	case "g", "home":
		return move(0)
	case "G", "end":
		return move(len(es) - 1)
	case "ctrl+d", "pgdown":
		return move(p.cursor + page)
	case "ctrl+u", "pgup":
		return move(p.cursor - page)
	case "h", "left", "backspace":
		if len(p.path) > 0 {
			left := p.path[len(p.path)-1]
			p.cursors[p.key(p.path)] = p.cursor
			p.path = p.path[:len(p.path)-1]
			p.selected = map[string]bool{}
			p.cursor = 0
			if l := m.listingOf(p, p.path); l != nil { // back on the directory that was left
				for i, e := range l.entries {
					if e.name == left {
						p.cursor = i
					}
				}
			}
			return m, m.around(m.active, false)
		}
	case "l", "right", "enter":
		if e, ok := m.under(); ok && e.dir {
			p.cursors[p.key(p.path)] = p.cursor
			p.path = append(append([]string{}, p.path...), e.name)
			p.selected = map[string]bool{}
			p.cursor = p.cursors[p.key(p.path)]
			return m, m.around(m.active, false)
		}
	case "tab", "1", "2":
		switch k.String() {
		case "1":
			m.active = 0
		case "2":
			m.active = 1
		default:
			m.active = 1 - m.active
		}
		return m, m.around(m.active, false)
	case " ":
		if e, ok := m.under(); ok {
			if p.selected[e.name] {
				delete(p.selected, e.name)
			} else {
				p.selected[e.name] = true
			}
			return move(p.cursor + 1)
		}
	case "a":
		for _, e := range es {
			p.selected[e.name] = true
		}
	case "R":
		m.lists = map[string]*listing{}
		return m, tea.Batch(m.around(0, true), m.around(1, true))
	case "y", "x":
		if picked := m.picked(); len(picked) > 0 {
			m.clip = &clipboard{pane: m.active, path: append([]string{}, p.path...), entries: picked, cut: k.String() == "x"}
			m.say(i18n.T(map[bool]string{false: "browse.yanked", true: "browse.cut"}[m.clip.cut], len(picked)), nil)
		}
	case "p", "P":
		return m, m.paste(k.String() == "P")
	case "n":
		pi, path := m.active, append([]string{}, p.path...)
		m.ask(i18n.T("browse.new_folder"), "", func(name string) tea.Cmd {
			return m.run(pi, "", func(ctx context.Context) error { return m.panes[pi].fs.mkdir(ctx, path, name) })
		})
	case "r":
		if e, ok := m.under(); ok {
			pi, path := m.active, append([]string{}, p.path...)
			m.ask(i18n.T("browse.rename"), e.name, func(name string) tea.Cmd {
				return m.run(pi, "", func(ctx context.Context) error { return m.panes[pi].fs.rename(ctx, path, e, name) })
			})
		}
	case "d":
		if picked := m.picked(); len(picked) > 0 {
			pi, path := m.active, append([]string{}, p.path...)
			if _, local := p.fs.(localSide); local || len(path) == 0 {
				m.say("", errors.New(i18n.T(map[bool]string{true: "browse.no_local_rm", false: "browse.not_here"}[local])))
				break
			}
			m.prompt = i18n.T("browse.confirm_rm", len(picked), p.fs.show(path))
			m.confirm = func() tea.Cmd {
				return m.run(pi, i18n.T("browse.deleted", len(picked)), func(ctx context.Context) error {
					return m.panes[pi].fs.remove(ctx, path, picked)
				})
			}
		}
	}
	return m, nil
}

// picked is what a command applies to: the selection, or the entry under the cursor.
func (m *browser) picked() []entry {
	p := m.cur()
	var out []entry
	for _, e := range m.entries() {
		if p.selected[e.name] {
			out = append(out, e)
		}
	}
	if len(out) == 0 {
		if e, ok := m.under(); ok {
			out = []entry{e}
		}
	}
	return out
}

func (m *browser) ask(prompt, initial string, fn func(string) tea.Cmd) {
	m.prompt, m.input, m.onInput = prompt, []rune(initial), fn
}

// run does something quick on a side (mkdir, rename, delete, move), then reloads it.
func (m *browser) run(pi int, ok string, fn func(ctx context.Context) error, also ...int) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 60*time.Second)
		defer cancel()
		return doneMsg{status: ok, err: fn(ctx), reload: append([]int{pi}, also...)}
	}
}

// paste puts the clipboard into the current directory: across the sides it is a transfer, on
// the server a move (cut) and on this machine a rename (cut). Copies inside one side are what
// cp and the web UI are for.
func (m *browser) paste(overwrite bool) tea.Cmd {
	c := m.clip
	if c == nil {
		return nil
	}
	dst, to := m.cur(), append([]string{}, m.cur().path...)
	src := m.panes[c.pane]
	rs, _ := m.panes[0].fs.(*remoteSide)
	switch {
	case c.pane != m.active && m.active == 0: // local → server
		if len(to) == 0 {
			m.say("", errors.New(i18n.T("browse.pick_project")))
			return nil
		}
		return m.transfer(i18n.T("browse.uploading", len(c.entries), dst.fs.show(to)), 0, func(ctx context.Context, j *job) {
			uploadJob(ctx, rs, j, localPath(c.path), c.entries, to, overwrite)
		})
	case c.pane != m.active: // server → local
		if len(c.path) == 0 {
			m.say("", errors.New(i18n.T("browse.pick_project")))
			return nil
		}
		return m.transfer(i18n.T("browse.downloading", len(c.entries), dst.fs.show(to)), 1, func(ctx context.Context, j *job) {
			downloadJob(ctx, rs, j, c.path, c.entries, localPath(to))
		})
	case !c.cut:
		m.say("", errors.New(i18n.T("browse.copy_same_side")))
		return nil
	case m.active == 0: // move on the server
		if len(to) == 0 || len(c.path) == 0 || to[0] != c.path[0] {
			m.say("", errors.New(i18n.T("path.same_project")))
			return nil
		}
		m.clip = nil
		return m.run(0, i18n.T("browse.moved", len(c.entries)), func(ctx context.Context) error {
			_, dirID, err := rs.where(ctx, to)
			if err != nil {
				return err
			}
			for _, e := range c.entries {
				if _, err := rs.rm.c.MoveBlob(ctx, e.id, "", &dirID); err != nil {
					return fmt.Errorf("%s: %s", e.name, errMessage(err))
				}
			}
			return nil
		})
	default: // move on this machine
		m.clip = nil
		return m.run(1, i18n.T("browse.moved", len(c.entries)), func(context.Context) error {
			for _, e := range c.entries {
				if err := os.Rename(filepath.Join(localPath(src.path), e.name), filepath.Join(localPath(to), e.name)); err != nil {
					return err
				}
			}
			return nil
		})
	}
}

func (m *browser) transfer(title string, refresh int, work func(ctx context.Context, j *job)) tea.Cmd {
	ctx, cancel := context.WithCancel(m.ctx)
	j := &job{title: title, cancel: cancel, pane: refresh}
	first := len(m.jobs) == 0
	m.jobs = append(m.jobs, j)
	m.status = ""
	go func() {
		defer cancel()
		work(ctx, j)
		j.finished.Store(true)
	}()
	if first {
		return tick()
	}
	return nil
}

func (j *job) fail(err error) {
	j.failed.Add(1)
	j.lastErr.Store(errMessage(err))
}

// each runs fn over n items, 4 at a time.
func each(ctx context.Context, n int, fn func(i int)) {
	var wg sync.WaitGroup
	ch := make(chan int)
	for range min(4, n) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range ch {
				if ctx.Err() == nil {
					fn(i)
				}
			}
		}()
	}
	for i := range n {
		ch <- i
	}
	close(ch)
	wg.Wait()
}

// uploadJob sends local entries (directories with everything in them) into a folder of a project.
func uploadJob(ctx context.Context, rs *remoteSide, j *job, from string, entries []entry, to []string, overwrite bool) {
	p, baseID, err := rs.where(ctx, to)
	if err != nil {
		j.fail(err)
		return
	}
	var files []upFile
	var dirs []string
	for _, e := range entries {
		fl, dl, _, err := localTree(filepath.Join(from, e.name), true)
		if err != nil {
			j.fail(err)
			continue
		}
		files, dirs = append(files, fl...), append(dirs, dl...)
	}
	for _, f := range files {
		j.total.Add(f.size)
	}
	j.files.Store(int64(len(files)))
	ids := map[string]string{"": baseID}
	sort.Strings(dirs)
	for _, d := range dirs {
		if _, ok := ids[d]; ok {
			continue
		}
		made, err := rs.rm.c.Mkdir(ctx, p.ID, baseID, d, true)
		if err != nil {
			j.fail(err)
			return
		}
		ids[d] = made.ID
	}
	each(ctx, len(files), func(i int) {
		f := files[i]
		_, err := transfer.Upload(ctx, rs.rm.c, p.ID, f.local, transfer.UploadOptions{Name: f.name, ParentID: ids[f.dir], Overwrite: overwrite, Jobs: 4, Progress: j})
		if err != nil {
			if ctx.Err() == nil {
				j.fail(fmt.Errorf("%s: %s", f.name, errMessage(err)))
			}
			return
		}
		j.ready.Add(1)
	})
}

// downloadJob fetches entries of a project folder (folders with everything in them) into a local directory.
func downloadJob(ctx context.Context, rs *remoteSide, j *job, from []string, entries []entry, to string) {
	p, _, err := rs.where(ctx, from)
	if err != nil {
		j.fail(err)
		return
	}
	type item struct {
		id, rel string
		size    int64
	}
	var items []item
	for _, e := range entries {
		if !e.dir {
			items = append(items, item{e.id, e.name, e.size})
			continue
		}
		if _, err := destPath(to, e.name+"/_", true); err != nil { // the folder itself, even if empty
			j.fail(err)
			continue
		}
		err := walkRemote(ctx, rs.rm.c, p.ID, e.id, e.name+"/", 0, func(rel string, b api.Blob) error {
			if b.Kind == "dir" {
				_, err := destPath(to, rel+"/_", true)
				return err
			}
			items = append(items, item{b.ID, rel, b.Size})
			return nil
		})
		if err != nil {
			j.fail(err)
		}
	}
	for _, it := range items {
		j.total.Add(it.size)
	}
	j.files.Store(int64(len(items)))
	each(ctx, len(items), func(i int) {
		it := items[i]
		err := func() error {
			dest, err := destPath(to, it.rel, true)
			if err != nil {
				return err
			}
			u, err := rs.rm.c.BlobURL(ctx, it.id)
			if err != nil {
				return err
			}
			return transfer.Download(ctx, u.URL, it.size, dest, 4, j)
		}()
		if err != nil {
			if ctx.Err() == nil {
				j.fail(fmt.Errorf("%s: %s", it.rel, errMessage(err)))
			}
			return
		}
		j.ready.Add(1)
	})
}

// ---- View

var (
	styleDim    = lipgloss.NewStyle().Faint(true)
	styleDir    = lipgloss.NewStyle().Foreground(lipgloss.Color("12")).Bold(true)
	styleCursor = lipgloss.NewStyle().Reverse(true)
	styleMark   = lipgloss.NewStyle().Foreground(lipgloss.Color("11"))
	styleErr    = lipgloss.NewStyle().Foreground(lipgloss.Color("9"))
	styleOK     = lipgloss.NewStyle().Foreground(lipgloss.Color("10"))
	styleTab    = lipgloss.NewStyle().Bold(true).Reverse(true).Padding(0, 1)
	styleTabOff = lipgloss.NewStyle().Faint(true).Padding(0, 1)
)

// fit cuts or pads s to exactly w cells (names can be wide: CJK counts two).
func fit(s string, w int) string {
	if w <= 0 {
		return ""
	}
	if ui.Width(s) > w {
		r := []rune(s)
		for len(r) > 0 && ui.Width(string(r)) > w-1 {
			r = r[:len(r)-1]
		}
		s = string(r) + "…"
	}
	return s + strings.Repeat(" ", max(0, w-ui.Width(s)))
}

// column renders a listing h lines tall and w cells wide, scrolled so the cursor shows.
func (m *browser) column(l *listing, w, h, cursor int, selected map[string]bool, sizes bool) []string {
	lines := make([]string, 0, h)
	blank := strings.Repeat(" ", max(0, w))
	switch {
	case l == nil || (l.loading && l.entries == nil):
		lines = append(lines, styleDim.Render(fit(i18n.T("browse.loading"), w)))
	case l.err != nil:
		lines = append(lines, styleErr.Render(fit(errMessage(l.err), w)))
	case len(l.entries) == 0:
		lines = append(lines, styleDim.Render(fit(i18n.T("browse.empty"), w)))
	default:
		top := 0
		if cursor >= h {
			top = cursor - h + 1
		}
		for i := top; i < len(l.entries) && len(lines) < h; i++ {
			e := l.entries[i]
			name, right := e.name, ""
			if e.dir {
				name += "/"
			} else if sizes {
				right = ui.Size(e.size)
			}
			mark := " "
			if selected[e.name] {
				mark = "+"
			}
			text := mark + fit(name, w-2-len(right)) + right + " "
			switch {
			case i == cursor:
				text = styleCursor.Render(text)
			case selected[e.name]:
				text = styleMark.Render(text)
			case e.dir:
				text = styleDir.Render(text)
			}
			lines = append(lines, text)
		}
	}
	for len(lines) < h {
		lines = append(lines, blank)
	}
	return lines
}

func (m *browser) View() string {
	if m.width < 40 || m.height < 8 {
		return i18n.T("browse.too_small")
	}
	p := m.cur()
	var b strings.Builder

	// Tabs and where we are.
	for i, pn := range m.panes {
		st := styleTabOff
		if i == m.active {
			st = styleTab
		}
		b.WriteString(st.Render(fmt.Sprintf("%d %s", i+1, pn.fs.label())))
	}
	b.WriteString("  " + fit(p.fs.show(p.path), max(0, m.width-28)) + "\n")

	bottom := 2 + len(m.jobs)
	h := m.height - 1 - bottom
	if m.help {
		lines := strings.Split(i18n.T("browse.help"), "\n")
		for i := 0; i < h; i++ {
			if i < len(lines) {
				b.WriteString(fit(lines[i], m.width))
			}
			b.WriteString("\n")
		}
	} else {
		wl := m.width / 5
		wr := m.width * 3 / 10
		wm := m.width - wl - wr - 2
		var parent *listing
		pc := -1
		if len(p.path) > 0 {
			parent = m.listingOf(p, p.path[:len(p.path)-1])
			if parent != nil {
				for i, e := range parent.entries {
					if e.name == p.path[len(p.path)-1] {
						pc = i
					}
				}
			}
		} else {
			parent = &listing{}
		}
		left := m.column(parent, wl, h, pc, nil, false)
		mid := m.column(m.listingOf(p, p.path), wm, h, p.cursor, p.selected, true)
		var right []string
		if e, ok := m.under(); ok && e.dir {
			right = m.column(m.listingOf(p, append(append([]string{}, p.path...), e.name)), wr, h, -1, nil, true)
		} else if ok {
			info := []string{e.name, ui.Size(e.size), ui.Time(e.mtime), e.note}
			for i := range info {
				info[i] = styleDim.Render(fit(info[i], wr))
			}
			right = info
			for len(right) < h {
				right = append(right, strings.Repeat(" ", wr))
			}
		} else {
			right = m.column(&listing{}, wr, h, -1, nil, false)[:0]
			for len(right) < h {
				right = append(right, strings.Repeat(" ", wr))
			}
		}
		sep := styleDim.Render("│")
		for i := 0; i < h; i++ {
			b.WriteString(left[i] + sep + mid[i] + sep + right[i] + "\n")
		}
	}

	// Transfers, then one line of status or input, then the keys.
	for _, j := range m.jobs {
		total, done := j.total.Load(), j.done.Load()
		pct := 0.0
		if total > 0 {
			pct = float64(done) * 100 / float64(total)
		}
		barW := max(10, min(30, m.width/4))
		fill := int(float64(barW) * min(pct, 100) / 100)
		line := fmt.Sprintf("%s [%s%s] %3.0f%%  %d/%d  %s / %s", fit(j.title, max(10, m.width-barW-44)),
			strings.Repeat("=", fill), strings.Repeat(" ", barW-fill), pct, j.ready.Load(), j.files.Load(), ui.Size(done), ui.Size(total))
		b.WriteString(fit(line, m.width) + "\n")
	}
	switch {
	case m.onInput != nil:
		b.WriteString(fit(m.prompt+": "+string(m.input)+"█", m.width))
	case m.confirm != nil:
		b.WriteString(styleErr.Render(fit(m.prompt+" [y/N]", m.width)))
	case m.status != "" && m.isErr:
		b.WriteString(styleErr.Render(fit(m.status, m.width)))
	case m.status != "":
		b.WriteString(styleOK.Render(fit(m.status, m.width)))
	default:
		sel, clip := len(p.selected), ""
		if m.clip != nil {
			clip = "  " + i18n.T(map[bool]string{false: "browse.yanked", true: "browse.cut"}[m.clip.cut], len(m.clip.entries))
		}
		b.WriteString(styleDim.Render(fit(i18n.T("browse.count", len(m.entries()), sel)+clip, m.width)))
	}
	b.WriteString("\n" + styleDim.Render(fit(i18n.T("browse.keys"), m.width)))
	return b.String()
}
