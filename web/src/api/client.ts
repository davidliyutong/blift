export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type Listener = (err: ApiError) => void;
const unauthorizedListeners = new Set<Listener>();

/** Subscribe to 401s from non-auth endpoints (session expired / revoked). */
export function onUnauthorized(fn: Listener) {
  unauthorizedListeners.add(fn);
  return () => void unauthorizedListeners.delete(fn);
}

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  init?: { headers?: Record<string, string>; quiet401?: boolean },
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...init?.headers };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch (e) {
    throw new ApiError(0, "network", (e as Error).message);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
    const e = new ApiError(res.status, err?.code ?? "internal", err?.message ?? res.statusText);
    if (res.status === 401 && !init?.quiet401 && (e.code === "unauthorized" || e.code === "mfa_required")) {
      unauthorizedListeners.forEach((fn) => fn(e));
    }
    throw e;
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export const http = {
  get: <T>(path: string, init?: Parameters<typeof request>[3]) => request<T>("GET", path, undefined, init),
  post: <T>(path: string, body?: unknown, init?: Parameters<typeof request>[3]) =>
    request<T>("POST", path, body ?? {}, init),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  del: <T = void>(path: string) => request<T>("DELETE", path),
};

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
