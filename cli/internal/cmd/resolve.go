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

// projectWithClient is the common prologue: authenticated client + resolved project.
func projectWithClient(ctx context.Context, arg string) (*api.Client, *api.Project, error) {
	c, err := client()
	if err != nil {
		return nil, nil, err
	}
	p, err := resolveProject(ctx, c, arg)
	return c, p, err
}
