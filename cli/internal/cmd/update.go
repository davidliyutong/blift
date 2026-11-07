package cmd

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/spf13/cobra"

	"github.com/davidliyutong/blift/cli/internal/config"
	"github.com/davidliyutong/blift/cli/internal/i18n"
	"github.com/davidliyutong/blift/cli/internal/update"
)

func updateCmd() *cobra.Command {
	var target string
	var check, force bool
	c := &cobra.Command{
		Use:               "update",
		Aliases:           []string{"upgrade", "self-update"},
		Short:             i18n.T("cmd.update"),
		Long:              i18n.T("cmd.update.long"),
		Args:              cobra.NoArgs,
		ValidArgsFunction: completeNothing,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			result := func(v map[string]any) error {
				if jsonOut {
					return printJSON(v)
				}
				return nil
			}
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			server := currentServer(cfg)
			u := update.New("blift-cli/" + version)

			explicit := target != ""
			if !explicit {
				if target, err = u.Latest(ctx, server); err != nil {
					return errors.New(i18n.T("update.no_latest", err))
				}
			}
			target = strings.TrimPrefix(target, "v")
			from, to := version, "v"+target
			// An explicit --version may go back; otherwise only move forward (a local build of a
			// newer commit is left alone).
			if cmp := update.Compare(from, to); !force && (cmp == 0 || (cmp > 0 && !explicit)) {
				info("update.latest", from)
				return result(map[string]any{"version": from, "latest": to, "updated": false})
			}
			if check {
				info("update.available", from, to)
				return result(map[string]any{"version": from, "latest": to, "updated": false})
			}

			goos, goarch := runtime.GOOS, runtime.GOARCH
			if (goos != "linux" && goos != "darwin") || (goarch != "amd64" && goarch != "arm64") {
				return errors.New(i18n.T("update.unsupported", goos, goarch))
			}
			exe, err := os.Executable()
			if err == nil {
				exe, err = filepath.EvalSymlinks(exe)
			}
			if err != nil {
				return err
			}
			info("update.downloading", to, goos, goarch)
			bin, err := u.Fetch(ctx, update.Sources(server), target, goos, goarch, func(source string, err error) {
				info("update.source_failed", source)
			})
			if errors.Is(err, update.ErrChecksum) {
				return errors.New(i18n.T("update.checksum", update.ArchiveName(target, goos, goarch)))
			}
			if err != nil {
				return err
			}
			if err := update.Replace(exe, bin); err != nil {
				return errors.New(i18n.T("update.replace", exe, err))
			}
			info("update.done", from, to, exe)
			return result(map[string]any{"version": to, "previous": from, "path": exe, "updated": true})
		},
	}
	c.Flags().StringVar(&target, "version", "", i18n.T("flag.update_version"))
	c.Flags().BoolVar(&check, "check", false, i18n.T("flag.check"))
	c.Flags().BoolVar(&force, "force", false, i18n.T("flag.force"))
	return c
}
