// Package api is a typed client for the blift HTTP API (docs/API.md).
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// UserAgent is sent with every API request; the CLI sets it to include its version.
var UserAgent = "blift-cli"

// Error is the API error body `{"error": {"code", "message"}}` plus the HTTP status.
type Error struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string {
	switch {
	case e.Message != "":
		return e.Message
	case e.Code != "":
		return e.Code
	}
	return fmt.Sprintf("HTTP %d", e.Status)
}

// IsCode reports whether err is an API error with the given code.
func IsCode(err error, code string) bool {
	var e *Error
	return errors.As(err, &e) && e.Code == code
}

type Client struct {
	Server string // e.g. https://files.example.com (no trailing slash)
	Token  string // bearer token, may be empty for public endpoints
	HTTP   *http.Client
}

func New(server, token string) *Client {
	return &Client{Server: strings.TrimRight(server, "/"), Token: token, HTTP: &http.Client{Timeout: time.Minute}}
}

func (c *Client) do(ctx context.Context, method, path string, in, out any) error {
	return c.doH(ctx, method, path, nil, in, out)
}

func (c *Client) doH(ctx context.Context, method, path string, hdr map[string]string, in, out any) error {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Server+path, body)
	if err != nil {
		return err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", UserAgent)
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		var e struct {
			Error *Error `json:"error"`
		}
		if json.Unmarshal(data, &e) == nil && e.Error != nil {
			e.Error.Status = resp.StatusCode
			return e.Error
		}
		msg := strings.TrimSpace(string(data))
		if len(msg) > 200 {
			msg = msg[:200]
		}
		return &Error{Status: resp.StatusCode, Message: strings.TrimSuffix(resp.Status+": "+msg, ": ")}
	}
	if out == nil || resp.StatusCode == http.StatusNoContent {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
