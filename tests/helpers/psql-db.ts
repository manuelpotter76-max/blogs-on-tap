import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import type { Db, Queryable } from "../../src/lib/db/client";

/**
 * Test-only Db backed by a real PostgreSQL through one long-lived psql session.
 * (The workspace cannot install npm packages, so there is no pg driver here.)
 * Parameters are inlined as properly quoted literals; production uses real
 * bind parameters through node-postgres.
 */
const HOST = process.env.PGHOST_TEST!;
const PSQL = "psql";

function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function inline(sql: string, params: unknown[] = []): string {
  return sql.replace(/\$(\d+)/g, (_, n) => literal(params[Number(n) - 1]));
}

const RAW = /^\s*(set|begin|commit|rollback|reset)\b/i;

export class PsqlDb implements Db {
  private proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private waiters: Array<(chunk: string) => void> = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private database: string) {
    this.proc = spawn(PSQL, ["-X", "-q", "-A", "-t", "-h", HOST, "-U", "postgres", "-d", database,
      "-v", "ON_ERROR_STOP=0"]);
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d: string) => {
      this.buf += d;
      this.flush();
    });
    this.proc.stderr.on("data", () => {});
  }

  private flush() {
    const m = this.buf.match(/__(OK|ERR)__ ?(.*)\n/);
    if (!m || m.index === undefined) return;
    const chunk = this.buf.slice(0, m.index + m[0].length);
    this.buf = this.buf.slice(m.index + m[0].length);
    this.waiters.shift()?.(chunk);
    this.flush();
  }

  private run(sql: string): Promise<string> {
    const next = this.chain.then(() => new Promise<string>((resolve, reject) => {
      this.waiters.push((chunk) => {
        const err = chunk.match(/__ERR__ ?(.*)\n$/);
        if (err) reject(new Error(err[1]));
        else resolve(chunk.replace(/__OK__\s*\n$/, ""));
      });
      this.proc.stdin.write(
        `${sql};\n\\if :ERROR\n\\echo __ERR__ :LAST_ERROR_MESSAGE\n\\else\n\\echo __OK__\n\\endif\n`);
    }));
    this.chain = next.catch(() => {});
    return next;
  }

  async query<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const sql = inline(text.trim(), params);
    const dmlWithoutReturning = /^\s*(insert|update|delete)\b/i.test(sql) && !/\breturning\b/i.test(sql);
    if (RAW.test(sql) || dmlWithoutReturning) {
      await this.run(sql);
      return { rows: [] };
    }
    const out = await this.run(`with __q as (${sql}) select coalesce(json_agg(__q), '[]'::json) from __q`);
    return { rows: JSON.parse(out.trim() || "[]") as T[] };
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    await this.run("begin");
    try {
      const out = await fn(this);
      await this.run("commit");
      return out;
    } catch (e) {
      await this.run("rollback");
      throw e;
    }
  }

  close() {
    this.proc.stdin.end("\\q\n");
  }
}

/** Fresh database with every migration applied in filename order, same as production. */
export function freshDatabase(name: string): PsqlDb {
  const base = ["-X", "-q", "-h", HOST, "-U", "postgres"];
  execFileSync(PSQL, [...base, "-c", `drop database if exists ${name}`, "-c", `create database ${name}`]);
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(new URL(file, dir), "utf8");
    execFileSync(PSQL, [...base, "-d", name, "-v", "ON_ERROR_STOP=1", "-f", "-"], { input: sql });
  }
  return new PsqlDb(name);
}
