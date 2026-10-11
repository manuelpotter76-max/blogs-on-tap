import type { Db, Queryable } from "@/lib/db/client";

export type TaskKind =
  | "send_onboarding_invite"
  | "website_fetch"
  | "business_research"
  | "send_profile_review"
  | "content_strategy"
  | "send_topic_review";

export type Task = {
  id: string;
  org_id: string;
  kind: TaskKind;
  dedupe_key: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
};

/** An error retrying cannot fix (bad data, missing config). Fails the task at once. */
export class PermanentError extends Error {
  override name = "PermanentError";
}

/** Add a task once per dedupe key. Returns false if that key already exists. */
export async function enqueue(
  tx: Queryable, orgId: string, kind: TaskKind, dedupeKey: string,
  payload: Record<string, unknown> = {}, delaySeconds = 0,
): Promise<boolean> {
  const { rows } = await tx.query<{ id: string }>(
    `insert into app.pipeline_tasks (org_id, kind, dedupe_key, payload, run_after)
     values ($1, $2, $3, $4, now() + make_interval(secs => $5))
     on conflict (dedupe_key) do nothing returning id`,
    [orgId, kind, dedupeKey, JSON.stringify(payload), delaySeconds]);
  return rows.length > 0;
}

const BACKOFF_SECONDS = [60, 300, 900, 3600];

export type Handler = (db: Db, task: Task) => Promise<void>;

/**
 * Claim and run up to `limit` tasks. Overlapping cron ticks never run the
 * same task (SKIP LOCKED + lease). A task that crashes the function is picked
 * up again after its lease ends.
 */
export async function runTasks(
  db: Db, handlers: Record<TaskKind, Handler>, opts: { worker: string; limit?: number; deadlineMs?: number },
): Promise<{ done: number; retried: number; failed: number }> {
  const out = { done: 0, retried: 0, failed: 0 };
  const deadline = Date.now() + (opts.deadlineMs ?? 240_000);
  const { rows } = await db.query<Task>(`select * from app.claim_tasks($1, $2)`, [opts.worker, opts.limit ?? 3]);

  for (const task of rows) {
    if (Date.now() > deadline) {
      // Out of time this tick: hand it back untouched.
      await db.query(
        `update app.pipeline_tasks set state = 'pending', locked_until = null, locked_by = null,
                attempts = attempts - 1 where id = $1`, [task.id]);
      continue;
    }
    try {
      await handlers[task.kind](db, task);
      await db.query(
        `update app.pipeline_tasks set state = 'done', finished_at = now(), updated_at = now(),
                locked_until = null, last_error = null where id = $1`, [task.id]);
      out.done++;
    } catch (err) {
      const e = err as Error;
      const permanent = e instanceof PermanentError || task.attempts >= task.max_attempts;
      const msg = `${e.name}: ${e.message}`.slice(0, 2000);
      console.error(`task ${task.kind} ${task.id} attempt ${task.attempts} failed:`, msg);
      if (permanent) {
        await db.query(
          `update app.pipeline_tasks set state = 'failed', finished_at = now(), updated_at = now(),
                  locked_until = null, last_error = $2 where id = $1`, [task.id, msg]);
        await db.query(
          `insert into app.audit_events (org_id, actor, action, target, details)
           values ($1, 'system', 'task.failed', $2, $3)`,
          [task.org_id, task.id, JSON.stringify({ kind: task.kind, error: msg })]);
        out.failed++;
      } else {
        const wait = BACKOFF_SECONDS[Math.min(task.attempts - 1, BACKOFF_SECONDS.length - 1)];
        await db.query(
          `update app.pipeline_tasks set state = 'pending', updated_at = now(), locked_until = null,
                  last_error = $2, run_after = now() + make_interval(secs => $3) where id = $1`,
          [task.id, msg, wait]);
        out.retried++;
      }
    }
  }
  return out;
}

/** Admin: put a failed task back in the queue with a fresh set of attempts. */
export async function retryTask(db: Queryable, taskId: string, orgId: string): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `update app.pipeline_tasks set state = 'pending', attempts = 0, run_after = now(),
            last_error = null, finished_at = null, updated_at = now()
      where id = $1 and org_id = $2 and state = 'failed' returning id`, [taskId, orgId]);
  return rows.length > 0;
}
