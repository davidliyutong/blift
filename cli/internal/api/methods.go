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

func (c *Client) Storages(ctx context.Context) ([]Storage, error) {
	var r struct {
		Storages []Storage `json:"storages"`
	}
	err := c.do(ctx, http.MethodGet, "/api/storages", nil, &r)
	return r.Storages, err
}

// ---- blobs ----

// Blobs lists every blob of a project, paging with limit/offset until done.
// sort is name|size|created_at, order asc|desc (empty = server default).
func (c *Client) Blobs(ctx context.Context, projectID, sort, order string) ([]Blob, error) {
	all := []Blob{}
	for {
		q := url.Values{"limit": {"100"}, "offset": {strconv.Itoa(len(all))}}
		if sort != "" {
			q.Set("sort", sort)
		}
		if order != "" {
			q.Set("order", order)
		}
		var page struct {
			Blobs []Blob `json:"blobs"`
			Total int    `json:"total"`
		}
		if err := c.do(ctx, http.MethodGet, "/api/projects/"+esc(projectID)+"/blobs?"+q.Encode(), nil, &page); err != nil {
			return nil, err
		}
		all = append(all, page.Blobs...)
		if len(page.Blobs) == 0 || len(all) >= page.Total {
			return all, nil
		}
	}
}

func (c *Client) RenameBlob(ctx context.Context, id, name string) (*Blob, error) {
	var b Blob
	return &b, c.do(ctx, http.MethodPatch, "/api/blobs/"+esc(id), map[string]string{"name": name}, &b)
}

// DeleteBlobs bulk-deletes blobs in batches of 500 and returns the number deleted.
func (c *Client) DeleteBlobs(ctx context.Context, projectID string, ids []string) (int, error) {
	total := 0
	for start := 0; start < len(ids); start += 500 {
		var r struct {
			Deleted int `json:"deleted"`
		}
		err := c.do(ctx, http.MethodPost, "/api/projects/"+esc(projectID)+"/blobs/delete",
			map[string][]string{"ids": ids[start:min(start+500, len(ids))]}, &r)
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

func (c *Client) PublicShare(ctx context.Context, token, access string) (*PublicShare, error) {
	var s PublicShare
	return &s, c.doH(ctx, http.MethodGet, "/api/public/shares/"+esc(token), accessHeader(access), nil, &s)
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
