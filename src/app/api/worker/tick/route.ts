import { getDb } from "@/lib/db/client";
import { processPendingBillingEvents } from "@/lib/zoho/billing-events";
import { runTasks } from "@/lib/tasks/queue";
import { HANDLERS } from "@/lib/tasks/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Called every minute by Vercel Cron (see vercel.json).
 * Phase 2: retries billing events that failed or were missed, and records a
 * heartbeat so we can confirm from the database that the timer is healthy.
 * Phase 3: runs onboarding tasks (emails, website reading, research and
 * strategy agents), a couple per tick so one slow AI call can't starve the rest.
 * Phase 4 adds: open job slots for paid cycles, claim jobs, run AI steps.
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
    const billing = await processPendingBillingEvents(db);
    const tasks = await runTasks(db, HANDLERS, {
      worker: `tick-${crypto.randomUUID().slice(0, 8)}`, limit: 2, deadlineMs: 60_000,
    });
    const tasksRun = tasks.done + tasks.retried + tasks.failed;
    await db.query(`insert into app.worker_heartbeats (billing_events_processed, tasks_run) values ($1, $2)`,
      [billing, tasksRun]);
    return Response.json({ billing_events_processed: billing, tasks });
  } catch (err) {
    console.error("worker tick failed", (err as { code?: string }).code, err);
    return new Response("worker error", { status: 500 });
  }
}
