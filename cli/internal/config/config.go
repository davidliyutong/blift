// Package config stores the CLI login state in $XDG_CONFIG_HOME/blift/config.json.
package config

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/davidliyutong/blift/cli/internal/api"
)

type Config struct {
	Server string    `json:"server,omitempty"`
	Token  string    `json:"token,omitempty"`
	User   *api.User `json:"user,omitempty"`
}

func Path() string {
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".config")
	}
	return filepath.Join(dir, "blift", "config.json")
}

func Load() (*Config, error) {
	c := &Config{}
	data, err := os.ReadFile(Path())
	if errors.Is(err, fs.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return nil, err
	}
	return c, json.Unmarshal(data, c)
}

func (c *Config) Save() error {
	p := Path()
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(p, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Chmod(p, 0o600)
}

// NormalizeServer trims trailing slashes and defaults the scheme to https.
func NormalizeServer(s string) string {
	s = strings.TrimRight(strings.TrimSpace(s), "/")
	if s != "" && !strings.Contains(s, "://") {
		s = "https://" + s
	}
	return s
}
