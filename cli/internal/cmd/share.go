package cmd

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/davidliyutong/blift/cli/internal/api"
	"github.com/davidliyutong/blift/cli/internal/config"
	"github.com/davidliyutong/blift/cli/internal/i18n"
	"github.com/davidliyutong/blift/cli/internal/ui"
)

func shareCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "share",
		Aliases: []string{"shares"},
		Short:   i18n.T("cmd.share"),
	}
	c.AddCommand(shareCreateCmd(), shareLsCmd(), shareRmCmd(), shareGetCmd())
	return c
}

// parseExpires parses durations like 30m, 24h, 7d, 2w (and Go forms like 1h30m).
func parseExpires(s string) (time.Duration, error) {
	units := map[byte]time.Duration{'d': 24 * time.Hour, 'w': 7 * 24 * time.Hour}
	if s != "" {
		if u, ok := units[s[len(s)-1]]; ok {
			if n, err := strconv.Atoi(s[:len(s)-1]); err == nil && n > 0 {
				return time.Duration(n) * u, nil
			}
		}
	}
	d, err := time.ParseDuration(s)
	if err != nil || d <= 0 {
		return 0, errors.New(i18n.T("bad_duration", s))
	}
	return d, nil
}

// parseSize parses sizes like 500M, 10G, 1.5TiB or 4096 (bytes); units are powers of 1024.
func parseSize(s string) (int64, error) {
	u := strings.ToUpper(strings.TrimSpace(s))
	num, unit := u, ""
	if i := strings.IndexFunc(u, func(r rune) bool { return (r < '0' || r > '9') && r != '.' }); i >= 0 {
		num, unit = u[:i], strings.TrimSpace(u[i:])
	}
	mult, ok := map[string]float64{"": 1, "K": 1 << 10, "M": 1 << 20, "G": 1 << 30, "T": 1 << 40}[strings.TrimSuffix(strings.TrimSuffix(unit, "B"), "I")]
	n, err := strconv.ParseFloat(num, 64)
	if !ok || err != nil || n*mult < 1 {
		return 0, errors.New(i18n.T("bad_size", s))
	}
	return int64(n * mult), nil
}

func shareCreateCmd() *cobra.Command {
	var password, expires, maxSize string
	var maxDownloads, maxUploads int64
	var upload bool
	c := &cobra.Command{
		Use:               "create <project> [blob]",
		Short:             i18n.T("cmd.share.create"),
		Args:              cobra.RangeArgs(1, 2),
		ValidArgsFunction: completeArgs(completeProjects, completeBlobs, completeNothing),
		RunE: func(cmd *cobra.Command, args []string) error {
			// An upload link (inbox) covers the whole project and has its own limits.
			if upload && (len(args) == 2 || maxDownloads > 0) || !upload && (maxUploads > 0 || maxSize != "") {
				return errors.New(i18n.T("share.upload_flags"))
			}
			req := api.CreateShare{Password: password, MaxDownloads: maxDownloads, MaxUploads: maxUploads}
			if upload {
				req.Mode = "upload"
			}
			if maxSize != "" {
				n, err := parseSize(maxSize)
				if err != nil {
					return err
				}
				req.MaxUploadBytes = n
			}
			if expires != "" {
				d, err := parseExpires(expires)
				if err != nil {
					return err
				}
				req.ExpiresIn = int64(d / time.Second)
			}
			ctx := cmd.Context()
			c, p, err := projectWithClient(ctx, args[0])
			if err != nil {
				return err
			}
			req.ProjectID = p.ID
			if len(args) == 2 {
				blobs, err := resolveBlobs(ctx, c, p.ID, args[1:])
				if err != nil {
					return err
				}
				req.BlobID = blobs[0].ID
			}
			s, err := c.CreateShare(ctx, req)
			if err != nil || jsonOut {
				return orJSON(err, s)
			}
			fmt.Println(s.URL)
			if s.Mode == "upload" {
				info("share.created_upload", ui.TimePtr(s.ExpiresAt, i18n.T("never")))
				return nil
			}
			info("share.created", ui.TimePtr(s.ExpiresAt, i18n.T("never")))
			if s.DownloadURL != nil && !s.HasPassword {
				info("share.direct", *s.DownloadURL)
			}
			return nil
		},
	}
	c.Flags().StringVar(&password, "password", "", i18n.T("flag.share_password"))
	c.Flags().StringVar(&expires, "expires", "", i18n.T("flag.expires"))
	c.Flags().Int64Var(&maxDownloads, "max-downloads", 0, i18n.T("flag.max_downloads"))
	c.Flags().BoolVar(&upload, "upload", false, i18n.T("flag.upload_link"))
	c.Flags().Int64Var(&maxUploads, "max-uploads", 0, i18n.T("flag.max_uploads"))
	c.Flags().StringVar(&maxSize, "max-size", "", i18n.T("flag.max_size"))
	_ = c.RegisterFlagCompletionFunc("expires", fixed("1h", "1d", "7d", "30d"))
	return c
}

