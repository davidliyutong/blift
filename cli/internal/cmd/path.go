package cmd

// Remote paths. A place in a project is written project:path, as with scp and rclone:
//
//	demo              the project (its root)
//	demo:docs/a.pdf   a file or a directory
//	alice/demo:docs/  owner/name, when the name alone is ambiguous
//
// The colon tells remote from local in `blift cp`; a local file with a colon in its name is
// written ./a:b. The commands that take a project first also accept the older form
// `<project> <name>...`, where each name is a path from the project's root (or a file id).

import (
	"context"
	"errors"
	"regexp"
	"strings"

	"github.com/davidliyutong/blift/cli/internal/api"
	"github.com/davidliyutong/blift/cli/internal/i18n"
)

var remoteRe = regexp.MustCompile(`^(?:[A-Za-z0-9][A-Za-z0-9._-]*/)?[A-Za-z0-9][A-Za-z0-9._-]*:`)

// isRemote reports whether a cp argument names a place in a project rather than a local path.
func isRemote(arg string) bool { return remoteRe.MatchString(arg) }

type ref struct {
	project string
	path    string // no leading or trailing slash; "" = the project's root
	// Written with a trailing slash, or the root: "this directory" as a destination, "what is
	// in it" as the source of a recursive copy (as with rsync).
	slash bool
}

func cleanRemote(p string) string {
	return strings.Join(strings.FieldsFunc(p, func(r rune) bool { return r == '/' }), "/")
}

func parseRef(arg string) ref {
	project, path, _ := strings.Cut(arg, ":")
	clean := cleanRemote(path)
	return ref{project: project, path: clean, slash: clean == "" || strings.HasSuffix(path, "/")}
}

func (r ref) String() string { return r.project + ":" + r.path }

// child is the place `rel` below r.
func (r ref) child(rel string) ref {
	return ref{project: r.project, path: cleanRemote(r.path + "/" + rel)}
}

func baseOf(path string) string { return path[strings.LastIndex(path, "/")+1:] }

func dirOf(path string) string {
	if i := strings.LastIndex(path, "/"); i >= 0 {
		return path[:i]
	}
	return ""
}

// refsOf reads the arguments of a command as places: either all project:path, or the older
// `<project> <path>...`.
func refsOf(args []string) []ref {
	if len(args) > 1 && !strings.Contains(args[0], ":") {
		out := make([]ref, 0, len(args)-1)
		for _, a := range args[1:] {
			out = append(out, ref{project: args[0], path: cleanRemote(a), slash: strings.HasSuffix(a, "/")})
		}
		return out
	}
	out := make([]ref, 0, len(args))
	for _, a := range args {
		out = append(out, parseRef(a))
	}
	return out
}

// remote is an authenticated client that remembers the projects it resolved.
type remote struct {
	c        *api.Client
	projects map[string]*api.Project
}

func newRemote() (*remote, error) {
	c, err := client()
	if err != nil {
		return nil, err
	}
	return &remote{c: c, projects: map[string]*api.Project{}}, nil
}

func (r *remote) project(ctx context.Context, name string) (*api.Project, error) {
	if p, ok := r.projects[name]; ok {
		return p, nil
	}
	p, err := resolveProject(ctx, r.c, name)
	if err == nil {
		r.projects[name] = p
	}
	return p, err
}

// stat returns what is at a path: nil for the root, a path.not_found error if nothing is there.
func (r *remote) stat(ctx context.Context, at ref) (*api.Project, *api.Blob, error) {
	p, err := r.project(ctx, at.project)
	if err != nil || at.path == "" {
		return p, nil, err
	}
	b, err := r.c.Stat(ctx, p.ID, at.path)
	if api.IsCode(err, "not_found") {
		return p, nil, errors.New(i18n.T("path.not_found", at))
	}
	return p, b, err
}

// lookup returns what is at a path of a project, or nil when nothing is there (a destination
// that may not exist yet).
func (r *remote) lookup(ctx context.Context, p *api.Project, path string) (*api.Blob, error) {
	b, err := r.c.Stat(ctx, p.ID, path)
	if api.IsCode(err, "not_found") {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return b, nil
}

// find is stat for arguments that may also be a blob id (the older `<project> <name>` form).
func (r *remote) find(ctx context.Context, at ref) (*api.Project, *api.Blob, error) {
	p, b, err := r.stat(ctx, at)
	if err == nil || p == nil || at.path == "" || strings.Contains(at.path, "/") {
		return p, b, err
	}
	if byID, idErr := r.c.Blob(ctx, at.path); idErr == nil && byID.ProjectID == p.ID {
		return p, byID, nil
	}
	return p, nil, err
}

// dirID resolves a directory for listing or as a destination: "" for the root.
func (r *remote) dir(ctx context.Context, at ref) (*api.Project, string, error) {
	p, b, err := r.stat(ctx, at)
	if err != nil || b == nil {
		return p, "", err
	}
	if b.Kind != "dir" {
		return p, "", errors.New(i18n.T("path.not_dir", at))
	}
	return p, b.ID, nil
}

// listDir returns the entries of a directory (directories first, by name); max ≤ 0: all.
func listDir(ctx context.Context, c *api.Client, projectID, dirID string, max int) ([]api.Blob, error) {
	blobs, _, err := c.ListBlobs(ctx, projectID, api.BlobQuery{Dir: true, ParentID: dirID, Sort: "name", Order: "asc"}, max)
	return blobs, err
}

// walkRemote visits everything below a directory, depth first and by name: fn gets each entry
// with its path relative to that directory. maxDepth ≤ 0: no limit.
func walkRemote(ctx context.Context, c *api.Client, projectID, dirID, rel string, maxDepth int, fn func(rel string, b api.Blob) error) error {
	entries, err := listDir(ctx, c, projectID, dirID, 0)
	if err != nil {
		return err
	}
	for _, b := range entries {
		at := rel + b.Name
		if err := fn(at, b); err != nil {
			return err
		}
		if b.Kind == "dir" && maxDepth != 1 {
			if err := walkRemote(ctx, c, projectID, b.ID, at+"/", maxDepth-1, fn); err != nil {
				return err
			}
		}
	}
	return nil
}
