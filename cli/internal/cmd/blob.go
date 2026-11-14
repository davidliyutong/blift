package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/spf13/cobra"

	"github.com/davidliyutong/blift/cli/internal/api"
	"github.com/davidliyutong/blift/cli/internal/i18n"
	"github.com/davidliyutong/blift/cli/internal/transfer"
	"github.com/davidliyutong/blift/cli/internal/ui"
)

// lsDefaultLimit keeps `blift ls` on a directory with many entries short; --limit / --all widen it.
const lsDefaultLimit = 100

func uploaderOf(b api.Blob) string {
	if b.Uploader != nil {
		return b.Uploader.Username
	}
	if b.ViaInbox {
		return i18n.T("inbox.uploader")
	}
	return "-"
}

func lsCmd() *cobra.Command {
	var sortBy, query string
	var limit int
	var all, recursive bool
	c := &cobra.Command{
		Use:               "ls [project[:path]]",
		Aliases:           []string{"list"},
		Short:             i18n.T("cmd.ls"),
		Long:              i18n.T("cmd.ls.long"),
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: completeArgs(completeRef, completeNothing),
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) == 0 {
				return listProjects(cmd.Context())
			}
			sorts := map[string][2]string{"name": {"name", "asc"}, "size": {"size", "desc"}, "time": {"created_at", "desc"}}
			s, ok := sorts[sortBy]
			if !ok {
				return errors.New(i18n.T("bad_sort", sortBy))
			}
			if limit < 1 {
				return errors.New(i18n.T("bad_limit"))
			}
			if all {
				limit = 0
			}
			ctx := cmd.Context()
			rm, err := newRemote()
			if err != nil {
				return err
			}
			at := parseRef(args[0])
			p, b, err := rm.stat(ctx, at)
			if err != nil {
				return err
			}
			// Three listings: all files of the project (a search, or -r on the root), everything
			// below a directory (-r), or one directory.
			var blobs []api.Blob
			total, paths := -1, false
			switch {
			case query != "" || (recursive && b == nil):
				if b != nil {
					return errors.New(i18n.T("ls.query_path"))
				}
				blobs, total, err = rm.c.ListBlobs(ctx, p.ID, api.BlobQuery{Q: query, Sort: s[0], Order: s[1]}, limit)
				paths = true
			case b != nil && b.Kind != "dir":
				blobs = []api.Blob{*b}
			case recursive:
				paths = true
				err = walkRemote(ctx, rm.c, p.ID, b.ID, "", 0, func(rel string, e api.Blob) error {
					if e.Kind != "dir" {
						e.Path = rel
						blobs = append(blobs, e)
					}
					return nil
				})
				if limit > 0 && len(blobs) > limit {
					total, blobs = len(blobs), blobs[:limit]
				}
			default:
				q := api.BlobQuery{Dir: true, Sort: s[0], Order: s[1]}
				if b != nil {
					q.ParentID = b.ID
				}
				more := 0
				if limit > 0 {
					more = limit + 1
				}
				blobs, _, err = rm.c.ListBlobs(ctx, p.ID, q, more)
				if limit > 0 && len(blobs) > limit {
					total, blobs = 0, blobs[:limit] // 0: more, but nobody counted them
				}
			}
			if err != nil {
				return err
			}
			hint := func() {
				switch {
				case total > len(blobs):
					info("ls.more", len(blobs), total)
				case total == 0:
					info("ls.more_dir", len(blobs))
				}
			}
			if jsonOut {
				hint()
				return printJSON(blobs)
			}
			var size int64
			dirs := 0
			rows := make([][]string, 0, len(blobs))
			for _, e := range blobs {
				name, sz := e.Name, ui.Size(e.Size)
				if paths {
					name = e.Path
				}
				if e.Kind == "dir" {
					name, sz = name+"/", "-"
					dirs++
				}
				rows = append(rows, []string{name, sz, ui.Time(e.CreatedAt), uploaderOf(e), e.ID})
				size += e.Size
			}
			table([]string{"col.name", "col.size", "col.created", "col.uploader", "col.id"}, rows)
			if total >= 0 && (total > len(blobs) || total == 0) {
				hint()
			} else if dirs > 0 {
				info("ls.summary_dir", dirs, len(blobs)-dirs, ui.Size(size))
			} else {
				info("ls.summary", len(blobs), ui.Size(size))
			}
			return nil
		},
	}
	c.Flags().StringVar(&sortBy, "sort", "name", i18n.T("flag.sort"))
	c.Flags().StringVar(&query, "query", "", i18n.T("flag.query"))
	c.Flags().IntVarP(&limit, "limit", "n", lsDefaultLimit, i18n.T("flag.limit"))
	c.Flags().BoolVarP(&all, "all", "a", false, i18n.T("flag.ls_all"))
	c.Flags().BoolVarP(&recursive, "recursive", "r", false, i18n.T("flag.ls_recursive"))
	_ = c.RegisterFlagCompletionFunc("sort", fixed("name", "size", "time"))
	return c
}

