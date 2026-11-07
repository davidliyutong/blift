package api

// Object shapes from docs/API.md. Timestamps are unix milliseconds, sizes are bytes.

type User struct {
	ID          string  `json:"id"`
	Username    string  `json:"username"`
	Email       *string `json:"email"`
	DisplayName *string `json:"display_name"`
	Role        string  `json:"role"`
	QuotaBytes  int64   `json:"quota_bytes"`
	UsedBytes   int64   `json:"used_bytes"`
	TOTPEnabled bool    `json:"totp_enabled"`
	HasPassword bool    `json:"has_password"`
	OIDCLinked  bool    `json:"oidc_linked"`
	CreatedAt   int64   `json:"created_at"`
}

type UserRef struct {
	ID          string  `json:"id"`
	Username    string  `json:"username"`
	DisplayName *string `json:"display_name"`
	Email       *string `json:"email,omitempty"` // only in member / user search responses
}

type Project struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Owner       UserRef `json:"owner"`
	Role        string  `json:"role"`
	StorageID   string  `json:"storage_id"`
	StorageName string  `json:"storage_name"`
	UsedBytes   int64   `json:"used_bytes"`
	BlobCount   int64   `json:"blob_count"`
	CreatedAt   int64   `json:"created_at"`
	UpdatedAt   int64   `json:"updated_at"`
}

type Member struct {
	User      UserRef `json:"user"`
	Role      string  `json:"role"`
	CreatedAt int64   `json:"created_at"`
}

type Storage struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Provider  string `json:"provider"`
	IsDefault bool   `json:"is_default"`
}

type Blob struct {
	ID            string   `json:"id"`
	ProjectID     string   `json:"project_id"`
	Name          string   `json:"name"`
	Size          int64    `json:"size"`
	ContentType   string   `json:"content_type"`
	Uploader      *UserRef `json:"uploader"`
	DownloadCount int64    `json:"download_count"`
	CreatedAt     int64    `json:"created_at"`
	UpdatedAt     int64    `json:"updated_at"`
}

// BlobPage is one page of a project listing. Total is only reported for the first page.
type BlobPage struct {
	Blobs      []Blob `json:"blobs"`
	Total      *int   `json:"total"`
	NextCursor string `json:"next_cursor"`
}

type Share struct {
	ID            string  `json:"id"`
	Token         string  `json:"token"`
	URL           string  `json:"url"`
	ProjectID     string  `json:"project_id"`
	ProjectName   string  `json:"project_name"`
	BlobID        *string `json:"blob_id"`
	BlobName      *string `json:"blob_name"`
	HasPassword   bool    `json:"has_password"`
	ExpiresAt     *int64  `json:"expires_at"`
	MaxDownloads  *int64  `json:"max_downloads"`
	DownloadCount int64   `json:"download_count"`
	ViewCount     int64   `json:"view_count"`
	Creator       UserRef `json:"creator"`
	CreatedAt     int64   `json:"created_at"`
}

type CreateShare struct {
	ProjectID    string `json:"project_id"`
	BlobID       string `json:"blob_id,omitempty"`
	Password     string `json:"password,omitempty"`
	ExpiresIn    int64  `json:"expires_in,omitempty"` // seconds; 0 = never
	MaxDownloads int64  `json:"max_downloads,omitempty"`
}

type PublicShare struct {
	Share struct {
		Token         string `json:"token"`
		Kind          string `json:"kind"` // "blob" | "project"
		Name          string `json:"name"`
		HasPassword   bool   `json:"has_password"`
		Locked        bool   `json:"locked"`
		ExpiresAt     *int64 `json:"expires_at"`
		MaxDownloads  *int64 `json:"max_downloads"`
		DownloadCount int64  `json:"download_count"`
		Creator       string `json:"creator"`
		CreatedAt     int64  `json:"created_at"`
		FileCount     *int64 `json:"file_count,omitempty"`
		TotalBytes    *int64 `json:"total_bytes,omitempty"`
	} `json:"share"`
	Blobs      []PublicBlob `json:"blobs,omitempty"`
	NextCursor string       `json:"next_cursor,omitempty"`
}

type PublicBlob struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	ContentType string `json:"content_type"`
	CreatedAt   int64  `json:"created_at"`
}

type SignedURL struct {
	URL       string `json:"url"`
	ExpiresAt int64  `json:"expires_at"`
}

type UploadRequest struct {
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	ContentType string `json:"content_type"`
	Overwrite   bool   `json:"overwrite"`
}

type UploadInit struct {
	BlobID    string `json:"blob_id"`
	Mode      string `json:"mode"` // "single" | "multipart"
	URL       string `json:"url"`
	PartSize  int64  `json:"part_size"`
	PartCount int    `json:"part_count"`
	ExpiresAt int64  `json:"expires_at"`
}

type Part struct {
	PartNumber int    `json:"part_number"`
	ETag       string `json:"etag"`
}

type CLILogin struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURL         string `json:"verification_url"`
	VerificationURLComplete string `json:"verification_url_complete"`
	Interval                int    `json:"interval"`
	ExpiresIn               int    `json:"expires_in"`
}

type LoginResult struct {
	Token string `json:"token"`
	User  User   `json:"user"`
}
