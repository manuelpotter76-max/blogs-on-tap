import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase } from "./helpers/psql-db";
import { asTenant } from "../src/lib/db/client";
import { storeBillingEvent, processPendingBillingEvents, type ZohoEvent } from "../src/lib/zoho/billing-events";

const db = freshDatabase("bot_billing_test");
after(() => db.close());

let seq = 0;
function event(type: string, sub: Partial<{
  id: string; status: string; plan: string; start: string; end: string; email: string; name: string; time: string;
}>): ZohoEvent {
  seq++;
  return {
    event_id: `evt_${seq}`,
    event_type: type,
    event_time: sub.time ?? new Date(Date.UTC(2026, 0, 1) + seq * 60_000).toISOString(),
    data: {
      subscription: {
        subscription_id: sub.id ?? "sub_A",
        status: sub.status ?? "live",
        plan: { plan_code: sub.plan ?? "growth" },
        customer: { customer_id: `cust_${sub.id ?? "sub_A"}`, display_name: sub.name ?? "Acme Plumbing",
                    email: sub.email ?? "owner@acme.test" },
        current_term_starts_at: sub.start ?? "2026-01-01T00:00:00Z",
        current_term_ends_at: sub.end ?? "2026-02-01T00:00:00Z",
      },
    },
  };
}

async function send(e: ZohoEvent) {
  const stored = await storeBillingEvent(db, e);
  await processPendingBillingEvents(db);
  return stored;
}
async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0];
}
async function subId(zoho: string) {
  return (await one<{ id: string }>(`select id from app.subscriptions where zoho_subscription_id = $1`, [zoho])).id;
}
async function openCycle(zoho: string) {
  return one<{ cycle_id: string; available: number }>(
    `select b.cycle_id, b.available from app.cycle_balances b
      join app.subscriptions s on s.id = b.subscription_id
     where s.zoho_subscription_id = $1 and b.status = 'open'`, [zoho]);
}
const ensureJobs = async (cycle: string) =>
  (await one<{ n: number }>(`select app.ensure_jobs_for_cycle($1) as n`, [cycle])).n;

test("test 1: first paid event creates customer, subscription and one cycle of credits", async () => {
  assert.equal(await send(event("subscription_created", {})), "stored");
  const org = await one<{ count: number }>(`select count(*)::int from app.organizations`);
  assert.equal(org.count, 1);
  const cyc = await openCycle("sub_A");
  assert.equal(cyc.available, 4, "Growth grants 4 credits");
  const pending = await one<{ count: number }>(
    `select count(*)::int from app.audit_events where action = 'onboarding.pending'`);
  assert.equal(pending.count, 1, "onboarding is queued exactly once");
});

test("test 2: replayed webhooks change nothing", async () => {
  const e = event("subscription_renewed", {});   // same term as before
  assert.equal(await send(e), "stored");
  assert.equal(await send(e), "duplicate", "same event_id is stored once");
  const counts = await one<{ orgs: number; subs: number; cycles: number; grants: number; onboard: number }>(
    `select (select count(*)::int from app.organizations) orgs,
            (select count(*)::int from app.subscriptions) subs,
            (select count(*)::int from app.entitlement_cycles) cycles,
            (select count(*)::int from app.entitlement_ledger where kind = 'grant') grants,
            (select count(*)::int from app.audit_events where action = 'onboarding.pending') onboard`);
  assert.deepEqual(counts, { orgs: 1, subs: 1, cycles: 1, grants: 1, onboard: 1 });
});

test("test 5: a 4-article plan cannot get a 5th job", async () => {
  const { cycle_id } = await openCycle("sub_A");
  assert.equal(await ensureJobs(cycle_id), 4);
  assert.equal(await ensureJobs(cycle_id), 0, "re-running the scheduler creates nothing");
  assert.equal((await openCycle("sub_A")).available, 0);
  // Even a hand-written extra reservation for an existing job is blocked.
  const job = await one<{ id: string }>(`select id from app.production_jobs where cycle_id = $1 and slot = 1`, [cycle_id]);
  await assert.rejects(db.query(
    `insert into app.entitlement_ledger (org_id, cycle_id, job_id, kind, delta)
     select org_id, cycle_id, id, 'reserve', -1 from app.production_jobs where id = $1`, [job.id]));
});

test("test 6: a failed job releases its credit exactly once, and a slot reopens", async () => {
  const { cycle_id } = await openCycle("sub_A");
  const jobs = (await db.query<{ id: string }>(
    `select id from app.production_jobs where cycle_id = $1 order by slot`, [cycle_id])).rows;
  await db.query(`select app.release_credit($1, 'AI failed 3 times')`, [jobs[0].id]);
  await assert.rejects(db.query(`select app.release_credit($1, 'again')`, [jobs[0].id]), "no double release");
  await assert.rejects(db.query(`select app.consume_credit($1)`, [jobs[0].id]), "no consume after release");
  assert.equal((await openCycle("sub_A")).available, 1);
  assert.equal(await ensureJobs(cycle_id), 1, "a replacement job takes the freed credit");

  await db.query(`select app.consume_credit($1)`, [jobs[1].id]);
  await assert.rejects(db.query(`select app.consume_credit($1)`, [jobs[1].id]), "no double consume");
});

