package cmd

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
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

func TestParseSize(t *testing.T) {
	for in, want := range map[string]int64{
		"4096": 4096, "500M": 500 << 20, "10G": 10 << 30, "10GB": 10 << 30, "1.5GiB": 3 << 29, "2t": 2 << 40, "1 K": 1024,
	} {
		if got, err := parseSize(in); err != nil || got != want {
			t.Errorf("parseSize(%q) = %v, %v", in, got, err)
		}
	}
	for _, in := range []string{"", "G", "0", "-1G", "10X", "1.2.3M"} {
		if _, err := parseSize(in); err == nil {
			t.Errorf("parseSize(%q) should fail", in)
		}
	}
}

func TestParseShareRef(t *testing.T) {
	cases := []struct{ ref, server, token, name string }{
		{"https://files.example.com/s/AbC123", "https://files.example.com", "AbC123", ""},
		{"https://example.com/blift/s/tok/", "https://example.com/blift", "tok", ""},
		{"https://files.example.com/s/AbC123/hello%20%E4%BD%A0%E5%A5%BD.txt", "https://files.example.com", "AbC123", "hello 你好.txt"},
		{"https://example.com/blift/s/tok/s", "https://example.com/blift", "tok", "s"},
		{"tok", "https://default", "tok", ""},
	}
	for _, c := range cases {
		s, tok, name, err := parseShareRef(c.ref, "https://default")
		if err != nil || s != c.server || tok != c.token || name != c.name {
			t.Errorf("parseShareRef(%q) = %q %q %q %v", c.ref, s, tok, name, err)
		}
	}
	for _, bad := range []string{"https://example.com/x", "https://example.com/s/", "https://example.com/s/tok/a/b"} {
		if _, _, _, err := parseShareRef(bad, ""); err == nil {
			t.Errorf("expected an error for %q", bad)
		}
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

func TestRefs(t *testing.T) {
	for arg, want := range map[string]ref{
		"demo":               {project: "demo", slash: true},
		"demo:":              {project: "demo", slash: true},
		"demo:docs/a.pdf":    {project: "demo", path: "docs/a.pdf"},
		"demo:/docs//2026/":  {project: "demo", path: "docs/2026", slash: true},
		"alice/demo:a b.txt": {project: "alice/demo", path: "a b.txt"},
	} {
		if got := parseRef(arg); got != want {
			t.Errorf("parseRef(%q) = %+v, want %+v", arg, got, want)
		}
	}
	for arg, want := range map[string]bool{
		"demo:": true, "demo:a/b": true, "alice/demo:x": true, "my-proj.v2:": true,
		"demo": false, "./a:b": false, "/tmp/x:y": false, "a/b/c:d": false, "C:\\x": true, ".hidden:x": false,
	} {
		if isRemote(arg) != want {
			t.Errorf("isRemote(%q) = %v, want %v", arg, !want, want)
		}
	}
	// The older form: a project, then paths from its root.
	got := refsOf([]string{"demo", "a.txt", "docs/b.txt", "docs/"})
	want := []ref{{project: "demo", path: "a.txt"}, {project: "demo", path: "docs/b.txt"}, {project: "demo", path: "docs", slash: true}}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Errorf("refsOf (older form) = %+v", got)
	}
	if got := refsOf([]string{"demo:a", "demo:b"}); len(got) != 2 || got[1] != (ref{project: "demo", path: "b"}) {
		t.Errorf("refsOf = %+v", got)
	}
	if baseOf("a/b/c") != "c" || dirOf("a/b/c") != "a/b" || dirOf("c") != "" {
		t.Error("baseOf / dirOf")
	}
}

func TestLocalTreeAndDestPath(t *testing.T) {
	i18n.SetLang("en")
	root := t.TempDir()
	src := filepath.Join(root, "photos")
	for _, d := range []string{"2026", "empty"} {
		if err := os.MkdirAll(filepath.Join(src, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{"a.txt", "2026/b.txt"} {
		if err := os.WriteFile(filepath.Join(src, f), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, _, err := localTree(src, false); err == nil || !strings.Contains(err.Error(), "use -r") {
		t.Errorf("directory without -r: %v", err)
	}
	where := func(files []upFile) string {
		var out []string
		for _, f := range files {
			out = append(out, cleanRemote(f.dir+"/"+f.name))
		}
		sort.Strings(out)
		return strings.Join(out, " ")
	}
	// A directory keeps its name; with a trailing slash only its contents are meant.
	files, dirs, _, err := localTree(src, true)
	sort.Strings(dirs)
	if err != nil || where(files) != "photos/2026/b.txt photos/a.txt" || strings.Join(dirs, " ") != "photos photos/2026 photos/empty" {
		t.Errorf("localTree = %q, %q, %v", where(files), dirs, err)
	}
	files, dirs, _, err = localTree(src+"/", true)
	sort.Strings(dirs)
	if err != nil || where(files) != "2026/b.txt a.txt" || strings.Join(dirs, " ") != "2026 empty" {
		t.Errorf("localTree (contents) = %q, %q, %v", where(files), dirs, err)
	}

	out := filepath.Join(root, "out")
	if got, err := destPath(out, "docs/2026/a.pdf", true); err != nil || got != filepath.Join(out, "docs", "2026", "a.pdf") {
		t.Errorf("destPath = %q, %v", got, err)
	}
	if st, err := os.Stat(filepath.Join(out, "docs", "2026")); err != nil || !st.IsDir() {
		t.Errorf("destPath did not create the directories: %v", err)
	}
	if got, err := destPath(filepath.Join(root, "renamed.pdf"), "a.pdf", false); err != nil || got != filepath.Join(root, "renamed.pdf") {
		t.Errorf("destPath (file name) = %q, %v", got, err)
	}
	for _, bad := range []string{"../x", "a/../../x", "a//b", "a\\b", ""} {
		if _, err := destPath(out, bad, true); err == nil {
			t.Errorf("destPath accepted %q", bad)
		}
	}
}
