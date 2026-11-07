// Package update replaces the running blift binary with a published release.
//
// Releases are looked up and downloaded through the blift server first (it relays GitHub
// Releases, see /api/cli/latest and /api/cli/download), then from GitHub directly, the same
// order as install.sh. BLIFT_DOWNLOAD_URL selects a single mirror instead. Archives are checked
// against the release's SHA256SUMS before anything is replaced.
package update

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Releases is the GitHub releases page of the project.
const Releases = "https://github.com/davidliyutong/blift/releases"

// maxBinary bounds what is read from an archive (the binary is ~7 MB).
const maxBinary = 256 << 20

var ErrChecksum = errors.New("SHA-256 mismatch")

type Updater struct {
	HTTP      *http.Client
	UserAgent string
}

func New(userAgent string) *Updater {
	return &Updater{HTTP: &http.Client{Timeout: 5 * time.Minute}, UserAgent: userAgent}
}

// Sources lists the download bases to try, in order.
func Sources(server string) []string {
	if mirror := os.Getenv("BLIFT_DOWNLOAD_URL"); mirror != "" {
		return []string{strings.TrimRight(mirror, "/")}
	}
	var out []string
	if server != "" {
		out = append(out, strings.TrimRight(server, "/")+"/api/cli/download")
	}
	return append(out, Releases+"/download")
}

func (u *Updater) get(ctx context.Context, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", u.UserAgent)
	return u.HTTP.Do(req)
}

var tagRE = regexp.MustCompile(`/releases/tag/v(\d+\.\d+\.\d+[0-9A-Za-z.-]*)$`)

// Latest returns the version (without "v") of the latest release: asked from the blift server
// when there is one, else read from GitHub's /releases/latest redirect.
func (u *Updater) Latest(ctx context.Context, server string) (string, error) {
	var errs []error
	if server != "" {
		v, err := u.latestFromServer(ctx, server)
		if err == nil {
			return v, nil
		}
		errs = append(errs, err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, Releases+"/latest", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", u.UserAgent)
	noFollow := *u.HTTP
	noFollow.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	res, err := noFollow.Do(req)
	if err == nil {
		res.Body.Close()
		if m := tagRE.FindStringSubmatch(res.Header.Get("Location")); m != nil {
			return m[1], nil
		}
		err = fmt.Errorf("GitHub answered HTTP %d without a release tag", res.StatusCode)
	}
	return "", errors.Join(append(errs, err)...)
}

func (u *Updater) latestFromServer(ctx context.Context, server string) (string, error) {
	res, err := u.get(ctx, strings.TrimRight(server, "/")+"/api/cli/latest")
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var r struct {
		Version string `json:"version"`
	}
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s: HTTP %d", server, res.StatusCode)
	}
	if err := json.NewDecoder(res.Body).Decode(&r); err != nil || r.Version == "" {
		return "", fmt.Errorf("%s: no version in the answer", server)
	}
	return r.Version, nil
}

// ArchiveName is the release archive of a version for a platform.
func ArchiveName(version, goos, goarch string) string {
	return fmt.Sprintf("blift_%s_%s_%s.tar.gz", version, goos, goarch)
}

// Fetch downloads the archive for version/goos/goarch from the first source that serves it and
// its SHA256SUMS, verifies it and returns the blift binary inside. onSkip is told about each
// source that failed before a later one is tried.
func (u *Updater) Fetch(ctx context.Context, sources []string, version, goos, goarch string, onSkip func(source string, err error)) ([]byte, error) {
	name := ArchiveName(version, goos, goarch)
	var lastErr error
	for i, base := range sources {
		archive, sums, err := u.download(ctx, base+"/v"+version, name)
		if err == nil {
			if err = verify(archive, sums, name); err != nil {
				return nil, err // a bad checksum is never retried from elsewhere
			}
			return extract(archive, strings.TrimSuffix(name, ".tar.gz"))
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		lastErr = err
		if i < len(sources)-1 && onSkip != nil {
			onSkip(base, err)
		}
	}
	return nil, lastErr
}

func (u *Updater) download(ctx context.Context, base, name string) (archive, sums []byte, err error) {
	if archive, err = u.read(ctx, base+"/"+name, maxBinary); err != nil {
		return nil, nil, err
	}
	if sums, err = u.read(ctx, base+"/SHA256SUMS", 1<<20); err != nil {
		return nil, nil, err
	}
	return archive, sums, nil
}

func (u *Updater) read(ctx context.Context, url string, limit int64) ([]byte, error) {
	res, err := u.get(ctx, url)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: HTTP %d", url, res.StatusCode)
	}
	return io.ReadAll(io.LimitReader(res.Body, limit))
}

func verify(archive, sums []byte, name string) error {
	sum := sha256.Sum256(archive)
	got := hex.EncodeToString(sum[:])
	for _, line := range strings.Split(string(sums), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name {
			if strings.EqualFold(f[0], got) {
				return nil
			}
			break
		}
	}
	return fmt.Errorf("%w: %s", ErrChecksum, name)
}

// extract returns <dir>/blift from a .tar.gz archive.
func extract(archive []byte, dir string) ([]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil, fmt.Errorf("%s/blift not found in the archive", dir)
		}
		if err != nil {
			return nil, err
		}
		if h.Typeflag == tar.TypeReg && path.Clean(h.Name) == dir+"/blift" {
			return io.ReadAll(io.LimitReader(tr, maxBinary))
		}
	}
}

// Replace swaps the file at exe for data: written next to it, then renamed over it, so the
// binary is either the old one or the complete new one. A running process keeps its old copy.
func Replace(exe string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(exe), ".blift-update-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	_, err = f.Write(data)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(tmp, 0o755)
	}
	if err == nil {
		err = os.Rename(tmp, exe)
	}
	if err != nil {
		os.Remove(tmp)
	}
	return err
}

// Compare compares two versions by their leading MAJOR.MINOR.PATCH ("v" optional); anything
// after it ("-3-gabc", "-dirty") is ignored. Unparsable versions (e.g. "dev") sort lowest.
func Compare(a, b string) int {
	pa, pb := parse(a), parse(b)
	for i := range pa {
		if pa[i] != pb[i] {
			if pa[i] < pb[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

var versionRE = regexp.MustCompile(`^v?(\d+)\.(\d+)\.(\d+)`)

func parse(v string) [3]int {
	m := versionRE.FindStringSubmatch(v)
	if m == nil {
		return [3]int{-1, -1, -1}
	}
	var out [3]int
	for i := range out {
		out[i], _ = strconv.Atoi(m[i+1])
	}
	return out
}
