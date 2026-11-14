import { http, qs, request } from "./client";
import type {
  AdminStorage,
  ApiKey,
  AdminUser,
  Blob,
  BlobPage,
  CliLoginRequest,
  Info,
  Member,
  Project,
  ProjectRole,
  PublicShareInfo,
  Session,
  Settings,
  SettingsPatch,
  Share,
  ShareMode,
  ShareUploadInit,
  Stats,
  StorageInput,
  StorageSummary,
  UploadInit,
  User,
  UserWithEmail,
} from "./types";

export * from "./types";
export { ApiError, onUnauthorized } from "./client";

const enc = encodeURIComponent;

export const api = {
  info: () => http.get<Info>("/api/info"),
  setup: (body: { secret: string; username: string; password: string; email?: string }) =>
    http.post<{ user: User }>("/api/setup", body),

  auth: {
    me: () => http.get<{ user: User; mfa_pending: boolean }>("/api/auth/me", { quiet401: true }),
    login: (username: string, password: string) =>
      http.post<{ user: User; mfa_required: boolean }>("/api/auth/login", { username, password }, { quiet401: true }),
    mfa: (code: string) => http.post<{ user: User }>("/api/auth/mfa", { code }, { quiet401: true }),
    logout: () => http.post<void>("/api/auth/logout"),
    oidcStartUrl: (redirect: string) => `/api/auth/oidc/start${qs({ redirect })}`,
    totpSetup: () => http.post<{ secret: string; otpauth_url: string }>("/api/auth/totp/setup"),
    totpEnable: (code: string) => http.post<void>("/api/auth/totp/enable", { code }),
    totpDisable: (code: string) => http.post<void>("/api/auth/totp/disable", { code }),
    password: (body: { current_password?: string; new_password: string }) =>
      http.post<void>("/api/auth/password", body),
    sessions: () => http.get<{ sessions: Session[] }>("/api/auth/sessions"),
    revokeSession: (id: string) => http.del(`/api/auth/sessions/${enc(id)}`),
    apiKeys: () => http.get<{ api_keys: ApiKey[] }>("/api/auth/api-keys"),
    createApiKey: (body: { name: string; max_uses?: number | null; expires_in?: number | null; session_ttl?: number | null }) =>
      http.post<ApiKey & { key: string }>("/api/auth/api-keys", body),
    deleteApiKey: (id: string, revokeSessions: boolean) =>
      http.del(`/api/auth/api-keys/${enc(id)}${qs({ revoke_sessions: revokeSessions ? 1 : undefined })}`),
  },

  cli: {
    get: (code: string) => http.get<CliLoginRequest>(`/api/cli/login/${enc(code)}`),
    approve: (code: string) => http.post<void>(`/api/cli/login/${enc(code)}/approve`),
    deny: (code: string) => http.post<void>(`/api/cli/login/${enc(code)}/deny`),
  },

  storages: () => http.get<{ storages: StorageSummary[] }>("/api/storages"),
  searchUsers: (q: string) => http.get<{ users: UserWithEmail[] }>(`/api/users/search${qs({ q })}`),

  projects: {
    list: () => http.get<{ projects: Project[] }>("/api/projects"),
    create: (body: { name: string; description?: string; storage_id?: string }) =>
      http.post<Project>("/api/projects", body),
    get: (id: string) => http.get<Project>(`/api/projects/${enc(id)}`),
    update: (id: string, body: { name?: string; description?: string }) =>
      http.patch<Project>(`/api/projects/${enc(id)}`, body),
    remove: (id: string) => http.del(`/api/projects/${enc(id)}`),
    members: (id: string) => http.get<{ members: Member[] }>(`/api/projects/${enc(id)}/members`),
    addMember: (id: string, user: string, role: ProjectRole) =>
      http.post<Member>(`/api/projects/${enc(id)}/members`, { user, role }),
    setMemberRole: (id: string, userId: string, role: ProjectRole) =>
      http.patch<Member>(`/api/projects/${enc(id)}/members/${enc(userId)}`, { role }),
    removeMember: (id: string, userId: string) => http.del(`/api/projects/${enc(id)}/members/${enc(userId)}`),
  },

  blobs: {
    /**
     * With `path` ("/" for the root: an empty value is not sent) or `parent_id`: one directory
     * (directories first, pages with `cursor`). Without:
     * all files of the project at every level (search; pages with `offset`, has `total`).
     */
    list: (
      projectId: string,
      p: {
        path?: string;
        parent_id?: string;
        q?: string;
        sort?: "name" | "size" | "created_at";
        order?: "asc" | "desc";
        limit?: number;
        offset?: number;
        cursor?: string;
      },
    ) => http.get<BlobPage>(`/api/projects/${enc(projectId)}/blobs${qs(p)}`),
    rename: (id: string, name: string) => http.patch<Blob>(`/api/blobs/${enc(id)}`, { name }),
    /** mkdir: `path` below the directory `parent_id` (null = root); `parents` works like mkdir -p. */
    mkdir: (projectId: string, body: { path: string; parent_id?: string | null; parents?: boolean }) =>
      http.post<Blob>(`/api/projects/${enc(projectId)}/dirs`, body),
    /** Moves into a directory (null = root) in requests of ≤ 100 ids, one after another. */
    move: async (projectId: string, ids: string[], parentId: string | null) => {
      let moved = 0;
      for (let i = 0; i < ids.length; i += 100) {
        const r = await http.post<{ moved: number }>(`/api/projects/${enc(projectId)}/blobs/move`, {
          ids: ids.slice(i, i + 100),
          parent_id: parentId,
        });
        moved += r.moved;
      }
      return { moved };
    },
    remove: (id: string) => http.del(`/api/blobs/${enc(id)}`),
    /** Deletes in requests of ≤ 100 ids, one after another (the server's per-request limit). */
    bulkDelete: async (projectId: string, ids: string[]) => {
      let deleted = 0;
      for (let i = 0; i < ids.length; i += 100) {
        const r = await http.post<{ deleted: number }>(`/api/projects/${enc(projectId)}/blobs/delete`, { ids: ids.slice(i, i + 100) });
        deleted += r.deleted;
      }
      return { deleted };
    },
    downloadHref: (id: string, inline = false) =>
      `/api/blobs/${enc(id)}/download${qs({ redirect: 1, inline: inline ? 1 : undefined })}`,
    downloadUrl: (id: string) => http.get<{ url: string; expires_at: number }>(`/api/blobs/${enc(id)}/download`),
  },

  uploads: {
    init: (
      projectId: string,
      body: { name: string; size: number; content_type?: string; overwrite?: boolean; parent_id?: string | null },
    ) =>
      http.post<UploadInit>(`/api/projects/${enc(projectId)}/uploads`, body),
    parts: (blobId: string, part_numbers: number[]) =>
      http.post<{ urls: Record<string, string>; expires_at: number }>(`/api/uploads/${enc(blobId)}/parts`, {
        part_numbers,
      }),
    complete: (blobId: string) => http.post<Blob>(`/api/uploads/${enc(blobId)}/complete`, {}),
    abort: (blobId: string) => http.del(`/api/uploads/${enc(blobId)}`),
  },

  shares: {
    list: (projectId?: string) => http.get<{ shares: Share[] }>(`/api/shares${qs({ project_id: projectId })}`),
    create: (body: {
      project_id: string;
      mode?: ShareMode;
      blob_id?: string;
      password?: string;
      expires_in?: number | null;
      max_downloads?: number | null;
      max_uploads?: number | null;
      max_upload_bytes?: number | null;
    }) => http.post<Share>("/api/shares", body),
    remove: (id: string) => http.del(`/api/shares/${enc(id)}`),
  },

  public: {
    share: (token: string, access?: string, page: { parent_id?: string; cursor?: string; limit?: number } = {}) =>
      http.get<PublicShareInfo>(`/api/public/shares/${enc(token)}${qs(page)}`, {
        headers: access ? { "X-Share-Access": access } : undefined,
      }),
    unlock: (token: string, password: string) =>
      http.post<{ access_token: string }>(`/api/public/shares/${enc(token)}/unlock`, { password }),
    downloadHref: (token: string, blobId: string, access?: string) =>
      `/api/public/shares/${enc(token)}/blobs/${enc(blobId)}/download${qs({ redirect: 1, access_token: access })}`,
    /** Anonymous uploads through an upload link (a share with mode "upload"); no login. */
    uploads: {
      init: (token: string, access: string | undefined, body: { name: string; size: number; content_type?: string }) =>
        http.post<ShareUploadInit>(`/api/public/shares/${enc(token)}/uploads`, body, {
          headers: access ? { "X-Share-Access": access } : undefined,
        }),
      parts: (token: string, blobId: string, uploadToken: string, part_numbers: number[]) =>
        http.post<{ urls: Record<string, string>; expires_at: number }>(
          `/api/public/shares/${enc(token)}/uploads/${enc(blobId)}/parts`,
          { part_numbers },
          { headers: { "X-Upload-Token": uploadToken } },
        ),
      complete: (token: string, blobId: string, uploadToken: string) =>
        http.post<{ name: string; size: number }>(
          `/api/public/shares/${enc(token)}/uploads/${enc(blobId)}/complete`,
          {},
          { headers: { "X-Upload-Token": uploadToken } },
        ),
      abort: (token: string, blobId: string, uploadToken: string) =>
        request<void>("DELETE", `/api/public/shares/${enc(token)}/uploads/${enc(blobId)}`, undefined, {
          headers: { "X-Upload-Token": uploadToken },
        }),
    },
  },

  admin: {
    stats: (days = 30) => http.get<Stats>(`/api/admin/stats${qs({ days })}`),
    users: (p: { q?: string; limit?: number; offset?: number }) =>
      http.get<{ users: AdminUser[]; total: number }>(`/api/admin/users${qs(p)}`),
    updateUser: (
      id: string,
      body: { role?: "admin" | "user"; status?: "active" | "disabled"; quota_bytes?: number | null },
    ) => http.patch<AdminUser>(`/api/admin/users/${enc(id)}`, body),
    resetMfa: (id: string) => http.post<void>(`/api/admin/users/${enc(id)}/reset-mfa`),
    deleteUser: (id: string) => http.del(`/api/admin/users/${enc(id)}`),
    projects: (p: { q?: string; limit?: number; offset?: number }) =>
      http.get<{ projects: Project[]; total: number }>(`/api/admin/projects${qs(p)}`),
    storages: () => http.get<{ storages: AdminStorage[] }>("/api/admin/storages"),
    createStorage: (body: StorageInput) => http.post<AdminStorage>("/api/admin/storages", body),
    updateStorage: (id: string, body: Partial<StorageInput>) =>
      http.patch<AdminStorage>(`/api/admin/storages/${enc(id)}`, body),
    deleteStorage: (id: string) => http.del(`/api/admin/storages/${enc(id)}`),
    testStorage: (body: Partial<StorageInput>) =>
      http.post<{ ok: boolean; latency_ms: number; error?: string }>("/api/admin/storages/test", body),
    applyCors: (id: string, origins?: string[]) =>
      http.post<{ ok: boolean; error?: string }>(`/api/admin/storages/${enc(id)}/cors`, { origins }),
    settings: () => http.get<Settings>("/api/admin/settings"),
    saveSettings: (body: SettingsPatch) => http.put<Settings>("/api/admin/settings", body),
    testOidc: (issuer: string) =>
      http.post<{ ok: boolean; error?: string; discovery?: Record<string, unknown> }>("/api/admin/oidc/test", {
        issuer,
      }),
    gc: () => http.post<{ result: Record<string, number> }>("/api/admin/gc"),
  },
};