// ---- transfers

// transferFlags are shared by cp, upload and download.
type transferFlags struct {
	recursive bool
	overwrite bool
	jobs      int // parallel parts or ranges of one file
	parallel  int // files at a time
}

func (f *transferFlags) add(c *cobra.Command, upload bool) {
	c.Flags().BoolVarP(&f.recursive, "recursive", "r", false, i18n.T("flag.recursive"))
	if upload {
		c.Flags().BoolVar(&f.overwrite, "overwrite", false, i18n.T("flag.overwrite"))
	}
	c.Flags().IntVarP(&f.jobs, "jobs", "j", 4, i18n.T("flag.jobs"))
	c.Flags().IntVarP(&f.parallel, "parallel", "P", 4, i18n.T("flag.parallel"))
}

// task is one file to transfer; run reports where it ended up.
type task struct {
	label string
	size  int64
	run   func(ctx context.Context, prog transfer.Progress) error
	// done is called after a successful run, one task at a time.
	done func()
}

// runTasks transfers files, `parallel` at a time. A single file (or -P 1) shows a bar per file;
// several at once share one bar for all their bytes. It carries on past failed files and
// returns how many failed.
func runTasks(ctx context.Context, tasks []task, parallel int) (failed int, err error) {
	parallel = max(1, min(parallel, len(tasks)))
	var total int64
	for _, t := range tasks {
		total += t.size
	}
	var shared *ui.Bar
	if parallel > 1 {
		shared = ui.NewBar(i18n.T("transfer.files", len(tasks)), total, progressEnabled())
	}
	var mu sync.Mutex
	var problems []string
	ch := make(chan task)
	var wg sync.WaitGroup
	for range parallel {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for t := range ch {
				if ctx.Err() != nil {
					continue
				}
				var bar *ui.Bar
				var prog transfer.Progress = shared
				if parallel == 1 {
					bar = ui.NewBar(t.label, t.size, progressEnabled())
					prog = bar
				}
				err := t.run(ctx, prog)
				bar.Finish()
				mu.Lock()
				if err != nil && ctx.Err() == nil {
					problems = append(problems, i18n.T("error")+t.label+": "+errMessage(err))
				} else if err == nil && t.done != nil {
					t.done()
				}
				mu.Unlock()
			}
		}()
	}
	for _, t := range tasks {
		ch <- t
	}
	close(ch)
	wg.Wait()
	shared.Finish()
	for _, p := range problems {
		fmt.Fprintln(os.Stderr, p)
	}
	return len(problems), ctx.Err()
}

// quietPerFile: with one bar for many files, their ✓ lines would cut through it.
func perFileLines(tasks, parallel int) bool {
	return tasks == 1 || parallel <= 1 || !progressEnabled()
}

type upFile struct {
	local string
	size  int64
	dir   string // directory below the destination, "" or "a/b"
	name  string
}

