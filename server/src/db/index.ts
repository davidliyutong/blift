// Minimal subset of the Cloudflare D1 API. Implemented natively by D1 on Workers and by
// ./node-sqlite.ts (node:sqlite) in Docker, so all queries are written once.

export interface Stmt {
  bind(...values: unknown[]): Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface DB {
  prepare(sql: string): Stmt;
  /** Runs all statements in one transaction (D1 batch semantics). */
  batch(stmts: Stmt[]): Promise<{ meta: { changes: number } }[]>;
}

// D1 rejects `undefined` and node:sqlite rejects booleans.
const norm = (v: unknown) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);

export const stmt = (db: DB, sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args.map(norm));

export const one = <T = Record<string, unknown>>(db: DB, sql: string, ...args: unknown[]) =>
  stmt(db, sql, ...args).first<T>();

export const all = async <T = Record<string, unknown>>(db: DB, sql: string, ...args: unknown[]) =>
  (await stmt(db, sql, ...args).all<T>()).results;

export const run = async (db: DB, sql: string, ...args: unknown[]) =>
  (await stmt(db, sql, ...args).run()).meta.changes;

/** D1 allows at most 100 bound parameters per statement; chunk IN (...) lists. */
export function chunks<T>(items: T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const placeholders = (n: number) => Array(n).fill("?").join(",");

export const now = () => Date.now();
