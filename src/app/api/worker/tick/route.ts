import { getDb } from "@/lib/db/client";
import { processPendingBillingEvents } from "@/lib/zoho/billing-events";
import { runTasks } from "@/lib/tasks/queue";
import { HANDLERS } from "@/lib/tasks/handlers";
import { runArticleJobs, scheduleJobs } from "@/lib/articles/jobs";
import { autoApproveArticles, remindAboutArticles } from "@/lib/articles/lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Called every minute by Vercel Cron (see vercel.json).
 * Phase 2: retries billing events that failed or were missed, and records a
 * heartbeat so we can confirm from the database that the timer is healthy.
 * Phase 3: runs onboarding tasks (emails, website reading, research and
 * strategy agents), a couple per tick so one slow AI call can't starve the rest.
 * Phase 4: opens article jobs for paid, onboarded customers, then moves one
 * article forward (brief, draft, quality review, revision). New AI steps only
 * start in the first minute, so a slow call can't push the tick past its limit.
 */
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("worker tick: CRON_SECRET is not set");
    return new Response("unauthorized: CRON_SECRET not configured", { status: 401 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  try {
    const db = await getDb();
    const started = Date.now();
    const worker = `tick-${crypto.randomUUID().slice(0, 8)}`;
    const billing = await processPendingBillingEvents(db);
    const tasks = await runTasks(db, HANDLERS, { worker, limit: 2, deadlineMs: 60_000 });
    const tasksRun = tasks.done + tasks.retried + tasks.failed;
    const jobsCreated = await scheduleJobs(db);
    await remindAboutArticles(db);
    await autoApproveArticles(db);
    const left = 60_000 - (Date.now() - started);
    const articles = left > 5_000 ? await runArticleJobs(db, { worker, deadlineMs: left }) : { steps: 0, failed: 0 };
    if (new Date().getUTCMinutes() === 7) await housekeeping(db);
    await db.query(`insert into app.worker_heartbeats (billing_events_processed, tasks_run) values ($1, $2)`,
      [billing, tasksRun + articles.steps]);
    return Response.json({ billing_events_processed: billing, tasks, jobs_created: jobsCreated, articles });
  } catch (err) {
    console.error("worker tick failed", (err as { code?: string }).code, err);
    return new Response("worker error", { status: 500 });
  }
}

/**
 * Once an hour: drop records that only matter briefly. Rejected webhooks hold
 * raw payloads with customer emails, so they are kept just long enough to debug.
 */
async function housekeeping(db: { query: (q: string) => Promise<unknown> }) {
  try {
    await db.query(`delete from app.webhook_rejections where received_at < now() - interval '14 days'`);
    await db.query(`delete from app.worker_heartbeats where ran_at < now() - interval '14 days'`);
    await db.query(`delete from app.admin_login_attempts where at < now() - interval '90 days'`);
    await db.query(`delete from app.admin_sessions where expires_at < now() - interval '7 days'`);
  } catch (err) {
    console.error("housekeeping failed", (err as Error).message);
  }
}
