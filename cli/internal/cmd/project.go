package cmd

import (
	"errors"
	"fmt"
	"strconv"

	"github.com/spf13/cobra"

	"github.com/davidliyutong/blift/cli/internal/api"
	"github.com/davidliyutong/blift/cli/internal/i18n"
	"github.com/davidliyutong/blift/cli/internal/ui"
)

func projectCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "project",
		Aliases: []string{"projects", "p"},
		Short:   i18n.T("cmd.project"),
	}
	c.AddCommand(projectLsCmd(), projectCreateCmd(), projectInfoCmd(), projectRmCmd(), projectRenameCmd(),
		projectMembersCmd(), projectAddMemberCmd(), projectRmMemberCmd())
	return c
}

func projectLsCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "ls",
		Aliases: []string{"list"},
		Short:   i18n.T("cmd.project.ls"),
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c, err := client()
			if err != nil {
				return err
			}
			projects, err := c.Projects(cmd.Context())
			if err != nil || jsonOut {
				return orJSON(err, projects)
			}
			rows := make([][]string, 0, len(projects))
			for _, p := range projects {
				rows = append(rows, []string{p.Name, p.Owner.Username, p.Role,
					strconv.FormatInt(p.BlobCount, 10), ui.Size(p.UsedBytes), ui.Time(p.UpdatedAt), p.ID})
			}
			table([]string{"col.name", "col.owner", "col.role", "col.files", "col.size", "col.updated", "col.id"}, rows)
			return nil
		},
	}
}

func projectCreateCmd() *cobra.Command {
	var desc, storage string
	c := &cobra.Command{
		Use:               "create <name>",
		Short:             i18n.T("cmd.project.create"),
		Args:              cobra.ExactArgs(1),
		ValidArgsFunction: completeNothing,
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := client()
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			storageID := storage
			if storage != "" { // accept a storage name as well as an id
				storages, err := c.Storages(ctx)
				if err != nil {
					return err
				}
				for _, s := range storages {
					if s.Name == storage {
						storageID = s.ID
					}
				}
			}
			p, err := c.CreateProject(ctx, args[0], desc, storageID)
			if err != nil || jsonOut {
				return orJSON(err, p)
			}
			info("project.created", p.Name, p.ID)
			return nil
		},
	}
	c.Flags().StringVarP(&desc, "description", "d", "", i18n.T("flag.description"))
	c.Flags().StringVar(&storage, "storage", "", i18n.T("flag.storage"))
	_ = c.RegisterFlagCompletionFunc("storage", completeStorages)
	return c
}

func projectInfoCmd() *cobra.Command {
	return &cobra.Command{
		Use:               "info <project>",
		Short:             i18n.T("cmd.project.info"),
		Args:              cobra.ExactArgs(1),
		ValidArgsFunction: completeArgs(completeProjects, completeNothing),
		RunE: func(cmd *cobra.Command, args []string) error {
			_, p, err := projectWithClient(cmd.Context(), args[0])
			if err != nil || jsonOut {
				return orJSON(err, p)
			}
			storage := p.StorageName
			if p.StorageLocation != "" {
				storage += " · " + p.StorageLocation
			}
			kv("col.id", p.ID,
				"col.name", p.Name,
				"col.description", p.Description,
				"col.owner", p.Owner.Username,
				"col.role", p.Role,
				"col.storage", fmt.Sprintf("%s (%s)", storage, p.StorageID),
				"col.files", strconv.FormatInt(p.BlobCount, 10),
				"col.size", ui.Size(p.UsedBytes),
				"col.inbox", inboxText(p),
				"col.created", ui.Time(p.CreatedAt),
				"col.updated", ui.Time(p.UpdatedAt))
			return nil
		},
	}
}

func projectRmCmd() *cobra.Command {
	var yes bool
	c := &cobra.Command{
		Use:               "rm <project>",
		Aliases:           []string{"delete"},
		Short:             i18n.T("cmd.project.rm"),
		Args:              cobra.ExactArgs(1),
		ValidArgsFunction: completeArgs(completeProjects, completeNothing),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, p, err := projectWithClient(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			if !confirm(yes, "project.confirm_rm", p.Owner.Username+"/"+p.Name, p.BlobCount, ui.Size(p.UsedBytes)) {
				return errors.New(i18n.T("aborted"))
			}
			if err := c.DeleteProject(cmd.Context(), p.ID); err != nil {
				return err
			}
			info("project.deleted", p.Name)
			return nil
		},
	}
	c.Flags().BoolVarP(&yes, "yes", "y", false, i18n.T("flag.yes"))
	return c
}

