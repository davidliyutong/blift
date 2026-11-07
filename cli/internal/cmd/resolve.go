package cmd

import (
	"context"
	"errors"
	"strings"

	"github.com/davidliyutong/blift/cli/internal/api"
	"github.com/davidliyutong/blift/cli/internal/i18n"
)

// resolveProject maps a project argument to a project. Accepted forms: id, name,
// or owner/name. An exact id match wins; otherwise names are matched, preferring
// projects owned by the current user.
func resolveProject(ctx context.Context, c *api.Client, arg string) (*api.Project, error) {
	projects, err := c.Projects(ctx)
	if err != nil {
		return nil, err
	}
	var matches []api.Project
	for _, p := range projects {
		if p.ID == arg {
			return &p, nil
		}
		if p.Name == arg || p.Owner.Username+"/"+p.Name == arg {
			matches = append(matches, p)
		}
	}
	if len(matches) == 1 {
		return &matches[0], nil
	}
	if len(matches) == 0 {
		return nil, errors.New(i18n.T("project.not_found", arg))
	}
	me, err := c.Me(ctx)
	if err != nil {
		return nil, err
	}
	var mine []api.Project
	for _, p := range matches {
		if p.Owner.ID == me.ID {
			mine = append(mine, p)
		}
	}
	if len(mine) == 1 {
		return &mine[0], nil
	}
	var cands []string
	for _, p := range matches {
		cands = append(cands, "  "+p.Owner.Username+"/"+p.Name+" ("+p.ID+")")
	}
	return nil, errors.New(i18n.T("project.ambiguous", arg, strings.Join(cands, "\n")))
}

// resolveBlobs maps blob names (or ids) to blobs. Names are looked up exactly (50 per request),
// so this stays cheap however large the project is; arguments that match no name are tried
// as blob ids.
func resolveBlobs(ctx context.Context, c *api.Client, projectID string, args []string) ([]api.Blob, error) {
	named, err := c.BlobsNamed(ctx, projectID, args)
	if err != nil {
		return nil, err
	}
	byName := map[string]api.Blob{}
	for _, b := range named {
		byName[b.Name] = b
	}
	out := make([]api.Blob, 0, len(args))
	for _, a := range args {
		if b, ok := byName[a]; ok {
			out = append(out, b)
			continue
		}
		b, err := c.Blob(ctx, a)
		if err != nil && !api.IsCode(err, "not_found") {
			return nil, err
		}
		if err != nil || b.ProjectID != projectID {
			return nil, errors.New(i18n.T("blob.not_found", a))
		}
		out = append(out, *b)
	}
	return out, nil
}

// projectWithClient is the common prologue: authenticated client + resolved project.
func projectWithClient(ctx context.Context, arg string) (*api.Client, *api.Project, error) {
	c, err := client()
	if err != nil {
		return nil, nil, err
	}
	p, err := resolveProject(ctx, c, arg)
	return c, p, err
}
