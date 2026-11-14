package api

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

var esc = url.PathEscape

// ---- auth ----

func (c *Client) Me(ctx context.Context) (*User, error) {
	var r struct {
		User *User `json:"user"`
	}
	err := c.do(ctx, http.MethodGet, "/api/auth/me", nil, &r)
	return r.User, err
}

func (c *Client) Logout(ctx context.Context) error {
	return c.do(ctx, http.MethodPost, "/api/auth/logout", nil, nil)
}

func (c *Client) StartCLILogin(ctx context.Context, clientName string) (*CLILogin, error) {
	var r CLILogin
	return &r, c.do(ctx, http.MethodPost, "/api/cli/login", map[string]string{"client_name": clientName}, &r)
}

// LoginWithAPIKey exchanges an API key (Account → API keys) for a CLI session token.
func (c *Client) LoginWithAPIKey(ctx context.Context, key, clientName string) (*LoginResult, error) {
	var r LoginResult
	return &r, c.do(ctx, http.MethodPost, "/api/cli/login/api-key", map[string]string{"api_key": key, "client_name": clientName}, &r)
}

// WaitCLILogin polls the device-flow endpoint every interval until the request is
// approved, denied or older than timeout (0 = no client-side timeout).
func (c *Client) WaitCLILogin(ctx context.Context, deviceCode string, interval, timeout time.Duration) (*LoginResult, error) {
	deadline := time.Now().Add(timeout)
	for {
		select {
		case <-time.After(interval):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		var r LoginResult
		err := c.do(ctx, http.MethodPost, "/api/cli/login/poll", map[string]string{"device_code": deviceCode}, &r)
		if err == nil {
			return &r, nil
		}
		if !IsCode(err, "authorization_pending") {
			return nil, err
		}
		if timeout > 0 && time.Now().After(deadline) {
			return nil, &Error{Status: http.StatusBadRequest, Code: "expired_token", Message: "login request expired"}
		}
	}
}

// ---- projects ----

func (c *Client) Projects(ctx context.Context) ([]Project, error) {
	r := struct {
		Projects []Project `json:"projects"`
	}{Projects: []Project{}}
	err := c.do(ctx, http.MethodGet, "/api/projects", nil, &r)
	return r.Projects, err
}

func (c *Client) Project(ctx context.Context, id string) (*Project, error) {
	var p Project
	return &p, c.do(ctx, http.MethodGet, "/api/projects/"+esc(id), nil, &p)
}

func (c *Client) CreateProject(ctx context.Context, name, description, storageID string) (*Project, error) {
	body := map[string]string{"name": name}
	if description != "" {
		body["description"] = description
	}
	if storageID != "" {
		body["storage_id"] = storageID
	}
	var p Project
	return &p, c.do(ctx, http.MethodPost, "/api/projects", body, &p)
}

func (c *Client) UpdateProject(ctx context.Context, id string, patch map[string]string) (*Project, error) {
	var p Project
	return &p, c.do(ctx, http.MethodPatch, "/api/projects/"+esc(id), patch, &p)
}

func (c *Client) DeleteProject(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/api/projects/"+esc(id), nil, nil)
}

func (c *Client) Members(ctx context.Context, projectID string) ([]Member, error) {
	r := struct {
		Members []Member `json:"members"`
	}{Members: []Member{}}
	err := c.do(ctx, http.MethodGet, "/api/projects/"+esc(projectID)+"/members", nil, &r)
	return r.Members, err
}

func (c *Client) AddMember(ctx context.Context, projectID, user, role string) (*Member, error) {
	var m Member
	return &m, c.do(ctx, http.MethodPost, "/api/projects/"+esc(projectID)+"/members",
		map[string]string{"user": user, "role": role}, &m)
}

func (c *Client) RemoveMember(ctx context.Context, projectID, userID string) error {
	return c.do(ctx, http.MethodDelete, "/api/projects/"+esc(projectID)+"/members/"+esc(userID), nil, nil)
}

// SearchUsers finds active users by username, email or display name (≤ 10).
func (c *Client) SearchUsers(ctx context.Context, q string) ([]UserRef, error) {
	r := struct {
		Users []UserRef `json:"users"`
	}{Users: []UserRef{}}
	err := c.do(ctx, http.MethodGet, "/api/users/search?q="+url.QueryEscape(q), nil, &r)
	return r.Users, err
}

func (c *Client) Storages(ctx context.Context) ([]Storage, error) {
	var r struct {
		Storages []Storage `json:"storages"`
	}
	err := c.do(ctx, http.MethodGet, "/api/storages", nil, &r)
	return r.Storages, err
}

// ---- blobs ----

// BlobQuery selects blobs of a project; zero values mean the server defaults.
type BlobQuery struct {
	Q      string   // name contains
	Prefix string   // name starts with (case-insensitive)
	Names  []string // exact names, ≤ 50
	Sort   string   // name | size | created_at
	Order  string   // asc | desc
	Limit  int      // page size, ≤ 1000
	Cursor string   // next_cursor of the previous page
	offset int      // servers before v0.1.2 page by offset only
}

// BlobsPage fetches one page.
func (c *Client) BlobsPage(ctx context.Context, projectID string, q BlobQuery) (*BlobPage, error) {
	v := url.Values{}
	for k, s := range map[string]string{"q": q.Q, "prefix": q.Prefix, "sort": q.Sort, "order": q.Order, "cursor": q.Cursor} {
		if s != "" {
			v.Set(k, s)
		}
	}
	for _, n := range q.Names {
		v.Add("name", n)
	}
	if q.Limit > 0 {
		v.Set("limit", strconv.Itoa(q.Limit))
	}
	if q.offset > 0 {
		v.Set("offset", strconv.Itoa(q.offset))
	}
	p := BlobPage{Blobs: []Blob{}}
	return &p, c.do(ctx, http.MethodGet, "/api/projects/"+esc(projectID)+"/blobs?"+v.Encode(), nil, &p)
}

// ListBlobs pages through the matching blobs until max of them are collected (max ≤ 0: all).
// total is the number of matching blobs reported by the server (-1 if unknown).
func (c *Client) ListBlobs(ctx context.Context, projectID string, q BlobQuery, max int) (blobs []Blob, total int, err error) {
	blobs, total = []Blob{}, -1
	for {
		q.Limit = 1000
		if max > 0 {
			q.Limit = min(1000, max-len(blobs))
		}
		page, err := c.BlobsPage(ctx, projectID, q)
		if err != nil {
			return nil, total, err
		}
		if page.Total != nil && total < 0 {
			total = *page.Total
		}
		blobs = append(blobs, page.Blobs...)
		switch {
		case max > 0 && len(blobs) >= max:
			return blobs[:max], total, nil
		case len(page.Blobs) == 0:
			return blobs, total, nil
		case page.NextCursor != "":
			q.Cursor = page.NextCursor
		case page.Total != nil && len(blobs) < *page.Total && q.Cursor == "":
			q.offset = len(blobs) // an older server: offset paging
		default:
			return blobs, total, nil
		}
	}
}

// Blobs lists every blob of a project. sort is name|size|created_at, order asc|desc.
func (c *Client) Blobs(ctx context.Context, projectID, sort, order string) ([]Blob, error) {
	blobs, _, err := c.ListBlobs(ctx, projectID, BlobQuery{Sort: sort, Order: order}, 0)
	return blobs, err
}

// BlobsNamed returns the active blobs with exactly these names; missing names are skipped.
func (c *Client) BlobsNamed(ctx context.Context, projectID string, names []string) ([]Blob, error) {
	out := []Blob{}
	for start := 0; start < len(names); start += 50 {
		chunk := names[start:min(start+50, len(names))]
		page, err := c.BlobsPage(ctx, projectID, BlobQuery{Names: chunk, Limit: len(chunk)})
		if err != nil {
			return nil, err
		}
		out = append(out, page.Blobs...)
	}
	return out, nil
}

func (c *Client) Blob(ctx context.Context, id string) (*Blob, error) {
	var b Blob
	return &b, c.do(ctx, http.MethodGet, "/api/blobs/"+esc(id), nil, &b)
}

func (c *Client) RenameBlob(ctx context.Context, id, name string) (*Blob, error) {
	var b Blob
	return &b, c.do(ctx, http.MethodPatch, "/api/blobs/"+esc(id), map[string]string{"name": name}, &b)
}

// DeleteBlobs bulk-deletes blobs, one request of ≤ 100 ids at a time (the server's limit, which
// keeps each delete a short database write), and returns the number deleted.
func (c *Client) DeleteBlobs(ctx context.Context, projectID string, ids []string) (int, error) {
	total := 0
	for start := 0; start < len(ids); start += 100 {
		var r struct {
			Deleted int `json:"deleted"`
		}
		err := c.do(ctx, http.MethodPost, "/api/projects/"+esc(projectID)+"/blobs/delete",
			map[string][]string{"ids": ids[start:min(start+100, len(ids))]}, &r)
		if err != nil {
			return total, err
		}
		total += r.Deleted
	}
	return total, nil
}

func (c *Client) BlobURL(ctx context.Context, id string) (*SignedURL, error) {
	var u SignedURL
	return &u, c.do(ctx, http.MethodGet, "/api/blobs/"+esc(id)+"/download", nil, &u)
}

// ---- uploads ----

func (c *Client) InitUpload(ctx context.Context, projectID string, req UploadRequest) (*UploadInit, error) {
	var r UploadInit
	return &r, c.do(ctx, http.MethodPost, "/api/projects/"+esc(projectID)+"/uploads", req, &r)
}

// PartURLs returns presigned URLs keyed by part number (≤ 100 numbers per call).
func (c *Client) PartURLs(ctx context.Context, blobID string, numbers []int) (map[string]string, error) {
	var r struct {
		URLs map[string]string `json:"urls"`
	}
	err := c.do(ctx, http.MethodPost, "/api/uploads/"+esc(blobID)+"/parts", map[string][]int{"part_numbers": numbers}, &r)
	return r.URLs, err
}

func (c *Client) CompleteUpload(ctx context.Context, blobID string, parts []Part) (*Blob, error) {
	body := map[string]any{}
	if parts != nil {
		body["parts"] = parts
	}
	var b Blob
	return &b, c.do(ctx, http.MethodPost, "/api/uploads/"+esc(blobID)+"/complete", body, &b)
}

func (c *Client) AbortUpload(ctx context.Context, blobID string) error {
	return c.do(ctx, http.MethodDelete, "/api/uploads/"+esc(blobID), nil, nil)
}

// ---- shares ----

func (c *Client) Shares(ctx context.Context, projectID string) ([]Share, error) {
	path := "/api/shares"
	if projectID != "" {
		path += "?project_id=" + url.QueryEscape(projectID)
	}
	r := struct {
		Shares []Share `json:"shares"`
	}{Shares: []Share{}}
	err := c.do(ctx, http.MethodGet, path, nil, &r)
	return r.Shares, err
}

func (c *Client) CreateShare(ctx context.Context, req CreateShare) (*Share, error) {
	var s Share
	return &s, c.do(ctx, http.MethodPost, "/api/shares", req, &s)
}

func (c *Client) DeleteShare(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/api/shares/"+esc(id), nil, nil)
}

// ---- public shares (no login) ----

func accessHeader(access string) map[string]string {
	if access == "" {
		return nil
	}
	return map[string]string{"X-Share-Access": access}
}

// PublicShare fetches a share and the first page of its files (cursor: a later page).
func (c *Client) PublicShare(ctx context.Context, token, access, cursor string) (*PublicShare, error) {
	path := "/api/public/shares/" + esc(token)
	if cursor != "" {
		path += "?cursor=" + url.QueryEscape(cursor)
	}
	var s PublicShare
	return &s, c.doH(ctx, http.MethodGet, path, accessHeader(access), nil, &s)
}

func (c *Client) UnlockShare(ctx context.Context, token, password string) (string, error) {
	var r struct {
		AccessToken string `json:"access_token"`
	}
	err := c.do(ctx, http.MethodPost, "/api/public/shares/"+esc(token)+"/unlock", map[string]string{"password": password}, &r)
	return r.AccessToken, err
}

func (c *Client) PublicBlobURL(ctx context.Context, token, blobID, access string) (*SignedURL, error) {
	var u SignedURL
	return &u, c.doH(ctx, http.MethodGet, "/api/public/shares/"+esc(token)+"/blobs/"+esc(blobID)+"/download",
		accessHeader(access), nil, &u)
}

// ---- upload links (inboxes, no login) ----

func shareUploadPath(token, blobID string) string {
	p := "/api/public/shares/" + esc(token) + "/uploads"
	if blobID != "" {
		p += "/" + esc(blobID)
	}
	return p
}

func uploadTokenHeader(uploadToken string) map[string]string {
	return map[string]string{"X-Upload-Token": uploadToken}
}

// InitShareUpload starts an upload through an upload link (access unlocks a password-protected one).
func (c *Client) InitShareUpload(ctx context.Context, token, access string, req UploadRequest) (*ShareUploadInit, error) {
	var r ShareUploadInit
	return &r, c.doH(ctx, http.MethodPost, shareUploadPath(token, ""), accessHeader(access), req, &r)
}

func (c *Client) SharePartURLs(ctx context.Context, token, blobID, uploadToken string, numbers []int) (map[string]string, error) {
	var r struct {
		URLs map[string]string `json:"urls"`
	}
	err := c.doH(ctx, http.MethodPost, shareUploadPath(token, blobID)+"/parts", uploadTokenHeader(uploadToken),
		map[string][]int{"part_numbers": numbers}, &r)
	return r.URLs, err
}

func (c *Client) CompleteShareUpload(ctx context.Context, token, blobID, uploadToken string, parts []Part) (*ShareUploaded, error) {
	body := map[string]any{}
	if parts != nil {
		body["parts"] = parts
	}
	var r ShareUploaded
	return &r, c.doH(ctx, http.MethodPost, shareUploadPath(token, blobID)+"/complete", uploadTokenHeader(uploadToken), body, &r)
}

func (c *Client) AbortShareUpload(ctx context.Context, token, blobID, uploadToken string) error {
	return c.doH(ctx, http.MethodDelete, shareUploadPath(token, blobID), uploadTokenHeader(uploadToken), nil, nil)
}
