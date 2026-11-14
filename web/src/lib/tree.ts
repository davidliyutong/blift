// Uploading folders: the files of a drop or of a folder picker, each with the directory it sits
// in, and creating those directories before the files are queued.
import { api } from "@/api";
import { uploads } from "./upload";

/** A file to upload and its directory relative to where it was dropped ("" or "photos/2026"). */
export interface TreeFile {
  file: File;
  dir: string;
}

type Dir = { id: string | null; path: string };

const fileOf = (e: FileSystemFileEntry) => new Promise<File>((resolve, reject) => e.file(resolve, reject));

/** readEntries returns a directory in batches; an empty batch ends it. */
async function entriesOf(e: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = e.createReader();
  const out: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return out;
    out.push(...batch);
  }
}

async function walk(e: FileSystemEntry, dir: string, out: TreeFile[]) {
  if (e.isFile) out.push({ file: await fileOf(e as FileSystemFileEntry), dir });
  else if (e.isDirectory)
    for (const child of await entriesOf(e as FileSystemDirectoryEntry)) await walk(child, dir ? `${dir}/${e.name}` : e.name, out);
}

/**
 * The files of a drop, folders included. Call it synchronously in the drop handler: the entries
 * of a DataTransfer are gone after the first await.
 */
export function droppedFiles(dt: DataTransfer): Promise<TreeFile[]> {
  const entries = Array.from(dt.items)
    .filter((i) => i.kind === "file")
    .map((i) => i.webkitGetAsEntry?.() ?? null);
  const plain = Array.from(dt.files);
  if (entries.some((e) => e === null)) return Promise.resolve(plain.map((file) => ({ file, dir: "" })));
  return (async () => {
    const out: TreeFile[] = [];
    for (const e of entries) await walk(e!, "", out);
    return out;
  })();
}

/** The files of an `<input type="file" webkitdirectory>`. */
export const pickedFolder = (files: FileList): TreeFile[] =>
  Array.from(files).map((file) => ({ file, dir: file.webkitRelativePath.split("/").slice(0, -1).join("/") }));

/**
 * Queues files for the directory `into` of a project, creating the directories they sit in
 * first (one request per directory, like mkdir -p).
 */
export async function uploadTree(project: { id: string; name: string }, into: Dir, files: TreeFile[]) {
  const byDir = new Map<string, File[]>();
  for (const f of files) byDir.set(f.dir, [...(byDir.get(f.dir) ?? []), f.file]);
  for (const [dir, group] of [...byDir].sort(([a], [b]) => a.localeCompare(b))) {
    let target = into;
    if (dir) {
      const made = await api.blobs.mkdir(project.id, { path: dir, parent_id: into.id, parents: true });
      target = { id: made.id, path: made.path };
    }
    uploads.add(project.id, project.name, group, target);
  }
}
