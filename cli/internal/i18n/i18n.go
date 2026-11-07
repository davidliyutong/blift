// Package i18n holds the zh/en message tables for every human-facing CLI string.
package i18n

import (
	"fmt"
	"os"
	"strings"
)

var lang = "en"

// Init picks the language: flag > BLIFT_LANG > LC_ALL/LC_MESSAGES/LANG > en.
func Init(flag string) { lang = Detect(flag, os.Getenv) }

func Lang() string     { return lang }
func SetLang(l string) { lang = normalize(l) }

func Detect(flag string, getenv func(string) string) string {
	for _, v := range []string{flag, getenv("BLIFT_LANG"), getenv("LC_ALL"), getenv("LC_MESSAGES"), getenv("LANG")} {
		if v != "" {
			return normalize(v)
		}
	}
	return "en"
}

func normalize(v string) string {
	if strings.HasPrefix(strings.ToLower(v), "zh") {
		return "zh"
	}
	return "en"
}

// Lookup returns the message for key in the current language (falling back to English).
func Lookup(key string) (string, bool) {
	if lang == "zh" {
		if s, ok := zh[key]; ok {
			return s, true
		}
	}
	s, ok := en[key]
	return s, ok
}

// T formats the message for key with args (fmt verbs); unknown keys are returned as-is.
func T(key string, args ...any) string {
	s, ok := Lookup(key)
	if !ok {
		s = key
	}
	if len(args) > 0 {
		return fmt.Sprintf(s, args...)
	}
	return s
}
