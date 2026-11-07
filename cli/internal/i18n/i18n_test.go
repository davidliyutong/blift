package i18n

import (
	"regexp"
	"testing"
)

func TestDetect(t *testing.T) {
	cases := []struct {
		flag string
		env  map[string]string
		want string
	}{
		{"", nil, "en"},
		{"zh", map[string]string{"BLIFT_LANG": "en"}, "zh"},
		{"en", map[string]string{"LANG": "zh_CN.UTF-8"}, "en"},
		{"", map[string]string{"BLIFT_LANG": "zh-CN", "LANG": "en_US.UTF-8"}, "zh"},
		{"", map[string]string{"LC_ALL": "en_US.UTF-8", "LANG": "zh_CN.UTF-8"}, "en"},
		{"", map[string]string{"LC_MESSAGES": "zh_TW.UTF-8", "LANG": "C"}, "zh"},
		{"", map[string]string{"LANG": "zh_CN.UTF-8"}, "zh"},
		{"", map[string]string{"LANG": "C.UTF-8"}, "en"},
		{"ZH", nil, "zh"},
	}
	for _, c := range cases {
		if got := Detect(c.flag, func(k string) string { return c.env[k] }); got != c.want {
			t.Errorf("Detect(%q, %v) = %q, want %q", c.flag, c.env, got, c.want)
		}
	}
}

func TestTables(t *testing.T) {
	verbs := regexp.MustCompile(`%(\[\d\])?[a-zA-Z]`)
	count := func(s string) map[string]int {
		m := map[string]int{}
		for _, v := range verbs.FindAllString(s, -1) {
			m[v[len(v)-1:]]++
		}
		return m
	}
	for k, e := range en {
		z, ok := zh[k]
		if !ok {
			t.Errorf("zh missing %q", k)
			continue
		}
		ce, cz := count(e), count(z)
		if len(ce) != len(cz) {
			t.Errorf("%q: format verbs differ: %q vs %q", k, e, z)
		}
		for v, n := range ce {
			if cz[v] != n {
				t.Errorf("%q: format verbs differ: %q vs %q", k, e, z)
			}
		}
	}
	for k := range zh {
		if _, ok := en[k]; !ok {
			t.Errorf("en missing %q", k)
		}
	}
}

func TestT(t *testing.T) {
	SetLang("zh")
	defer SetLang("en")
	if got := T("blob.deleted", 3, "p"); got != "✓ 已从 p 删除 3 个文件" {
		t.Errorf("got %q", got)
	}
	if got := T("no.such.key"); got != "no.such.key" {
		t.Errorf("got %q", got)
	}
}