// localTree lists what uploading `src` means: its files, each with the directory it goes into
// below the destination, and the directories themselves (so empty ones exist too). A directory
// keeps its name unless written with a trailing slash ("its contents").
func localTree(src string, recursive bool) (files []upFile, dirs []string, skipped int, err error) {
	st, err := os.Stat(src)
	if err != nil {
		return nil, nil, 0, err
	}
	if !st.IsDir() {
		if !st.Mode().IsRegular() {
			return nil, nil, 0, errors.New(i18n.T("upload.not_regular", src))
		}
		return []upFile{{local: src, size: st.Size(), name: filepath.Base(src)}}, nil, 0, nil
	}
	if !recursive {
		return nil, nil, 0, errors.New(i18n.T("path.is_dir", src))
	}
	prefix := ""
	if abs, err := filepath.Abs(src); err == nil && !strings.HasSuffix(src, "/") && !strings.HasSuffix(src, string(os.PathSeparator)) {
		prefix = filepath.Base(abs)
		dirs = append(dirs, prefix)
	}
	err = filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil || rel == "." {
			return err
		}
		at := cleanRemote(prefix + "/" + filepath.ToSlash(rel))
		if d.IsDir() {
			dirs = append(dirs, at)
			return nil
		}
		// Follow symlinks to files; anything else (devices, sockets, links to directories) is skipped.
		fi, err := os.Stat(path)
		if err != nil || !fi.Mode().IsRegular() {
			skipped++
			return nil
		}
		files = append(files, upFile{local: path, size: fi.Size(), dir: dirOf(at), name: baseOf(at)})
		return nil
	})
	return files, dirs, skipped, err
}

// uploadTo copies local files and directories to a place in a project, like cp:
//   - dst is a directory (exists, has a trailing slash, or there are several sources): the
//     sources go into it under their own names;
//   - otherwise one source becomes dst: a file gets that name, a directory that path.
func uploadTo(ctx context.Context, rm *remote, dst ref, srcs []string, f transferFlags) error {
	p, err := rm.project(ctx, dst.project)
	if err != nil {
		return err
	}
	var at *api.Blob
	if dst.path != "" {
		if at, err = rm.lookup(ctx, p, dst.path); err != nil {
			return err
		}
	}
	var files []upFile
	var dirs []string
	skipped := 0
	for _, src := range srcs {
		fl, dl, sk, err := localTree(src, f.recursive)
		if err != nil {
			return err
		}
		files, dirs, skipped = append(files, fl...), append(dirs, dl...), skipped+sk
	}
	if skipped > 0 {
		warn("upload.skipped", skipped)
	}

	base := dst.path // the directory everything goes below
	intoDir := dst.path == "" || dst.slash || len(srcs) > 1 || (at != nil && at.Kind == "dir")
	if !intoDir {
		// One source, and dst is its new name.
		st, err := os.Stat(srcs[0])
		if err != nil {
			return err
		}
		if st.IsDir() {
			if at != nil {
				return errors.New(i18n.T("path.not_dir", dst))
			}
			// The directory itself becomes dst: drop its own name from the paths.
			top := ""
			if len(dirs) > 0 && !strings.HasSuffix(srcs[0], "/") {
				top = dirs[0]
			}
			strip := func(d string) string { return cleanRemote(strings.TrimPrefix(d, top)) }
			for i := range files {
				files[i].dir = strip(files[i].dir)
			}
			for i := range dirs {
				dirs[i] = strip(dirs[i])
			}
		} else {
			base = dirOf(dst.path)
			files[0].name = baseOf(dst.path)
		}
	} else if at != nil && at.Kind != "dir" {
		return errors.New(i18n.T("path.not_dir", dst))
	}

	baseID := ""
	if base != "" {
		if at != nil && at.Kind == "dir" && base == dst.path {
			baseID = at.ID
		} else {
			d, err := rm.c.Mkdir(ctx, p.ID, "", base, true)
			if err != nil {
				return err
			}
			baseID = d.ID
		}
	}
	// The directories below the destination, parents first; each mkdir -p answers with the id.
	ids := map[string]string{"": baseID}
	sort.Strings(dirs)
	for _, d := range dirs {
		if _, ok := ids[d]; ok || d == "" {
			continue
		}
		made, err := rm.c.Mkdir(ctx, p.ID, baseID, d, true)
		if err != nil {
			return err
		}
		ids[d] = made.ID
	}

	var done []*api.Blob
	var bytes int64
	lines := perFileLines(len(files), f.parallel)
	tasks := make([]task, 0, len(files))
	for _, uf := range files {
		var b *api.Blob
		tasks = append(tasks, task{
			label: uf.name,
			size:  uf.size,
			run: func(ctx context.Context, prog transfer.Progress) (err error) {
				b, err = transfer.Upload(ctx, rm.c, p.ID, uf.local, transfer.UploadOptions{
					Name: uf.name, ParentID: ids[uf.dir], Overwrite: f.overwrite, Jobs: f.jobs, Progress: prog,
				})
				if api.IsCode(err, "name_taken") {
					err = fmt.Errorf("%s — %s", errMessage(err), i18n.T("upload.hint_overwrite"))
				}
				return err
			},
			done: func() {
				done = append(done, b)
				bytes += b.Size
				if lines {
					info("upload.ok", b.Path, ui.Size(b.Size), p.Name)
				}
			},
		})
	}
	failed, err := runTasks(ctx, tasks, f.parallel)
	if err != nil {
		return err
	}
	if !lines {
		info("upload.done", len(done), ui.Size(bytes), ref{project: p.Name, path: base})
	}
	if jsonOut {
		if done == nil {
			done = []*api.Blob{}
		}
		if err := printJSON(done); err != nil {
			return err
		}
	}
	if failed > 0 {
		return errors.New(i18n.T("failed_count", failed, len(files)))
	}
	return nil
}

