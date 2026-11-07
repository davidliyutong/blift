package cmd

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/davidliyutong/blift/cli/internal/api"
	"github.com/davidliyutong/blift/cli/internal/i18n"
)

func TestResolveProject(t *testing.T) {
	i18n.SetLang("en")
	projects := []api.Project{
		{ID: "id1", Name: "data", Owner: api.UserRef{ID: "u1", Username: "alice"}},
		{ID: "id2", Name: "data", Owner: api.UserRef{ID: "u2", Username: "bob"}},
		{ID: "id3", Name: "logs", Owner: api.UserRef{ID: "u2", Username: "bob"}},
		{ID: "id4", Name: "id3", Owner: api.UserRef{ID: "u1", Username: "alice"}},
		{ID: "id5", Name: "shared", Owner: api.UserRef{ID: "u2", Username: "bob"}},
		{ID: "id6", Name: "shared", Owner: api.UserRef{ID: "u3", Username: "carol"}},
	}
	me := "u1"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/projects":
			json.NewEncoder(w).Encode(map[string]any{"projects": projects})
		case "/api/auth/me":
			json.NewEncoder(w).Encode(map[string]any{"user": map[string]string{"id": me, "username": "x"}, "mfa_pending": false})
		}
	}))
	defer srv.Close()
	c := api.New(srv.URL, "tok")
	ctx := context.Background()

	for arg, want := range map[string]string{
		"id3":      "id3", // exact id wins over a project named "id3"
		"logs":     "id3", // unique name
		"data":     "id1", // ambiguous name: prefer the one I own
		"bob/data": "id2", // owner/name
	} {
		p, err := resolveProject(ctx, c, arg)
		if err != nil || p.ID != want {
			t.Errorf("resolve %q = %v, %v; want %s", arg, p, err, want)
		}
	}

	_, err := resolveProject(ctx, c, "shared") // two matches, none mine
	if err == nil || !strings.Contains(err.Error(), "bob/shared (id5)") || !strings.Contains(err.Error(), "carol/shared (id6)") {
		t.Errorf("ambiguous: %v", err)
	}
	if _, err := resolveProject(ctx, c, "nope"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Errorf("missing: %v", err)
	}
}

func TestParseExpires(t *testing.T) {
	for in, want := range map[string]time.Duration{
		"7d": 7 * 24 * time.Hour, "24h": 24 * time.Hour, "30m": 30 * time.Minute,
		"2w": 14 * 24 * time.Hour, "1h30m": 90 * time.Minute,
	} {
		if got, err := parseExpires(in); err != nil || got != want {
			t.Errorf("parseExpires(%q) = %v, %v", in, got, err)
		}
	}
	for _, in := range []string{"", "d", "-1d", "7x", "0"} {
		if _, err := parseExpires(in); err == nil {
			t.Errorf("parseExpires(%q) should fail", in)
		}
	}
}

func TestParseShareRef(t *testing.T) {
	cases := []struct{ ref, server, token string }{
		{"https://files.example.com/s/AbC123", "https://files.example.com", "AbC123"},
		{"https://example.com/blift/s/tok/", "https://example.com/blift", "tok"},
		{"tok", "https://default", "tok"},
	}
	for _, c := range cases {
		s, tok, err := parseShareRef(c.ref, "https://default")
		if err != nil || s != c.server || tok != c.token {
			t.Errorf("parseShareRef(%q) = %q %q %v", c.ref, s, tok, err)
		}
	}
	if _, _, err := parseShareRef("https://example.com/x", ""); err == nil {
		t.Error("expected error for non-share URL")
	}
}

func TestErrMessage(t *testing.T) {
	i18n.SetLang("zh")
	defer i18n.SetLang("en")
	err := &api.Error{Status: 404, Code: "not_found", Message: "project not found"}
	if got := errMessage(err); got != "资源不存在 (project not found)" {
		t.Errorf("got %q", got)
	}
	if got := errMessage(&api.Error{Code: "weird", Message: "server says"}); got != "server says" {
		t.Errorf("unknown code fallback: %q", got)
	}
}

func TestLangFromArgs(t *testing.T) {
	if langFromArgs([]string{"ls", "--lang", "zh", "p"}) != "zh" || langFromArgs([]string{"--lang=en"}) != "en" ||
		langFromArgs([]string{"ls", "--", "--lang", "zh"}) != "" {
		t.Error("langFromArgs")
	}
}
