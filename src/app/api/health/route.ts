import { getDb } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public health check. Reports only yes/no facts and error codes, never
 * secret values, so it is safe to open in a browser.
 */
export async function GET(): Promise<Response> {
  const settings = {
    DATABASE_URL: Boolean(process.env.DATABASE_URL),
    CRON_SECRET: Boolean(process.env.CRON_SECRET),
    ZOHO_BILLING_WEBHOOK_SECRET: Boolean(process.env.ZOHO_BILLING_WEBHOOK_SECRET),
  };

  let database: { ok: boolean; problem?: string; code?: string } = { ok: false, problem: "DATABASE_URL is missing" };
  if (settings.DATABASE_URL) {
    try {
      const db = await getDb();
      const { rows } = await db.query<{ plans: number }>("select count(*)::int as plans from app.plan_versions");
      database = { ok: rows[0]?.plans > 0 };
      if (!database.ok) database.problem = "Connected, but the plans table is empty";
    } catch (err) {
      const code = String((err as { code?: string }).code ?? "unknown");
      database = { ok: false, code, problem: explain(code) };
    }
  }

  const lastHeartbeat = database.ok ? await lastTick() : null;
  const allGood = Object.values(settings).every(Boolean) && database.ok;
  return Response.json({
    all_good: allGood,
    settings,
    database,
    last_successful_timer_run: lastHeartbeat,
    // One-way fingerprints let us confirm a secret matches without revealing it.
    fingerprints: {
      ZOHO_BILLING_WEBHOOK_SECRET: await fingerprint(process.env.ZOHO_BILLING_WEBHOOK_SECRET),
      CRON_SECRET: await fingerprint(process.env.CRON_SECRET),
    },
  }, { status: allGood ? 200 : 503 });
}

async function fingerprint(value: string | undefined) {
  if (!value) return null;
  const { createHash } = await import("node:crypto");
  const trimmed = value.trim();
  return {
    hash: createHash("sha256").update(trimmed).digest("hex").slice(0, 8),
    length: trimmed.length,
    had_extra_spaces: trimmed.length !== value.length,
  };
}

async function lastTick(): Promise<string | null> {
  try {
    const db = await getDb();
    const { rows } = await db.query<{ ran_at: string }>(
      "select ran_at from app.worker_heartbeats order by ran_at desc limit 1");
    return rows[0]?.ran_at ?? null;
  } catch {
    return null;
  }
}

function explain(code: string): string {
  switch (code) {
    case "28P01": return "Wrong database password in DATABASE_URL";
    case "28000": return "Database rejected the username in DATABASE_URL";
    case "ENOTFOUND": return "The database address in DATABASE_URL can't be found (typo in the host?)";
    case "ECONNREFUSED":
    case "ETIMEDOUT": return "Couldn't reach the database (wrong port? should be 6543)";
    case "3D000": return "The database name at the end of DATABASE_URL is wrong (should be postgres)";
    case "42P01": return "Connected, but the app tables aren't there (wrong Supabase project?)";
    case "ERR_INVALID_URL": return "DATABASE_URL isn't a valid address (check for spaces or missing parts)";
    default: return "Database connection failed";
  }
}
