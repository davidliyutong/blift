import { api, ApiError, type Blob as BlobInfo } from "@/api";

export type UploadStatus = "queued" | "uploading" | "completing" | "done" | "failed" | "canceled";

export interface UploadItem {
  id: string;
  projectId: string;
  projectName: string;
  file: File;
  name: string;
  total: number;
  loaded: number;
  status: UploadStatus;
  error?: unknown;
  blobId?: string;
}

type ConfirmOverwrite = (name: string) => Promise<boolean>;
type DoneListener = (projectId: string, blob: BlobInfo) => void;

const FILE_CONCURRENCY = 2;
const PART_CONCURRENCY = 4;
const PART_URL_BATCH = 50;
const MAX_RETRIES = 3;

class Canceled extends Error {}

/** Upload queue shared by the whole SPA, so uploads survive in-app navigation. */
class UploadManager {
  private items: UploadItem[] = [];
  private listeners = new Set<() => void>();
  private doneListeners = new Set<DoneListener>();
  private controllers = new Map<string, AbortController>();
  private running = 0;
  confirmOverwrite: ConfirmOverwrite = async () => false;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  snapshot = () => this.items;

  onDone(fn: DoneListener) {
    this.doneListeners.add(fn);
    return () => void this.doneListeners.delete(fn);
  }

  add(projectId: string, projectName: string, files: File[]) {
    const added = files.map<UploadItem>((file) => ({
      id: crypto.randomUUID(),
      projectId,
      projectName,
      file,
      name: file.name,
      total: file.size,
      loaded: 0,
      status: "queued",
    }));
    this.items = [...this.items, ...added];
    this.emit();
    this.pump();
  }

  cancel(id: string) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    if (item.status === "queued") this.patch(id, { status: "canceled" });
    this.controllers.get(id)?.abort();
  }

  clearFinished() {
    this.items = this.items.filter((i) => i.status === "queued" || i.status === "uploading" || i.status === "completing");
    this.emit();
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  private patch(id: string, p: Partial<UploadItem>) {
    this.items = this.items.map((i) => (i.id === id ? { ...i, ...p } : i));
    this.emit();
  }

  private pump() {
    while (this.running < FILE_CONCURRENCY) {
      const next = this.items.find((i) => i.status === "queued");
      if (!next) return;
      this.running++;
      this.patch(next.id, { status: "uploading" });
      this.run(next).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async run(item: UploadItem) {
    const ctrl = new AbortController();
    this.controllers.set(item.id, ctrl);
    let blobId: string | undefined;
    try {
      const contentType = item.file.type || "application/octet-stream";
      const body = { name: item.name, size: item.file.size, content_type: contentType };
      let init;
      try {
        init = await api.uploads.init(item.projectId, body);
      } catch (e) {
        if (!(e instanceof ApiError && e.code === "name_taken")) throw e;
        if (!(await this.confirmOverwrite(item.name))) throw new Canceled();
        init = await api.uploads.init(item.projectId, { ...body, overwrite: true });
      }
      blobId = init.blob_id;
      this.patch(item.id, { blobId });
      if (ctrl.signal.aborted) throw new Canceled();

      if (init.mode === "single") {
        await putWithRetry(init.url!, item.file, ctrl.signal, (loaded) => this.patch(item.id, { loaded }));
      } else {
        await this.multipart(item, blobId, init.part_size!, init.part_count!, ctrl.signal);
      }

      this.patch(item.id, { status: "completing", loaded: item.total });
      const blob = await api.uploads.complete(blobId);
      this.patch(item.id, { status: "done" });
      this.doneListeners.forEach((fn) => fn(item.projectId, blob));
    } catch (e) {
      const canceled = e instanceof Canceled || ctrl.signal.aborted;
      this.patch(item.id, canceled ? { status: "canceled" } : { status: "failed", error: e });
      if (blobId) api.uploads.abort(blobId).catch(() => undefined);
    } finally {
      this.controllers.delete(item.id);
    }
  }

  private async multipart(item: UploadItem, blobId: string, partSize: number, partCount: number, signal: AbortSignal) {
    const urls = new Map<number, string>();
    const progress = new Map<number, number>();
    let nextPart = 1;
    let fetching: Promise<void> | null = null;

    const urlFor = async (n: number) => {
      while (!urls.has(n)) {
        if (!fetching) {
          const from = n;
          const nums = Array.from({ length: Math.min(PART_URL_BATCH, partCount - from + 1) }, (_, i) => from + i);
          fetching = api.uploads
            .parts(blobId, nums)
            .then((r) => {
              for (const [k, v] of Object.entries(r.urls)) urls.set(Number(k), v);
            })
            .finally(() => (fetching = null));
        }
        await fetching;
      }
      return urls.get(n)!;
    };

    const report = () => {
      let loaded = 0;
      progress.forEach((v) => (loaded += v));
      this.patch(item.id, { loaded });
    };

    const worker = async () => {
      while (nextPart <= partCount) {
        if (signal.aborted) throw new Canceled();
        const n = nextPart++;
        const start = (n - 1) * partSize;
        const chunk = item.file.slice(start, Math.min(start + partSize, item.file.size));
        const url = await urlFor(n);
        await putWithRetry(url, chunk, signal, (loaded) => {
          progress.set(n, loaded);
          report();
        });
        urls.delete(n);
      }
    };

    await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, partCount) }, worker));
  }
}

async function putWithRetry(url: string, body: Blob, signal: AbortSignal, onProgress: (loaded: number) => void) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await xhrPut(url, body, signal, onProgress);
    } catch (e) {
      if (e instanceof Canceled || attempt >= MAX_RETRIES || (e as { retry?: boolean }).retry === false) throw e;
      onProgress(0);
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}

function xhrPut(url: string, body: Blob, signal: AbortSignal, onProgress: (loaded: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(body.size);
        resolve();
      } else {
        const err = Object.assign(new Error(`S3 ${xhr.status}: ${xhr.responseText.slice(0, 200)}`), {
          retry: xhr.status >= 500 || xhr.status === 408 || xhr.status === 429,
        });
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error("network error (check bucket CORS)"));
    xhr.onabort = () => reject(new Canceled());
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

export const uploads = new UploadManager();
