// D1-compatible adapter over node:sqlite, used by the Docker/Node runtime.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { DB, Stmt } from "./index";

type Row = Record<string, unknown>;

class NodeStmt implements Stmt {
  constructor(
    private readonly db: NodeD1,
    private readonly sql: string,
    private readonly args: unknown[] = [],
  ) {}

  bind(...values: unknown[]): Stmt {
    return new NodeStmt(this.db, this.sql, values);
  }

  private get s(): StatementSync {
    return this.db.statement(this.sql);
  }

  private get params() {
    return this.args as (string | number | null | Uint8Array)[];
  }

  async first<T = Row>(): Promise<T | null> {
    return (this.s.get(...this.params) as T | undefined) ?? null;
  }

  async all<T = Row>(): Promise<{ results: T[] }> {
    return { results: this.s.all(...this.params) as T[] };
  }

  async run() {
    return this.runSync();
  }

  runSync() {
    return { meta: { changes: Number(this.s.run(...this.params).changes) } };
  }
}

export class NodeD1 implements DB {
  private readonly db: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  }

  statement(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  prepare(sql: string): Stmt {
    return new NodeStmt(this, sql);
  }

  async batch(stmts: Stmt[]) {
    this.db.exec("BEGIN");
    try {
      const out = stmts.map((s) => (s as NodeStmt).runSync());
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  close() {
    this.db.close();
  }
}
