package cmd

// Shell completion. `blift completion bash|zsh|fish|powershell` prints the script (cobra);
// candidates for projects, files, shares and users come from the server. Each lookup is one
// short request: files are prefix-filtered on the server, so a project with a million files
// completes as fast as a small one. On any error the shell just gets no candidates.

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/davidliyutong/blift/cli/internal/api"
	"github.com/davidliyutong/blift/cli/internal/i18n"
	"github.com/davidliyutong/blift/cli/internal/ui"
)

const (
	completeTimeout = 5 * time.Second
	completeMax     = 200 // file candidates per request
)

type completeFunc = func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective)

const noFiles = cobra.ShellCompDirectiveNoFileComp

// completeArgs completes each positional argument with the function for its position; later
// positions reuse the last one (variadic arguments such as several files).
func completeArgs(fns ...completeFunc) completeFunc {
	return func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
		return fns[min(len(args), len(fns)-1)](cmd, args, toComplete)
	}
}

// completeNothing ends completion for an argument the user has to type (a new name, a URL).
func completeNothing(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
	return nil, noFiles
}

// completeLocalFiles lets the shell complete local paths (upload).
func completeLocalFiles(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
	return nil, cobra.ShellCompDirectiveDefault
}

// withClient runs fn with an authenticated client and a short deadline.
func withClient(cmd *cobra.Command, fn func(ctx context.Context, c *api.Client) []string) ([]string, cobra.ShellCompDirective) {
	c, err := client()
	if err != nil {
		return nil, noFiles
	}
	parent := cmd.Context()
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, completeTimeout)
	defer cancel()
	return fn(ctx, c), noFiles
}

func hasPrefixFold(s, prefix string) bool {
	return len(s) >= len(prefix) && strings.EqualFold(s[:len(prefix)], prefix)
}

// completeProjects offers project names; names shared by several of your projects (and any
// input containing "/") complete as owner/name.
func completeProjects(cmd *cobra.Command, _ []string, toComplete string) ([]string, cobra.ShellCompDirective) {
	return withClient(cmd, func(ctx context.Context, c *api.Client) []string {
		projects, err := c.Projects(ctx)
		if err != nil {
			return nil
		}
		count := map[string]int{}
		for _, p := range projects {
			count[strings.ToLower(p.Name)]++
		}
		var out []string
		for _, p := range projects {
			v := p.Name
			if count[strings.ToLower(p.Name)] > 1 || strings.Contains(toComplete, "/") {
				v = p.Owner.Username + "/" + p.Name
			}
			if hasPrefixFold(v, toComplete) {
				out = append(out, v+"\t"+i18n.T("comp.project", p.Owner.Username, p.BlobCount))
			}
		}
		return out
	})
}

// completeBlobs offers file names of the project given as the first argument, skipping files
// already on the command line.
func completeBlobs(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
	if len(args) == 0 {
		return nil, noFiles
	}
	return withClient(cmd, func(ctx context.Context, c *api.Client) []string {
		p, err := resolveProject(ctx, c, args[0])
		if err != nil {
			return nil
		}
		page, err := c.BlobsPage(ctx, p.ID, api.BlobQuery{Prefix: toComplete, Sort: "name", Order: "asc", Limit: completeMax})
		if err != nil {
			return nil
		}
		given := map[string]bool{}
		for _, a := range args[1:] {
			given[a] = true
		}
		var out []string
		for _, b := range page.Blobs {
			if !given[b.Name] && hasPrefixFold(b.Name, toComplete) {
				out = append(out, b.Name+"\t"+ui.Size(b.Size))
			}
		}
		return out
	})
}

// completeShares offers share ids, described by what they share.
func completeShares(cmd *cobra.Command, _ []string, toComplete string) ([]string, cobra.ShellCompDirective) {
	return withClient(cmd, func(ctx context.Context, c *api.Client) []string {
		shares, err := c.Shares(ctx, "")
		if err != nil {
			return nil
		}
		var out []string
		for _, s := range shares {
			if !strings.HasPrefix(s.ID, toComplete) {
				continue
			}
			what := s.ProjectName
			if s.BlobName != nil {
				what += "/" + *s.BlobName
			}
			out = append(out, s.ID+"\t"+what)
		}
		return out
	})
}

// completeMembers offers the members of the project in the first argument (not its owner).
func completeMembers(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
	return withClient(cmd, func(ctx context.Context, c *api.Client) []string {
		p, err := resolveProject(ctx, c, args[0])
		if err != nil {
			return nil
		}
		members, err := c.Members(ctx, p.ID)
		if err != nil {
			return nil
		}
		var out []string
		for _, m := range members {
			if m.Role != "owner" && hasPrefixFold(m.User.Username, toComplete) {
				out = append(out, m.User.Username+"\t"+m.Role)
			}
		}
		return out
	})
}

// completeUsers searches users by what was typed so far (needs at least one character).
func completeUsers(cmd *cobra.Command, _ []string, toComplete string) ([]string, cobra.ShellCompDirective) {
	if toComplete == "" {
		return nil, noFiles
	}
	return withClient(cmd, func(ctx context.Context, c *api.Client) []string {
		users, err := c.SearchUsers(ctx, toComplete)
		if err != nil {
			return nil
		}
		var out []string
		for _, u := range users {
			desc := strOr(u.DisplayName, "")
			if u.Email != nil && *u.Email != "" {
				desc = strings.TrimSpace(fmt.Sprintf("%s <%s>", desc, *u.Email))
			}
			out = append(out, u.Username+"\t"+desc)
		}
		return out
	})
}

// completeStorages offers storage backend names (for --storage).
func completeStorages(cmd *cobra.Command, _ []string, toComplete string) ([]string, cobra.ShellCompDirective) {
	return withClient(cmd, func(ctx context.Context, c *api.Client) []string {
		storages, err := c.Storages(ctx)
		if err != nil {
			return nil
		}
		var out []string
		for _, s := range storages {
			if hasPrefixFold(s.Name, toComplete) {
				out = append(out, s.Name+"\t"+s.Provider)
			}
		}
		return out
	})
}

func fixed(values ...string) completeFunc {
	return cobra.FixedCompletions(values, noFiles)
}
