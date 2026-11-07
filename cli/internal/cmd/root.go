// Package cmd implements the blift cobra command tree.
package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/davidliyutong/blift/cli/internal/api"
	"github.com/davidliyutong/blift/cli/internal/config"
	"github.com/davidliyutong/blift/cli/internal/i18n"
	"github.com/davidliyutong/blift/cli/internal/ui"
)

// Global flags.
var (
	flagServer string
	flagLang   string
	jsonOut    bool
	quiet      bool
	version    = "dev"
)

// Execute runs the CLI and returns the process exit code.
func Execute(v string) int {
	version = v
	api.UserAgent = "blift-cli/" + v
	i18n.Init(langFromArgs(os.Args[1:]))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() { <-ctx.Done(); stop() }() // a second Ctrl-C kills immediately

	err := newRoot().ExecuteContext(ctx)
	if err == nil {
		return 0
	}
	fmt.Fprintln(os.Stderr, i18n.T("error")+errMessage(err))
	if ctx.Err() != nil {
		return 130
	}
	return 1
}

// langFromArgs pre-scans --lang so that help texts are translated too.
func langFromArgs(args []string) string {
	for i, a := range args {
		if a == "--" {
			break
		}
		if v, ok := strings.CutPrefix(a, "--lang="); ok {
			return v
		}
		if a == "--lang" && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

func newRoot() *cobra.Command {
	root := &cobra.Command{
		Use:           "blift",
		Short:         i18n.T("cmd.root"),
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	pf := root.PersistentFlags()
	pf.StringVar(&flagServer, "server", "", i18n.T("flag.server"))
	pf.StringVar(&flagLang, "lang", "", i18n.T("flag.lang"))
	pf.BoolVar(&jsonOut, "json", false, i18n.T("flag.json"))
	pf.BoolVarP(&quiet, "quiet", "q", false, i18n.T("flag.quiet"))
	root.AddCommand(
		loginCmd(), logoutCmd(), whoamiCmd(), versionCmd(),
		projectCmd(), lsCmd(), uploadCmd(), downloadCmd(), rmCmd(), mvCmd(), urlCmd(),
		shareCmd(),
	)
	return root
}

// errMessage translates API error codes; other errors are printed as-is.
func errMessage(err error) string {
	var ae *api.Error
	if errors.As(err, &ae) {
		if msg, ok := i18n.Lookup("api." + ae.Code); ok {
			if ae.Message != "" && ae.Message != ae.Code {
				return msg + " (" + ae.Message + ")"
			}
			return msg
		}
		return ae.Error()
	}
	if errors.Is(err, context.Canceled) {
		return i18n.T("interrupted")
	}
	return err.Error()
}

// ---- session ----

func currentServer(cfg *config.Config) string {
	for _, s := range []string{flagServer, os.Getenv("BLIFT_SERVER"), cfg.Server} {
		if s != "" {
			return config.NormalizeServer(s)
		}
	}
	return ""
}

// client returns an authenticated API client. The saved token is only sent to the
// server it was issued for; BLIFT_TOKEN always wins.
func client() (*api.Client, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	server := currentServer(cfg)
	if server == "" {
		return nil, errors.New(i18n.T("no_server"))
	}
	token := os.Getenv("BLIFT_TOKEN")
	if token == "" && config.NormalizeServer(cfg.Server) == server {
		token = cfg.Token
	}
	if token == "" {
		return nil, errors.New(i18n.T("not_logged_in"))
	}
	return api.New(server, token), nil
}

// ---- output ----

// info prints a translated status line to stderr unless --quiet.
func info(key string, args ...any) {
	if !quiet {
		fmt.Fprintln(os.Stderr, i18n.T(key, args...))
	}
}

func warn(key string, args ...any) {
	fmt.Fprintln(os.Stderr, i18n.T("warning")+i18n.T(key, args...))
}

func printJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

func table(header []string, rows [][]string) {
	for i, h := range header {
		header[i] = strings.ToUpper(i18n.T(h))
	}
	ui.Table(os.Stdout, header, rows)
}

// kv prints translated key/value lines.
func kv(pairs ...string) {
	var rows [][]string
	for i := 0; i+1 < len(pairs); i += 2 {
		rows = append(rows, []string{i18n.T(pairs[i]) + ":", pairs[i+1]})
	}
	ui.Table(os.Stdout, nil, rows)
}

func progressEnabled() bool { return !quiet && ui.IsTTY(os.Stderr) }

func confirm(yes bool, key string, args ...any) bool {
	return yes || ui.Confirm(i18n.T(key, args...))
}

func strOr(s *string, def string) string {
	if s == nil || *s == "" {
		return def
	}
	return *s
}
