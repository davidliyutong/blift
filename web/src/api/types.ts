// Mirrors docs/API.md — keep in sync.

export type Role = "admin" | "user";
export type ProjectRole = "owner" | "editor" | "viewer";

export interface User {
  id: string;
  username: string;
  email: string | null;
  display_name: string | null;
  role: Role;
  quota_bytes: number; // effective, -1 = unlimited
  used_bytes: number;
  totp_enabled: boolean;
  has_password: boolean;
  oidc_linked: boolean;
  created_at: number;
}

export interface UserRef {
  id: string;
  username: string;
  display_name: string | null;
}

export interface UserWithEmail extends UserRef {
  email: string | null;
}

export interface Info {
  name: string;
  version: string;
  setup_required: boolean;
  oidc_enabled: boolean;
  oidc_button_label: string;
  public_url: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  owner: UserRef;
  role: ProjectRole;
  storage_id: string;
  storage_name: string;
  used_bytes: number;
  blob_count: number;
  created_at: number;
  updated_at: number;
}

export interface Blob {
  id: string;
  project_id: string;
  name: string;
  size: number;
  content_type: string;
  uploader: UserRef | null;
  download_count: number;
  created_at: number;
  updated_at: number;
}

export interface Member {
  user: UserWithEmail;
  role: ProjectRole;
  created_at: number;
}

export interface Share {
  id: string;
  token: string;
  url: string;
  project_id: string;
  project_name: string;
  blob_id: string | null;
  blob_name: string | null;
  has_password: boolean;
  expires_at: number | null;
  max_downloads: number | null;
  download_count: number;
  view_count: number;
  creator: UserRef;
  created_at: number;
}

export interface Session {
  id: string;
  kind: "web" | "cli";
  name: string | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number;
  current: boolean;
}

export interface StorageSummary {
  id: string;
  name: string;
  provider: StorageProvider;
  is_default: boolean;
}

export type StorageProvider = "s3" | "r2" | "b2" | "rustfs" | "minio" | "other";

export interface UploadInit {
  blob_id: string;
  mode: "single" | "multipart";
  url?: string;
  part_size?: number;
  part_count?: number;
  expires_at: number;
}

export interface CliLoginRequest {
  user_code: string;
  client_name: string;
  status: "pending" | "approved" | "denied" | "consumed" | "expired" | string;
  created_at: number;
  expires_at: number;
}

export interface PublicShareInfo {
  share: {
    token: string;
    kind: "blob" | "project";
    name: string;
    has_password: boolean;
    locked: boolean;
    expires_at: number | null;
    max_downloads: number | null;
    download_count: number;
    creator: string;
    created_at: number;
    file_count?: number;
    total_bytes?: number;
  };
  blobs?: PublicBlob[];
  /** Set when a project share has more files than this page (pass it as `cursor`). */
  next_cursor?: string | null;
}

export interface PublicBlob {
  id: string;
  name: string;
  size: number;
  content_type: string;
  created_at: number;
}

// ---- admin ----

export interface AdminUser extends User {
  status: "active" | "disabled";
  quota_override: number | null;
  last_login_at: number | null;
  project_count: number;
}

export interface AdminStorage {
  id: string;
  name: string;
  provider: StorageProvider;
  endpoint: string;
  region: string;
  bucket: string;
  access_key_id: string;
  path_style: boolean;
  prefix: string;
  is_default: boolean;
  created_at: number;
  project_count: number;
  used_bytes: number;
}

export interface StorageInput {
  id?: string;
  name: string;
  provider: StorageProvider;
  endpoint: string;
  region: string;
  bucket: string;
  access_key_id: string;
  secret_access_key?: string;
  path_style: boolean;
  prefix: string;
  is_default: boolean;
}

export interface Settings {
  site: { name: string; default_quota_bytes: number };
  oidc: {
    enabled: boolean;
    issuer: string;
    client_id: string;
    client_secret_set: boolean;
    client_secret?: string;
    scopes: string;
    button_label: string;
    admin_group: string;
    redirect_uri: string;
  };
  gc: { pending_upload_ttl_hours: number };
}

export type SettingsPatch = {
  site?: Partial<Settings["site"]>;
  oidc?: Partial<Omit<Settings["oidc"], "client_secret_set" | "redirect_uri">>;
  gc?: Partial<Settings["gc"]>;
};

export interface StatsDay {
  day: string;
  requests: number;
  upload_bytes: number;
  download_bytes: number;
  uploads: number;
  downloads: number;
}

export interface Stats {
  totals: {
    users: number;
    projects: number;
    blobs: number;
    used_bytes: number;
    shares: number;
    storages: number;
  };
  series: StatsDay[];
  top_users: {
    id: string;
    username: string;
    display_name: string | null;
    used_bytes: number;
    quota_bytes: number;
  }[];
  storages: { id: string; name: string; used_bytes: number; blob_count: number }[];
  /** Top users by traffic in the period; id "" (username null) = anonymous requests. */
  top_traffic: {
    id: string;
    username: string | null;
    display_name: string | null;
    requests: number;
    upload_bytes: number;
    download_bytes: number;
  }[];
}