test("renewal opens a new cycle and rolls unused credits forward, capped at one allowance", async () => {
  const { cycle_id } = await openCycle("sub_A");
  // Free up 2 credits in cycle 1, then renew.
  const open = (await db.query<{ id: string }>(
    `select j.id from app.production_jobs j
      where j.cycle_id = $1 and not exists (
        select 1 from app.entitlement_ledger l where l.job_id = j.id and l.kind in ('consume','release'))
      order by slot limit 2`, [cycle_id])).rows;
  for (const j of open) await db.query(`select app.release_credit($1, 'cancelled')`, [j.id]);

  await send(event("subscription_renewed", { start: "2026-02-01T00:00:00Z", end: "2026-03-01T00:00:00Z" }));
  assert.equal((await openCycle("sub_A")).available, 6, "4 new + 2 rolled over");
  const old = await one<{ status: string; available: number }>(
    `select status, available from app.cycle_balances where cycle_id = $1`, [cycle_id]);
  assert.deepEqual(old, { status: "closed", available: 0 });

  // Next renewal with nothing used: the 2 rolled credits expire, only 4 move on.
  await send(event("subscription_renewed", { start: "2026-03-01T00:00:00Z", end: "2026-04-01T00:00:00Z" }));
  assert.equal((await openCycle("sub_A")).available, 8, "4 new + 4 rolled (cap), 2 expired");
});

test("test 8: past due stops new work, recovery resumes it, cancel stops it", async () => {
  await send(event("subscription_unpaid", { status: "unpaid", start: "2026-03-01T00:00:00Z", end: "2026-04-01T00:00:00Z" }));
  const s = await one<{ status: string; grace: boolean }>(
    `select status, grace_until is not null as grace from app.subscriptions where zoho_subscription_id = 'sub_A'`);
  assert.deepEqual(s, { status: "past_due", grace: true });
  const { cycle_id } = await openCycle("sub_A");
  assert.equal(await ensureJobs(cycle_id), 0, "no jobs while unpaid");

  await send(event("subscription_activation", { status: "live", start: "2026-03-01T00:00:00Z", end: "2026-04-01T00:00:00Z" }));
  const back = await one<{ status: string; grace: boolean }>(
    `select status, grace_until is not null as grace from app.subscriptions where zoho_subscription_id = 'sub_A'`);
  assert.deepEqual(back, { status: "active", grace: false });

  await send(event("subscription_cancelled", { status: "cancelled", start: "2026-03-01T00:00:00Z", end: "2026-04-01T00:00:00Z" }));
  assert.equal(await ensureJobs(cycle_id), 0, "no jobs after cancellation");
});

test("an older event delivered late does not roll state backwards", async () => {
  await send(event("subscription_renewed", { status: "live", time: "2025-12-31T00:00:00Z" }));
  const s = await one<{ status: string }>(`select status from app.subscriptions where zoho_subscription_id = 'sub_A'`);
  assert.equal(s.status, "cancelled");
});

test("mid-cycle upgrade adds the difference now", async () => {
  await send(event("subscription_created", { id: "sub_B", plan: "starter", email: "b@bakery.test", name: "Bay Bakery" }));
  assert.equal((await openCycle("sub_B")).available, 2);
  await send(event("subscription_upgraded", { id: "sub_B", plan: "growth", email: "b@bakery.test" }));
  assert.equal((await openCycle("sub_B")).available, 4);
  const audit = await one<{ count: number }>(`select count(*)::int from app.audit_events where action = 'credits.adjust'`);
  assert.equal(audit.count, 1);
});

test("unknown plan code is recorded as a failed event, not silently dropped", async () => {
  await storeBillingEvent(db, event("subscription_created", { id: "sub_X", plan: "mystery" }));
  await processPendingBillingEvents(db);
  const ev = await one<{ processed: boolean; attempts: number; last_error: string }>(
    `select processed_at is not null as processed, attempts, last_error
       from app.billing_events where payload->'data'->'subscription'->>'subscription_id' = 'sub_X'`);
  assert.equal(ev.processed, false);
  assert.equal(ev.attempts, 1);
  assert.match(ev.last_error, /mystery/);
  assert.equal((await one<{ count: number }>(
    `select count(*)::int from app.subscriptions where zoho_subscription_id = 'sub_X'`)).count, 0);
});

test("test 9: a tenant sees only its own rows and none of the server-only tables", async () => {
  const a = await one<{ org_id: string }>(`select org_id from app.subscriptions where zoho_subscription_id = 'sub_A'`);
  const b = await one<{ org_id: string }>(`select org_id from app.subscriptions where zoho_subscription_id = 'sub_B'`);

  await asTenant(db, a.org_id, async (tx) => {
    const subs = (await tx.query<{ org_id: string }>(`select org_id from app.subscriptions`)).rows;
    assert.deepEqual(subs.map((r) => r.org_id), [a.org_id]);
    const orgs = (await tx.query<{ id: string }>(`select id from app.organizations`)).rows;
    assert.deepEqual(orgs.map((r) => r.id), [a.org_id]);
    const bLedger = (await tx.query(`select * from app.entitlement_ledger where org_id = $1`, [b.org_id])).rows;
    assert.equal(bLedger.length, 0, "B's ledger is invisible to A even when asked for by id");
  });
  await assert.rejects(
    asTenant(db, a.org_id, (tx) => tx.query(`select * from app.billing_events`)), /permission denied/);
  await assert.rejects(
    asTenant(db, a.org_id, (tx) => tx.query(`update app.subscriptions set status = 'active' returning id`)),
    /permission denied/);
  const aCycle = (await openCycle("sub_A")).cycle_id;
  await assert.rejects(
    asTenant(db, a.org_id, (tx) => tx.query(`select app.adjust_credits($1, 10, 'free stuff', 'me')`, [aCycle])),
    /permission denied/);
});