func uploadCmd() *cobra.Command {
	var name string
	var f transferFlags
	c := &cobra.Command{
		Use:               "upload <project[:dir]> <file>...",
		Aliases:           []string{"up", "push"},
		Short:             i18n.T("cmd.upload"),
		Long:              i18n.T("cmd.upload.long"),
		Args:              cobra.MinimumNArgs(2),
		ValidArgsFunction: completeArgs(completeRef, completeLocalFiles),
		RunE: func(cmd *cobra.Command, args []string) error {
			dst := parseRef(args[0])
			dst.slash = true // always a directory here: `cp` renames
			if name != "" {
				if len(args) != 2 {
					return errors.New(i18n.T("upload.name_multi"))
				}
				dst = dst.child(name)
			}
			rm, err := newRemote()
			if err != nil {
				return err
			}
			return uploadTo(cmd.Context(), rm, dst, args[1:], f)
		},
	}
	c.Flags().StringVar(&name, "name", "", i18n.T("flag.name"))
	f.add(c, true)
	return c
}

type dlItem struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Size int64  `json:"size"`
	Path string `json:"path"` // where it was saved
	// rel is where it goes below the output directory ("docs/a.pdf"); "" = Name.
	rel string
	url func(context.Context) (string, error)
}

// downloadItems downloads each item to out (a directory when dir is set or out is an existing
// directory, otherwise a file path), `parallel` files at a time, continuing past per-file errors.
func downloadItems(ctx context.Context, items []dlItem, out string, dir bool, jobs, parallel int) error {
	var done []dlItem
	var bytes int64
	lines := perFileLines(len(items), parallel)
	tasks := make([]task, 0, len(items))
	for _, it := range items {
		if it.rel == "" {
			it.rel = it.Name
		}
		tasks = append(tasks, task{
			label: it.Name,
			size:  it.Size,
			run: func(ctx context.Context, prog transfer.Progress) error {
				dest, err := destPath(out, it.rel, dir)
				if err != nil {
					return err
				}
				u, err := it.url(ctx)
				if err != nil {
					return err
				}
				it.Path = dest
				return transfer.Download(ctx, u, it.Size, dest, jobs, prog)
			},
			done: func() {
				done = append(done, it)
				bytes += it.Size
				if lines {
					info("download.ok", it.rel, ui.Size(it.Size), it.Path)
				}
			},
		})
	}
	failed, err := runTasks(ctx, tasks, parallel)
	if err != nil {
		return err
	}
	if !lines {
		where := out
		if where == "" {
			where = "."
		}
		info("download.done", len(done), ui.Size(bytes), where)
	}
	if jsonOut {
		if done == nil {
			done = []dlItem{}
		}
		if err := printJSON(done); err != nil {
			return err
		}
	}
	if failed > 0 {
		return errors.New(i18n.T("failed_count", failed, len(items)))
	}
	return nil
}

