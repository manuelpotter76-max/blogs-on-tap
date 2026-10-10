/**
 * Minimal database interface so the same code runs against Supabase Postgres
 * in production (node-postgres pool) and PGlite in tests.
 */
export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/** Run a callback as a specific tenant: RLS then limits every query to that org. */
export async function asTenant<T>(db: Db, orgId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('app.org_id', $1, true)", [orgId]);
    await tx.query("set local role app_tenant");
    return fn(tx);
  });
}

let pool: Db | undefined;

/** Production connection (Supabase Postgres via the pooler URL). */
export async function getDb(): Promise<Db> {
  if (pool) return pool;
  const { Pool } = await import("pg");
  const p = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  pool = {
    query: (text, params) => p.query(text, params as unknown[]) as never,
    async transaction(fn) {
      const client = await p.connect();
      try {
        await client.query("begin");
        const out = await fn({ query: (t, ps) => client.query(t, ps as unknown[]) as never });
        await client.query("commit");
        return out;
      } catch (err) {
        await client.query("rollback");
        throw err;
      } finally {
        client.release();
      }
    },
  };
  return pool;
}