func projectRenameCmd() *cobra.Command {
	return &cobra.Command{
		Use:               "rename <project> <new-name>",
		Short:             i18n.T("cmd.project.rename"),
		Args:              cobra.ExactArgs(2),
		ValidArgsFunction: completeArgs(completeProjects, completeNothing),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, p, err := projectWithClient(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			np, err := c.UpdateProject(cmd.Context(), p.ID, map[string]string{"name": args[1]})
			if err != nil || jsonOut {
				return orJSON(err, np)
			}
			info("project.renamed", p.Name, np.Name)
			return nil
		},
	}
}

func projectMembersCmd() *cobra.Command {
	return &cobra.Command{
		Use:               "members <project>",
		Short:             i18n.T("cmd.project.members"),
		Args:              cobra.ExactArgs(1),
		ValidArgsFunction: completeArgs(completeProjects, completeNothing),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, p, err := projectWithClient(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			members, err := c.Members(cmd.Context(), p.ID)
			if err != nil || jsonOut {
				return orJSON(err, members)
			}
			rows := make([][]string, 0, len(members))
			for _, m := range members {
				rows = append(rows, []string{m.User.Username, strOr(m.User.DisplayName, "-"), strOr(m.User.Email, "-"), m.Role, ui.Time(m.CreatedAt)})
			}
			table([]string{"col.username", "col.display_name", "col.email", "col.role", "col.joined"}, rows)
			return nil
		},
	}
}

func projectAddMemberCmd() *cobra.Command {
	var role string
	c := &cobra.Command{
		Use:               "add-member <project> <user>",
		Short:             i18n.T("cmd.project.add_member"),
		Args:              cobra.ExactArgs(2),
		ValidArgsFunction: completeArgs(completeProjects, completeUsers, completeNothing),
		RunE: func(cmd *cobra.Command, args []string) error {
			if role != "editor" && role != "viewer" {
				return errors.New(i18n.T("bad_role", role))
			}
			c, p, err := projectWithClient(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			m, err := c.AddMember(cmd.Context(), p.ID, args[1], role)
			if err != nil || jsonOut {
				return orJSON(err, m)
			}
			info("member.added", m.User.Username, p.Name, m.Role)
			return nil
		},
	}
	c.Flags().StringVar(&role, "role", "viewer", i18n.T("flag.role"))
	_ = c.RegisterFlagCompletionFunc("role", fixed("editor", "viewer"))
	return c
}

func projectRmMemberCmd() *cobra.Command {
	return &cobra.Command{
		Use:               "rm-member <project> <user>",
		Short:             i18n.T("cmd.project.rm_member"),
		Args:              cobra.ExactArgs(2),
		ValidArgsFunction: completeArgs(completeProjects, completeMembers, completeNothing),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, p, err := projectWithClient(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			members, err := c.Members(cmd.Context(), p.ID)
			if err != nil {
				return err
			}
			var target *api.Member
			for i, m := range members {
				if m.User.ID == args[1] || m.User.Username == args[1] || strOr(m.User.Email, "") == args[1] {
					target = &members[i]
				}
			}
			if target == nil {
				return errors.New(i18n.T("member.not_found", args[1], p.Name))
			}
			if err := c.RemoveMember(cmd.Context(), p.ID, target.User.ID); err != nil {
				return err
			}
			info("member.removed", target.User.Username, p.Name)
			return nil
		},
	}
}

// orJSON returns err, or prints v as JSON when there is no error (used with --json).
func orJSON(err error, v any) error {
	if err != nil {
		return err
	}
	return printJSON(v)
}

// inboxText shows the anonymous upload link (editors and owners), else whether the inbox is on.
func inboxText(p *api.Project) string {
	switch {
	case p.InboxURL != nil:
		return *p.InboxURL
	case p.InboxEnabled:
		return i18n.T("yes")
	}
	return i18n.T("inbox.off")
}