// destPath is where a download is saved. rel is the file's name, or its path below the output
// directory for recursive downloads; every part of it must be a plain name.
func destPath(out, rel string, dir bool) (string, error) {
	parts := strings.Split(rel, "/")
	for _, name := range parts {
		if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\`) {
			return "", errors.New(i18n.T("download.bad_name", rel))
		}
	}
	local := filepath.Join(parts...)
	if out == "" {
		out, dir = ".", true
	}
	if st, err := os.Stat(out); dir || len(parts) > 1 || (err == nil && st.IsDir()) || strings.HasSuffix(out, string(os.PathSeparator)) {
		dest := filepath.Join(out, local)
		return dest, os.MkdirAll(filepath.Dir(dest), 0o755)
	}
	return out, nil
}

// downloadFrom copies files and directories of projects to a local path, like cp. A directory
// needs -r and keeps its name unless written with a trailing slash ("its contents"); empty
// directories are created too.
func downloadFrom(ctx context.Context, rm *remote, srcs []ref, out string, dir bool, f transferFlags) error {
	var items []dlItem
	var mkdirs []string
	add := func(b api.Blob, rel string) {
		items = append(items, dlItem{ID: b.ID, Name: b.Name, Size: b.Size, rel: rel, url: func(ctx context.Context) (string, error) {
			u, err := rm.c.BlobURL(ctx, b.ID)
			if err != nil {
				return "", err
			}
			return u.URL, nil
		}})
	}
	for _, src := range srcs {
		p, b, err := rm.find(ctx, src)
		if err != nil {
			return err
		}
		if b != nil && b.Kind != "dir" {
			add(*b, b.Name)
			continue
		}
		if !f.recursive {
			return errors.New(i18n.T("path.is_dir", src))
		}
		dir = true
		dirID, prefix := "", ""
		if b != nil {
			dirID = b.ID
			if !src.slash {
				prefix = b.Name + "/"
				mkdirs = append(mkdirs, b.Name)
			}
		}
		err = walkRemote(ctx, rm.c, p.ID, dirID, prefix, 0, func(rel string, e api.Blob) error {
			if e.Kind == "dir" {
				mkdirs = append(mkdirs, rel)
			} else {
				add(e, rel)
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	for _, d := range mkdirs {
		// destPath checks the names and creates the directory a file in it would need.
		if _, err := destPath(out, d+"/_", true); err != nil {
			return err
		}
	}
	return downloadItems(ctx, items, out, dir || len(items) > 1, f.jobs, f.parallel)
}

func downloadCmd() *cobra.Command {
	var out string
	var all bool
	var f transferFlags
	c := &cobra.Command{
		Use:               "download <project[:path]> [path...]",
		Aliases:           []string{"dl", "pull"},
		Short:             i18n.T("cmd.download"),
		Long:              i18n.T("cmd.download.long"),
		Args:              cobra.MinimumNArgs(1),
		ValidArgsFunction: completeArgs(completeRef, completeBlobs),
		RunE: func(cmd *cobra.Command, args []string) error {
			srcs := refsOf(args)
			whole := len(args) == 1 && srcs[0].path == ""
			if all != whole {
				return errors.New(i18n.T("download.which"))
			}
			if all {
				f.recursive = true // everything in the project, directories included
			}
			rm, err := newRemote()
			if err != nil {
				return err
			}
			return downloadFrom(cmd.Context(), rm, srcs, out, all, f)
		},
	}
	c.Flags().StringVarP(&out, "output", "o", "", i18n.T("flag.output"))
	c.Flags().BoolVar(&all, "all", false, i18n.T("flag.all"))
	f.add(c, false)
	return c
}

func cpCmd() *cobra.Command {
	var f transferFlags
	c := &cobra.Command{
		Use:               "cp <source>... <destination>",
		Aliases:           []string{"copy"},
		Short:             i18n.T("cmd.cp"),
		Long:              i18n.T("cmd.cp.long"),
		Args:              cobra.MinimumNArgs(2),
		ValidArgsFunction: completeEither,
		RunE: func(cmd *cobra.Command, args []string) error {
			srcs, dst := args[:len(args)-1], args[len(args)-1]
			remoteSrcs := 0
			for _, s := range srcs {
				if isRemote(s) {
					remoteSrcs++
				}
			}
			rm, err := newRemote()
			if err != nil {
				return err
			}
			switch {
			case isRemote(dst) && remoteSrcs == 0:
				return uploadTo(cmd.Context(), rm, parseRef(dst), srcs, f)
			case !isRemote(dst) && remoteSrcs == len(srcs):
				refs := make([]ref, len(srcs))
				for i, s := range srcs {
					refs[i] = parseRef(s)
				}
				return downloadFrom(cmd.Context(), rm, refs, dst, len(srcs) > 1, f)
			case isRemote(dst):
				return errors.New(i18n.T("cp.remote_remote"))
			default:
				return errors.New(i18n.T("cp.usage"))
			}
		},
	}
	f.add(c, true)
	return c
}

// oneProject resolves places that must all be in the same project (rm, mv).
func oneProject(ctx context.Context, rm *remote, refs []ref) (*api.Project, []api.Blob, error) {
	var project *api.Project
	blobs := make([]api.Blob, 0, len(refs))
	for _, at := range refs {
		p, b, err := rm.find(ctx, at)
		if err != nil {
			return nil, nil, err
		}
		if b == nil {
			return nil, nil, errors.New(i18n.T("path.is_root", at))
		}
		if project != nil && project.ID != p.ID {
			return nil, nil, errors.New(i18n.T("path.same_project"))
		}
		project = p
		blobs = append(blobs, *b)
	}
	return project, blobs, nil
}

func rmCmd() *cobra.Command {
	var yes, recursive bool
	c := &cobra.Command{
		Use:               "rm <project:path>...",
		Aliases:           []string{"delete"},
		Short:             i18n.T("cmd.rm"),
		Args:              cobra.MinimumNArgs(1),
		ValidArgsFunction: completeArgs(completeRef, completeBlobs),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			rm, err := newRemote()
			if err != nil {
				return err
			}
			refs := refsOf(args)
			p, blobs, err := oneProject(ctx, rm, refs)
			if err != nil {
				return err
			}
			key := "blob.confirm_rm"
			for i, b := range blobs {
				if b.Kind == "dir" {
					if !recursive {
						return errors.New(i18n.T("path.is_dir", refs[i]))
					}
					key = "blob.confirm_rm_r"
				}
			}
			if !confirm(yes, key, len(blobs), p.Name) {
				return errors.New(i18n.T("aborted"))
			}
			ids := make([]string, len(blobs))
			for i, b := range blobs {
				ids[i] = b.ID
			}
			n, err := rm.c.DeleteBlobs(ctx, p.ID, ids)
			if err != nil || jsonOut {
				return orJSON(err, map[string]int{"deleted": n})
			}
			info("blob.deleted", n, p.Name)
			return nil
		},
	}
	c.Flags().BoolVarP(&yes, "yes", "y", false, i18n.T("flag.yes"))
	c.Flags().BoolVarP(&recursive, "recursive", "r", false, i18n.T("flag.rm_recursive"))
	return c
}

// mvCmd moves and renames inside a project, like mv: into the destination when it is a
// directory, else to that name. The older `mv <project> <name> <new-name>` only renames.
func mvCmd() *cobra.Command {
	return &cobra.Command{
		Use:               "mv <project:path>... <project:path>",
		Aliases:           []string{"rename", "move"},
		Short:             i18n.T("cmd.mv"),
		Long:              i18n.T("cmd.mv.long"),
		Args:              cobra.MinimumNArgs(2),
		ValidArgsFunction: completeArgs(completeRef, completeBlobs),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			rm, err := newRemote()
			if err != nil {
				return err
			}
			if len(args) == 3 && !strings.Contains(args[0], ":") && !strings.Contains(args[1], ":") {
				_, blobs, err := oneProject(ctx, rm, refsOf(args[:2]))
				if err != nil {
					return err
				}
				b, err := rm.c.RenameBlob(ctx, blobs[0].ID, args[2])
				if err != nil || jsonOut {
					return orJSON(err, b)
				}
				info("blob.renamed", blobs[0].Name, b.Name)
				return nil
			}
			srcs, dst := refsOf(args[:len(args)-1]), parseRef(args[len(args)-1])
			if strings.Contains(args[0], ":") != strings.Contains(args[len(args)-1], ":") {
				return errors.New(i18n.T("mv.usage"))
			}
			p, blobs, err := oneProject(ctx, rm, srcs)
			if err != nil {
				return err
			}
			if dp, err := rm.project(ctx, dst.project); err != nil {
				return err
			} else if dp.ID != p.ID {
				return errors.New(i18n.T("path.same_project"))
			}
			// Where to: an existing directory (or the root) takes the sources in; otherwise the
			// last name of dst is the new name, in the directory before it.
			var at *api.Blob
			if dst.path != "" {
				if at, err = rm.lookup(ctx, p, dst.path); err != nil {
					return err
				}
			}
			parentID, name := "", ""
			switch {
			case dst.path == "":
			case at != nil && at.Kind == "dir":
				parentID = at.ID
			case len(blobs) > 1 || dst.slash:
				return errors.New(i18n.T("path.not_dir", dst))
			default:
				name = baseOf(dst.path)
				if d := dirOf(dst.path); d != "" {
					if _, parentID, err = rm.dir(ctx, ref{project: dst.project, path: d}); err != nil {
						return err
					}
				}
			}
			moved := make([]*api.Blob, 0, len(blobs))
			for _, b := range blobs {
				m, err := rm.c.MoveBlob(ctx, b.ID, name, &parentID)
				if err != nil {
					return fmt.Errorf("%s: %s", b.Path, errMessage(err))
				}
				moved = append(moved, m)
				info("mv.ok", b.Path, m.Path)
			}
			if jsonOut {
				return printJSON(moved)
			}
			return nil
		},
	}
}

func urlCmd() *cobra.Command {
	return &cobra.Command{
		Use:               "url <project:path>",
		Short:             i18n.T("cmd.url"),
		Args:              cobra.RangeArgs(1, 2),
		ValidArgsFunction: completeArgs(completeRef, completeBlobs, completeNothing),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			rm, b, err := oneFile(ctx, args)
			if err != nil {
				return err
			}
			u, err := rm.c.BlobURL(ctx, b.ID)
			if err != nil || jsonOut {
				return orJSON(err, u)
			}
			fmt.Println(u.URL)
			info("url.expires", ui.Time(u.ExpiresAt))
			return nil
		},
	}
}

// oneFile resolves the single file a command is about.
func oneFile(ctx context.Context, args []string) (*remote, *api.Blob, error) {
	rm, err := newRemote()
	if err != nil {
		return nil, nil, err
	}
	at := refsOf(args)[0]
	_, b, err := rm.find(ctx, at)
	if err != nil {
		return nil, nil, err
	}
	if b == nil || b.Kind == "dir" {
		return nil, nil, errors.New(i18n.T("path.not_file", at))
	}
	return rm, b, nil
}

func catCmd() *cobra.Command {
	return &cobra.Command{
		Use:               "cat <project:path>",
		Short:             i18n.T("cmd.cat"),
		Args:              cobra.ExactArgs(1),
		ValidArgsFunction: completeArgs(completeRef, completeNothing),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			rm, b, err := oneFile(ctx, args)
			if err != nil {
				return err
			}
			u, err := rm.c.BlobURL(ctx, b.ID)
			if err != nil {
				return err
			}
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.URL, nil)
			if err != nil {
				return err
			}
			resp, err := transfer.HTTP.Do(req)
			if err != nil {
				return err
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				return fmt.Errorf("storage: HTTP %d", resp.StatusCode)
			}
			_, err = io.Copy(os.Stdout, resp.Body)
			return err
		},
	}
}

func mkdirCmd() *cobra.Command {
	var parents bool
	c := &cobra.Command{
		Use:               "mkdir <project:path>...",
		Short:             i18n.T("cmd.mkdir"),
		Args:              cobra.MinimumNArgs(1),
		ValidArgsFunction: completeRef,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			rm, err := newRemote()
			if err != nil {
				return err
			}
			made := []*api.Blob{}
			for _, at := range refsOf(args) {
				p, err := rm.project(ctx, at.project)
				if err != nil {
					return err
				}
				d, err := rm.c.Mkdir(ctx, p.ID, "", at.path, parents)
				if err != nil {
					return fmt.Errorf("%s: %s", at, errMessage(err))
				}
				made = append(made, d)
				info("mkdir.ok", ref{project: p.Name, path: d.Path})
			}
			if jsonOut {
				return printJSON(made)
			}
			return nil
		},
	}
	c.Flags().BoolVarP(&parents, "parents", "p", false, i18n.T("flag.parents"))
	return c
}

func statCmd() *cobra.Command {
	return &cobra.Command{
		Use:               "stat <project:path>",
		Short:             i18n.T("cmd.stat"),
		Args:              cobra.RangeArgs(1, 2),
		ValidArgsFunction: completeArgs(completeRef, completeBlobs, completeNothing),
		RunE: func(cmd *cobra.Command, args []string) error {
			rm, err := newRemote()
			if err != nil {
				return err
			}
			at := refsOf(args)[0]
			_, b, err := rm.find(cmd.Context(), at)
			if err != nil {
				return err
			}
			if b == nil {
				return errors.New(i18n.T("path.is_root", at))
			}
			if jsonOut {
				return printJSON(b)
			}
			kv("col.path", b.Path, "col.type", i18n.T("kind."+b.Kind), "col.size", ui.Size(b.Size), "col.content_type", b.ContentType,
				"col.created", ui.Time(b.CreatedAt), "col.uploader", uploaderOf(*b), "col.id", b.ID)
			return nil
		},
	}
}

func treeCmd() *cobra.Command {
	var depth int
	c := &cobra.Command{
		Use:               "tree <project[:path]>",
		Short:             i18n.T("cmd.tree"),
		Args:              cobra.ExactArgs(1),
		ValidArgsFunction: completeArgs(completeRef, completeNothing),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			rm, err := newRemote()
			if err != nil {
				return err
			}
			at := parseRef(args[0])
			p, dirID, err := rm.dir(ctx, at)
			if err != nil {
				return err
			}
			type node struct {
				api.Blob
				Children []*node `json:"children,omitempty"`
			}
			root := &node{}
			byPath := map[string]*node{"": root}
			dirs, files := 0, 0
			err = walkRemote(ctx, rm.c, p.ID, dirID, "", depth, func(rel string, b api.Blob) error {
				n := &node{Blob: b}
				byPath[rel] = n
				parent := byPath[dirOf(rel)]
				parent.Children = append(parent.Children, n)
				if b.Kind == "dir" {
					dirs++
				} else {
					files++
				}
				return nil
			})
			if err != nil {
				return err
			}
			if jsonOut {
				if root.Children == nil {
					root.Children = []*node{}
				}
				return printJSON(root.Children)
			}
			fmt.Println(ref{project: p.Name, path: at.path})
			var draw func(n *node, indent string)
			draw = func(n *node, indent string) {
				for i, ch := range n.Children {
					branch, next := "├── ", "│   "
					if i == len(n.Children)-1 {
						branch, next = "└── ", "    "
					}
					label := ch.Name
					if ch.Kind == "dir" {
						label += "/"
					} else {
						label += "  (" + ui.Size(ch.Size) + ")"
					}
					fmt.Println(indent + branch + label)
					draw(ch, indent+next)
				}
			}
			draw(root, "")
			info("tree.summary", dirs, files)
			return nil
		},
	}
	c.Flags().IntVarP(&depth, "depth", "L", 0, i18n.T("flag.depth"))
	return c
}
