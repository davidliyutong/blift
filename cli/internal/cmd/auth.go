package cmd

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"time"

	"github.com/spf13/cobra"

	"github.com/davidliyutong/blift/cli/internal/api"
	"github.com/davidliyutong/blift/cli/internal/config"
	"github.com/davidliyutong/blift/cli/internal/i18n"
	"github.com/davidliyutong/blift/cli/internal/ui"
)

func loginCmd() *cobra.Command {
	var noBrowser bool
	var token string
	c := &cobra.Command{
		Use:   "login",
		Short: i18n.T("cmd.login"),
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			server := currentServer(cfg)
			if server == "" {
				return errors.New(i18n.T("no_server"))
			}
			ctx, cl := cmd.Context(), api.New(server, token)
			var user *api.User
			if token != "" {
				if user, err = cl.Me(ctx); err != nil {
					return err
				}
			} else {
				res, err := deviceLogin(ctx, cl, !noBrowser)
				if err != nil {
					return err
				}
				token, user = res.Token, &res.User
			}
			cfg.Server, cfg.Token, cfg.User = server, token, user
			if err := cfg.Save(); err != nil {
				return err
			}
			if jsonOut {
				return printJSON(user)
			}
			info("login.ok", user.Username, server)
			return nil
		},
	}
	c.Flags().BoolVar(&noBrowser, "no-browser", false, i18n.T("flag.no_browser"))
	c.Flags().StringVar(&token, "token", "", i18n.T("flag.token"))
	return c
}

func deviceLogin(ctx context.Context, cl *api.Client, browser bool) (*api.LoginResult, error) {
	host, _ := os.Hostname()
	dl, err := cl.StartCLILogin(ctx, "blift-cli on "+host)
	if err != nil {
		return nil, err
	}
	// Always shown, even with --quiet: the user needs the code.
	fmt.Fprintln(os.Stderr, i18n.T("login.code", dl.UserCode))
	fmt.Fprintln(os.Stderr, i18n.T("login.url", dl.VerificationURLComplete))
	if browser {
		openBrowser(dl.VerificationURLComplete)
	}
	fmt.Fprintln(os.Stderr, i18n.T("login.waiting"))
	return cl.WaitCLILogin(ctx, dl.DeviceCode,
		time.Duration(max(dl.Interval, 1))*time.Second, time.Duration(dl.ExpiresIn)*time.Second)
}

func openBrowser(url string) {
	name := "xdg-open"
	if runtime.GOOS == "darwin" {
		name = "open"
	}
	if c := exec.Command(name, url); c.Start() == nil {
		go c.Wait()
	}
}

func logoutCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: i18n.T("cmd.logout"),
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			if cfg.Token == "" {
				info("logout.none")
				return nil
			}
			ctx, cancel := context.WithTimeout(cmd.Context(), 10*time.Second)
			defer cancel()
			_ = api.New(cfg.Server, cfg.Token).Logout(ctx) // best effort
			cfg.Token, cfg.User = "", nil
			if err := cfg.Save(); err != nil {
				return err
			}
			info("logout.ok", cfg.Server)
			return nil
		},
	}
}

func whoamiCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "whoami",
		Short: i18n.T("cmd.whoami"),
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cl, err := client()
			if err != nil {
				return err
			}
			u, err := cl.Me(cmd.Context())
			if err != nil {
				return err
			}
			if jsonOut {
				return printJSON(u)
			}
			quota := i18n.T("unlimited")
			if u.QuotaBytes >= 0 {
				quota = ui.Size(u.QuotaBytes)
			}
			kv("col.username", u.Username,
				"col.display_name", strOr(u.DisplayName, "-"),
				"col.email", strOr(u.Email, "-"),
				"col.role", u.Role,
				"col.usage", ui.Size(u.UsedBytes)+" / "+quota,
				"col.server", cl.Server)
			return nil
		},
	}
}

func versionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: i18n.T("cmd.version"),
		Args:  cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			if jsonOut {
				return printJSON(map[string]string{"version": version, "go": runtime.Version(), "os": runtime.GOOS, "arch": runtime.GOARCH})
			}
			fmt.Printf("blift %s (%s %s/%s)\n", version, runtime.Version(), runtime.GOOS, runtime.GOARCH)
			return nil
		},
	}
}