func shareLsCmd() *cobra.Command {
	return &cobra.Command{
		Use:               "ls [project]",
		Aliases:           []string{"list"},
		Short:             i18n.T("cmd.share.ls"),
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: completeArgs(completeProjects, completeNothing),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			c, err := client()
			if err != nil {
				return err
			}
			projectID := ""
			if len(args) == 1 {
				p, err := resolveProject(ctx, c, args[0])
				if err != nil {
					return err
				}
				projectID = p.ID
			}
			shares, err := c.Shares(ctx, projectID)
			if err != nil || jsonOut {
				return orJSON(err, shares)
			}
			rows := make([][]string, 0, len(shares))
			for _, s := range shares {
				target := s.ProjectName + "/" + strOr(s.BlobName, "*")
				pw := i18n.T("no")
				if s.HasPassword {
					pw = i18n.T("yes")
				}
				rows = append(rows, []string{s.ID, i18n.T("share.mode." + s.Mode), target, pw, ui.TimePtr(s.ExpiresAt, i18n.T("never")), shareUsage(s), s.URL})
			}
			table([]string{"col.id", "col.type", "col.target", "col.password", "col.expires", "col.usage", "col.url"}, rows)
			return nil
		},
	}
}

// shareUsage: downloads of a download link, files and bytes received by an upload link, each
// with its limit ("3/10", "2/10 · 1.2 GB/5.0 GB").
func shareUsage(s api.Share) string {
	of := func(n string, limit *int64, format func(int64) string) string {
		if limit != nil {
			n += "/" + format(*limit)
		}
		return n
	}
	count := func(n int64) string { return strconv.FormatInt(n, 10) }
	if s.Mode == "upload" {
		return of(count(s.UploadCount), s.MaxUploads, count) + " · " + of(ui.Size(s.UploadBytes), s.MaxUploadBytes, ui.Size)
	}
	return of(count(s.DownloadCount), s.MaxDownloads, count)
}

func shareRmCmd() *cobra.Command {
	return &cobra.Command{
		Use:               "rm <share-id>",
		Aliases:           []string{"delete"},
		Short:             i18n.T("cmd.share.rm"),
		Args:              cobra.ExactArgs(1),
		ValidArgsFunction: completeArgs(completeShares, completeNothing),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := client()
			if err != nil {
				return err
			}
			if err := c.DeleteShare(cmd.Context(), args[0]); err != nil {
				return err
			}
			info("share.deleted", args[0])
			return nil
		},
	}
}

// shareURLPath matches the path of a share link, [/prefix]/s/<token>, or of a direct link to one
// of its files, [/prefix]/s/<token>/<name>.
var shareURLPath = regexp.MustCompile(`^(.*)/s/([^/]+)(?:/([^/]+))?/?$`)

