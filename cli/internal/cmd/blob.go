package cmd

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/davidliyutong/blift/cli/internal/api"
	"github.com/davidliyutong/blift/cli/internal/i18n"
	"github.com/davidliyutong/blift/cli/internal/transfer"
	"github.com/davidliyutong/blift/cli/internal/ui"
)

func lsCmd() *cobra.Command {
	var sortBy string
	c := &cobra.Command{
		Use:     "ls <project>",
		Aliases: []string{"list"},
		Short:   i18n.T("cmd.ls"),
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			sorts := map[string][2]string{"name": {"name", "asc"}, "size": {"size", "desc"}, "time": {"created_at", "desc"}}
			s, ok := sorts[sortBy]
			if !ok {
				return errors.New(i18n.T("bad_sort", sortBy))
			}
			c, p, err := projectWithClient(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			blobs, err := c.Blobs(cmd.Context(), p.ID, s[0], s[1])
			if err != nil || jsonOut {
				return orJSON(err, blobs)
			}
			var total int64
			rows := make([][]string, 0, len(blobs))
			for _, b := range blobs {
				uploader := "-"
				if b.Uploader != nil {
					uploader = b.Uploader.Username
				}
				rows = append(rows, []string{b.Name, ui.Size(b.Size), ui.Time(b.CreatedAt), uploader, b.ID})
				total += b.Size
			}
			table([]string{"col.name", "col.size", "col.created", "col.uploader", "col.id"}, rows)
			info("ls.summary", len(blobs), ui.Size(total))
			return nil
		},
	}
	c.Flags().StringVar(&sortBy, "sort", "name", i18n.T("flag.sort"))
	return c
}

func uploadCmd() *cobra.Command {
	var name string
	var overwrite bool
	var jobs int
	c := &cobra.Command{
		Use:     "upload <project> <file>...",
		Aliases: []string{"up", "push"},
		Short:   i18n.T("cmd.upload"),
		Long:    i18n.T("cmd.upload.long"),
		Args:    cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			files, err := expandFiles(args[1:])
			if err != nil {
				return err
			}
			if name != "" && len(files) != 1 {
				return errors.New(i18n.T("upload.name_multi"))
			}
			ctx := cmd.Context()
			c, p, err := projectWithClient(ctx, args[0])
			if err != nil {
				return err
			}
			done, failed := []*api.Blob{}, 0
			for _, f := range files {
				label := name
				if label == "" {
					label = filepath.Base(f.path)
				}
				bar := ui.NewBar(label, f.size, progressEnabled())
				b, err := transfer.Upload(ctx, c, p.ID, f.path, transfer.UploadOptions{Name: name, Overwrite: overwrite, Jobs: jobs, Progress: bar})
				bar.Finish()
				if ctx.Err() != nil {
					return ctx.Err()
				}
				if err != nil {
					msg := errMessage(err)
					if api.IsCode(err, "name_taken") {
						msg += " — " + i18n.T("upload.hint_overwrite")
					}
					fmt.Fprintln(os.Stderr, i18n.T("error")+f.path+": "+msg)
					failed++
					continue
				}
				done = append(done, b)
				info("upload.ok", b.Name, ui.Size(b.Size), p.Name)
			}
			if jsonOut {
				if err := printJSON(done); err != nil {
					return err
				}
			}
			if failed > 0 {
				return errors.New(i18n.T("failed_count", failed, len(files)))
			}
			return nil
		},
	}
	c.Flags().StringVar(&name, "name", "", i18n.T("flag.name"))
	c.Flags().BoolVar(&overwrite, "overwrite", false, i18n.T("flag.overwrite"))
	c.Flags().IntVarP(&jobs, "jobs", "j", 4, i18n.T("flag.jobs"))
	return c
}

type localFile struct {
	path string
	size int64
}

// expandFiles checks the upload arguments. Directories contribute their regular
// files (non-recursively, with a warning) since blift has no folders.
func expandFiles(args []string) ([]localFile, error) {
	var out []localFile
	for _, a := range args {
		st, err := os.Stat(a)
		if err != nil {
			return nil, err
		}
		if !st.IsDir() {
			if !st.Mode().IsRegular() {
				return nil, errors.New(i18n.T("upload.not_regular", a))
			}
			out = append(out, localFile{a, st.Size()})
			continue
		}
		entries, err := os.ReadDir(a)
		if err != nil {
			return nil, err
		}
		n, skipped := 0, 0
		for _, e := range entries {
			p := filepath.Join(a, e.Name())
			if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() {
				out = append(out, localFile{p, fi.Size()})
				n++
			} else {
				skipped++
			}
		}
		warn("upload.dir", a, n, skipped)
	}
	return out, nil
}

