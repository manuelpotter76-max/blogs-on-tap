import { getDb } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public health check. Reports only yes/no facts and error codes, never
 * secret values, so it is safe to open in a browser.
 */
export async function GET(): Promise<Response> {
  const env = (k: string) => Boolean(process.env[k]?.trim());
  const provider = (process.env.EMAIL_PROVIDER ?? "log").trim();
  const settings = {
    DATABASE_URL: env("DATABASE_URL"),
    CRON_SECRET: env("CRON_SECRET"),
    ZOHO_BILLING_WEBHOOK_SECRET: env("ZOHO_BILLING_WEBHOOK_SECRET"),
    APP_BASE_URL: env("APP_BASE_URL"),
    LINK_SECRET: (process.env.LINK_SECRET?.trim().length ?? 0) >= 32,
    OPENAI_API_KEY: env("OPENAI_API_KEY"),
    OPENAI_MODEL: env("OPENAI_MODEL_DEFAULT") || (env("OPENAI_MODEL_RESEARCH") && env("OPENAI_MODEL_STRATEGY")
      && env("OPENAI_MODEL_BRIEF") && env("OPENAI_MODEL_WRITING") && env("OPENAI_MODEL_QA")),
    SUPABASE_STORAGE: env("SUPABASE_URL") && env("SUPABASE_SECRET_KEY"),
    EMAIL: provider === "log" || (provider === "zeptomail" && env("ZEPTOMAIL_TOKEN") && env("EMAIL_FROM")),
  };
  const notes: string[] = [];
  if (provider === "log") notes.push("EMAIL_PROVIDER is 'log': customer emails are not really sent; copy links from /admin.");
  if (!env("ADMIN_EMAIL")) notes.push("ADMIN_EMAIL is not set: you won't get alerts about reviews and failures.");

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
  const timerOk = !!lastHeartbeat && Date.now() - new Date(lastHeartbeat).getTime() < 5 * 60_000;
  const work = database.ok ? await workQueues() : null;
  if (work?.unprocessed_billing_events) notes.push("Some Zoho billing events could not be applied: check app.billing_events.");
  if (work?.failed_articles || work?.failed_steps) notes.push("Something failed: see /admin/articles and the customer pages.");
  if (database.ok && !work?.ai_prices) notes.push("No rows in app.ai_model_prices: AI cost shows as unknown.");
  const allGood = Object.values(settings).every(Boolean) && database.ok && timerOk;
  return Response.json({
    all_good: allGood,
    settings,
    database,
    last_successful_timer_run: lastHeartbeat,
    timer_ok: timerOk,
    work,
    notes,
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

/** Counts only: nothing about any customer. */
async function workQueues() {
  try {
    const db = await getDb();
    const { rows } = await db.query<Record<string, number>>(`
      select (select count(*)::int from app.billing_events where processed_at is null and received_at < now() - interval '5 minutes') as unprocessed_billing_events,
             (select count(*)::int from app.pipeline_tasks where state = 'failed') as failed_steps,
             (select count(*)::int from app.pipeline_tasks where state = 'pending' and run_after < now() - interval '15 minutes') as overdue_steps,
             (select count(*)::int from app.production_jobs where state = 'failed') as failed_articles,
             (select count(*)::int from app.production_jobs where state = 'admin_review') as articles_awaiting_review,
             (select count(*)::int from app.notifications where status in ('failed', 'uncertain')) as emails_needing_attention,
             (select count(*)::int from app.ai_model_prices) as ai_prices`);
    return rows[0];
  } catch {
    return null;
  }
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