// parseShareRef accepts https://host[/prefix]/s/<token>[/<name>] or a bare token. name is the
// file of a direct link, else "".
func parseShareRef(ref, fallbackServer string) (server, token, name string, err error) {
	if !strings.Contains(ref, "://") {
		if fallbackServer == "" {
			return "", "", "", errors.New(i18n.T("no_server"))
		}
		return fallbackServer, ref, "", nil
	}
	u, err := url.Parse(ref)
	if err != nil {
		return "", "", "", err
	}
	m := shareURLPath.FindStringSubmatch(u.Path)
	if m == nil {
		return "", "", "", errors.New(i18n.T("share.bad_url", ref))
	}
	return u.Scheme + "://" + u.Host + m[1], m[2], m[3], nil
}

func shareGetCmd() *cobra.Command {
	var password, out string
	var jobs int
	c := &cobra.Command{
		Use:               "get <share-url-or-token> [blob...]",
		Short:             i18n.T("cmd.share.get"),
		Args:              cobra.MinimumNArgs(1),
		ValidArgsFunction: completeNothing,
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			server, token, name, err := parseShareRef(args[0], currentServer(cfg))
			if err != nil {
				return err
			}
			if name != "" && len(args) == 1 { // a direct link: just that file
				args = append(args, name)
			}
			ctx, c := cmd.Context(), api.New(server, "")
			sh, access, err := openShare(ctx, c, token, password)
			if err != nil {
				return err
			}
			blobs := sh.Blobs
			if len(args) > 1 {
				blobs = nil
				for _, a := range args[1:] {
					i := slices.IndexFunc(sh.Blobs, func(b api.PublicBlob) bool { return b.ID == a || b.Name == a })
					if i < 0 {
						return errors.New(i18n.T("blob.not_found", a))
					}
					blobs = append(blobs, sh.Blobs[i])
				}
			}
			info("share.opened", sh.Share.Name, sh.Share.Creator, len(sh.Blobs))
			items := make([]dlItem, 0, len(blobs))
			for _, b := range blobs {
				items = append(items, dlItem{ID: b.ID, Name: b.Name, Size: b.Size, url: func(ctx context.Context) (string, error) {
					u, err := c.PublicBlobURL(ctx, token, b.ID, access)
					if err != nil {
						return "", err
					}
					return u.URL, nil
				}})
			}
			return downloadItems(ctx, items, out, true, jobs)
		},
	}
	c.Flags().StringVar(&password, "password", "", i18n.T("flag.share_password"))
	c.Flags().StringVarP(&out, "output", "o", "", i18n.T("flag.output_dir"))
	c.Flags().IntVarP(&jobs, "jobs", "j", 4, i18n.T("flag.jobs"))
	return c
}

// openShare fetches a public share, unlocking it with the password (prompting on a
// terminal when none was given) if it is locked. It returns the X-Share-Access token.
func openShare(ctx context.Context, c *api.Client, token, password string) (*api.PublicShare, string, error) {
	sh, err := c.PublicShare(ctx, token, "", "")
	if err != nil {
		return nil, "", err
	}
	if sh.Share.Mode == "upload" {
		return nil, "", errors.New(i18n.T("share.is_upload"))
	}
	if !sh.Share.Locked {
		return sh, "", allShareFiles(ctx, c, token, "", sh)
	}
	if password == "" {
		if !ui.IsTTY(os.Stdin) {
			return nil, "", errors.New(i18n.T("share.need_password"))
		}
		if password, err = ui.ReadPassword(i18n.T("share.password_prompt")); err != nil {
			return nil, "", err
		}
	}
	access, err := c.UnlockShare(ctx, token, password)
	if err != nil {
		return nil, "", err
	}
	if sh, err = c.PublicShare(ctx, token, access, ""); err != nil {
		return nil, "", err
	}
	return sh, access, allShareFiles(ctx, c, token, access, sh)
}

// allShareFiles appends the remaining pages of a project share's file list.
func allShareFiles(ctx context.Context, c *api.Client, token, access string, sh *api.PublicShare) error {
	for cursor := sh.NextCursor; cursor != ""; {
		page, err := c.PublicShare(ctx, token, access, cursor)
		if err != nil {
			return err
		}
		sh.Blobs = append(sh.Blobs, page.Blobs...)
		cursor = page.NextCursor
	}
	sh.NextCursor = ""
	return nil
}