func downloadCmd() *cobra.Command {
	var out string
	var all bool
	var jobs int
	c := &cobra.Command{
		Use:     "download <project> [blob...]",
		Aliases: []string{"dl", "pull"},
		Short:   i18n.T("cmd.download"),
		Args:    cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if all == (len(args) > 1) {
				return errors.New(i18n.T("download.which"))
			}
			ctx := cmd.Context()
			c, p, err := projectWithClient(ctx, args[0])
			if err != nil {
				return err
			}
			var blobs []api.Blob
			if all {
				blobs, err = c.Blobs(ctx, p.ID, "name", "asc")
			} else {
				blobs, err = resolveBlobs(ctx, c, p.ID, args[1:])
			}
			if err != nil {
				return err
			}
			items := make([]dlItem, 0, len(blobs))
			for _, b := range blobs {
				items = append(items, dlItem{ID: b.ID, Name: b.Name, Size: b.Size, url: func(ctx context.Context) (string, error) {
					u, err := c.BlobURL(ctx, b.ID)
					if err != nil {
						return "", err
					}
					return u.URL, nil
				}})
			}
			return downloadItems(ctx, items, out, all || len(items) > 1, jobs)
		},
	}
	c.Flags().StringVarP(&out, "output", "o", "", i18n.T("flag.output"))
	c.Flags().BoolVar(&all, "all", false, i18n.T("flag.all"))
	c.Flags().IntVarP(&jobs, "jobs", "j", 4, i18n.T("flag.jobs"))
	return c
}

type dlItem struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Size int64  `json:"size"`
	Path string `json:"path"`
	url  func(context.Context) (string, error)
}

// downloadItems downloads each item to out (a directory when dir is set or out is an
// existing directory, otherwise a file path), continuing past per-file errors.
func downloadItems(ctx context.Context, items []dlItem, out string, dir bool, jobs int) error {
	done, failed := []dlItem{}, 0
	for _, it := range items {
		err := func() error {
			dest, err := destPath(out, it.Name, dir)
			if err != nil {
				return err
			}
			u, err := it.url(ctx)
			if err != nil {
				return err
			}
			bar := ui.NewBar(it.Name, it.Size, progressEnabled())
			defer bar.Finish()
			it.Path = dest
			return transfer.Download(ctx, u, it.Size, dest, jobs, bar)
		}()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, i18n.T("error")+it.Name+": "+errMessage(err))
			failed++
			continue
		}
		done = append(done, it)
		info("download.ok", it.Name, ui.Size(it.Size), it.Path)
	}
	if jsonOut {
		if err := printJSON(done); err != nil {
			return err
		}
	}
	if failed > 0 {
		return errors.New(i18n.T("failed_count", failed, len(items)))
	}
	return nil
}

func destPath(out, name string, dir bool) (string, error) {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\`) {
		return "", errors.New(i18n.T("download.bad_name", name))
	}
	if out == "" {
		return name, nil
	}
	if st, err := os.Stat(out); dir || (err == nil && st.IsDir()) || strings.HasSuffix(out, string(os.PathSeparator)) {
		if err := os.MkdirAll(out, 0o755); err != nil {
			return "", err
		}
		return filepath.Join(out, name), nil
	}
	return out, nil
}

func rmCmd() *cobra.Command {
	var yes bool
	c := &cobra.Command{
		Use:     "rm <project> <blob>...",
		Aliases: []string{"delete"},
		Short:   i18n.T("cmd.rm"),
		Args:    cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			c, p, err := projectWithClient(ctx, args[0])
			if err != nil {
				return err
			}
			blobs, err := resolveBlobs(ctx, c, p.ID, args[1:])
			if err != nil {
				return err
			}
			if !confirm(yes, "blob.confirm_rm", len(blobs), p.Name) {
				return errors.New(i18n.T("aborted"))
			}
			ids := make([]string, len(blobs))
			for i, b := range blobs {
				ids[i] = b.ID
			}
			n, err := c.DeleteBlobs(ctx, p.ID, ids)
			if err != nil || jsonOut {
				return orJSON(err, map[string]int{"deleted": n})
			}
			info("blob.deleted", n, p.Name)
			return nil
		},
	}
	c.Flags().BoolVarP(&yes, "yes", "y", false, i18n.T("flag.yes"))
	return c
}

func mvCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "mv <project> <blob> <new-name>",
		Aliases: []string{"rename"},
		Short:   i18n.T("cmd.mv"),
		Args:    cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			c, p, err := projectWithClient(ctx, args[0])
			if err != nil {
				return err
			}
			blobs, err := resolveBlobs(ctx, c, p.ID, args[1:2])
			if err != nil {
				return err
			}
			b, err := c.RenameBlob(ctx, blobs[0].ID, args[2])
			if err != nil || jsonOut {
				return orJSON(err, b)
			}
			info("blob.renamed", blobs[0].Name, b.Name)
			return nil
		},
	}
}

func urlCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "url <project> <blob>",
		Short: i18n.T("cmd.url"),
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			c, p, err := projectWithClient(ctx, args[0])
			if err != nil {
				return err
			}
			blobs, err := resolveBlobs(ctx, c, p.ID, args[1:2])
			if err != nil {
				return err
			}
			u, err := c.BlobURL(ctx, blobs[0].ID)
			if err != nil || jsonOut {
				return orJSON(err, u)
			}
			fmt.Println(u.URL)
			info("url.expires", ui.Time(u.ExpiresAt))
			return nil
		},
	}
}
