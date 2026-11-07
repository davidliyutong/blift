package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDeviceLoginPolling(t *testing.T) {
	polls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/cli/login":
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			if body["client_name"] != "blift-cli on test" {
				t.Errorf("client_name = %q", body["client_name"])
			}
			json.NewEncoder(w).Encode(CLILogin{DeviceCode: "dev1", UserCode: "ABCD-EFGH", Interval: 3, ExpiresIn: 600})
		case "/api/cli/login/poll":
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			if body["device_code"] != "dev1" {
				t.Errorf("device_code = %q", body["device_code"])
			}
			if polls++; polls < 3 {
				w.WriteHeader(http.StatusBadRequest)
				w.Write([]byte(`{"error":{"code":"authorization_pending","message":"pending"}}`))
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"token": "blift_tok", "user": map[string]any{"id": "u1", "username": "alice"}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	ctx := context.Background()
	dl, err := c.StartCLILogin(ctx, "blift-cli on test")
	if err != nil || dl.UserCode != "ABCD-EFGH" || dl.Interval != 3 {
		t.Fatalf("start: %+v %v", dl, err)
	}
	res, err := c.WaitCLILogin(ctx, dl.DeviceCode, time.Millisecond, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if res.Token != "blift_tok" || res.User.Username != "alice" || polls != 3 {
		t.Fatalf("got %+v after %d polls", res, polls)
	}
}

func TestDeviceLoginDenied(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":{"code":"access_denied","message":"denied"}}`))
	}))
	defer srv.Close()
	_, err := New(srv.URL, "").WaitCLILogin(context.Background(), "d", time.Millisecond, 0)
	if !IsCode(err, "access_denied") {
		t.Fatalf("want access_denied, got %v", err)
	}
	if e := err.(*Error); e.Status != 400 || e.Message != "denied" {
		t.Fatalf("bad error %+v", e)
	}
}

// Servers before v0.1.2 page by offset only and report total on every page.
func TestBlobsPagingOffsetServer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(401)
			return
		}
		off := r.URL.Query().Get("offset")
		page := map[string][]Blob{"": {{ID: "a"}, {ID: "b"}}, "2": {{ID: "c"}}}[off]
		json.NewEncoder(w).Encode(map[string]any{"blobs": page, "total": 3})
	}))
	defer srv.Close()
	blobs, err := New(srv.URL, "tok").Blobs(context.Background(), "p1", "name", "asc")
	if err != nil || len(blobs) != 3 || blobs[2].ID != "c" {
		t.Fatalf("got %+v %v", blobs, err)
	}
}

func TestListBlobsCursor(t *testing.T) {
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		seen = append(seen, q.Get("cursor")+"|"+q.Get("limit"))
		switch q.Get("cursor") {
		case "":
			json.NewEncoder(w).Encode(map[string]any{"blobs": []Blob{{ID: "a"}, {ID: "b"}}, "total": 5, "next_cursor": "c1"})
		case "c1":
			json.NewEncoder(w).Encode(map[string]any{"blobs": []Blob{{ID: "c"}, {ID: "d"}}, "next_cursor": "c2"})
		default:
			json.NewEncoder(w).Encode(map[string]any{"blobs": []Blob{{ID: "e"}}, "next_cursor": nil})
		}
	}))
	defer srv.Close()
	c := New(srv.URL, "tok")
	all, total, err := c.ListBlobs(context.Background(), "p1", BlobQuery{Sort: "name"}, 0)
	if err != nil || len(all) != 5 || total != 5 || all[4].ID != "e" {
		t.Fatalf("all: %+v total=%d %v", all, total, err)
	}
	seen = nil
	some, total, err := c.ListBlobs(context.Background(), "p1", BlobQuery{}, 3)
	if err != nil || len(some) != 3 || total != 5 {
		t.Fatalf("limited: %+v total=%d %v", some, total, err)
	}
	if strings.Join(seen, ",") != "|3,c1|1" {
		t.Fatalf("requests: %v", seen)
	}
}

func TestBlobsNamedChunks(t *testing.T) {
	var sizes []int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		names := r.URL.Query()["name"]
		sizes = append(sizes, len(names))
		var out []Blob
		for _, n := range names {
			if n != "missing" {
				out = append(out, Blob{ID: "id-" + n, Name: n})
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"blobs": out, "total": len(out)})
	}))
	defer srv.Close()
	names := []string{"missing"}
	for i := range 59 {
		names = append(names, fmt.Sprintf("f%02d", i))
	}
	got, err := New(srv.URL, "tok").BlobsNamed(context.Background(), "p1", names)
	if err != nil || len(got) != 59 || fmt.Sprint(sizes) != "[50 10]" {
		t.Fatalf("got %d blobs, request sizes %v, %v", len(got), sizes, err)
	}
}
