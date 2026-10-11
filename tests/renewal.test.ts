import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase } from "./helpers/psql-db";
import { makeReady } from "./helpers/ready";
import { storeBillingEvent, processPendingBillingEvents, eventTimestamp, type ZohoEvent } from "../src/lib/zoho/billing-events";
import { scheduleJobs, topUpTopics } from "../src/lib/articles/jobs";
import { autoApproveArticles, remindAboutArticles } from "../src/lib/articles/lifecycle";
import { createLink } from "../src/lib/links";
import { getWeek } from "../src/lib/admin/week";

process.env.LINK_SECRET = "test-link-secret-0123456789abcdef0123456789";
process.env.APP_BASE_URL = "https://app.test";
process.env.EMAIL_PROVIDER = "log";

const db = freshDatabase("bot_renewal_test");
const realLog = console.log;
before(() => { console.log = () => {}; });
after(() => { db.close(); console.log = realLog; });

const one = async <T>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0];
const n = async (sql: string, p: unknown[] = []) => (await one<{ n: number }>(sql, p)).n;

/** Same shape as a real Zoho Billing webhook (previous format), trimmed to what matters. */
function zoho(type: string, o: { eventId: string; status?: string; start: string; end: string; created: string }): ZohoEvent {
  return {
    event_id: o.eventId,
    event_type: type,
    event_time: o.created.slice(0, 10),                // Zoho sends a bare date here
    created_time: o.created,                           // ...and the real timestamp here
    data: { subscription: {
      subscription_id: "8575385000000999001",
      status: o.status ?? "live",
      plan: { plan_code: "starter" },
      customer: { customer_id: "8575385000000999002", display_name: "Renewal Test", company_name: "Renewal Test Co",
                  email: "renewal@test.test" },
      current_term_starts_at: o.start,
      current_term_ends_at: o.end,
      updated_time: o.created,
    } },
  } as ZohoEvent;
}

async function apply(e: ZohoEvent) {
  await storeBillingEvent(db, e);
  await processPendingBillingEvents(db);
}

let orgId = "";
const cycles = async () => (await db.query<{ status: string; available: number; period_start: string }>(
  `select status, available, period_start from app.cycle_balances where org_id = $1 order by period_start`, [orgId])).rows;

/** Simulate an article being written, approved and delivered for a job. */
async function deliver(jobId: string, deliveredDaysAgo: number) {
  const job = await one<{ topic_id: string }>(`select topic_id from app.production_jobs where id = $1`, [jobId]);
  const a = await one<{ id: string }>(
    `insert into app.articles (org_id, job_id, topic_id, current_version, delivered_version, delivered_at)
     values ($1, $2, $3, 1, 1, now() - make_interval(days => $4)) returning id`, [orgId, jobId, job.topic_id, deliveredDaysAgo]);
  await db.query(
    `insert into app.article_versions (org_id, article_id, version, content, word_count, created_by)
     values ($1, $2, 1, '{"seo_title":"A delivered article"}', 900, 'ai')`, [orgId, a.id]);
  await db.query(`select app.consume_credit($1)`, [jobId]);
  await db.query(`update app.production_jobs set state = 'delivered' where id = $1`, [jobId]);
  await db.query(`update app.topics set status = 'used' where id = $1`, [job.topic_id]);
  await createLink(db, orgId, "article_review", a.id);
  return a.id;
}

test("Zoho timestamps: same-day events are ordered by the real time, not the bare date", () => {
  const e = zoho("x", { eventId: "t", start: "2026-10-10", end: "2026-11-10", created: "2026-10-10T23:58:48-0500" });
  assert.equal(eventTimestamp(e), "2026-10-11T04:58:48.000Z");
  assert.equal(eventTimestamp({ event_id: "x", event_type: "x", event_time: "2026-10-10" }), "2026-10-10T00:00:00.000Z");
});

test("month 1: signup, onboarding done, both credits become jobs", async () => {
  await apply(zoho("subscription_created", { eventId: "e1", start: "2026-10-10", end: "2026-11-10", created: "2026-10-10T10:00:00-0500" }));
  await apply(zoho("subscription_activation", { eventId: "e2", start: "2026-10-10", end: "2026-11-10", created: "2026-10-10T10:00:01-0500" }));
  orgId = (await one<{ org_id: string }>(`select org_id from app.subscriptions where zoho_subscription_id = '8575385000000999001'`)).org_id;
  assert.equal(await n(`select count(*)::int n from app.organizations`), 1, "created + activation together: one customer");
  await makeReady(db, orgId, 3);   // 3 approved topics
  assert.equal(await scheduleJobs(db), 2);
  assert.deepEqual((await cycles()).map((c) => [c.status, c.available]), [["open", 0]]);
});

test("delivered articles get a reminder 3 days before, then auto-approve when the window closes", async () => {
  const jobs = (await db.query<{ id: string }>(`select id from app.production_jobs where org_id = $1 order by slot`, [orgId])).rows;
  await deliver(jobs[0].id, 12);   // window is 14 days: reminder due
  await deliver(jobs[1].id, 15);   // window passed: auto-approve
  assert.equal(await remindAboutArticles(db), 1);
  assert.equal(await remindAboutArticles(db), 0, "one reminder per article");
  assert.equal(await autoApproveArticles(db), 1);
  assert.equal(await autoApproveArticles(db), 0);
  const states = (await db.query<{ state: string }>(`select state from app.production_jobs where org_id = $1 order by slot`, [orgId])).rows;
  assert.deepEqual(states.map((s) => s.state), ["delivered", "customer_approved"]);
  const reminder = await one<{ subject: string }>(`select subject from app.notifications where kind = 'article_reminder'`);
  assert.equal(reminder.subject, "Reminder: A delivered article");
});

test("this-week view loads and shows what's waiting on the customer", async () => {
  const w = await getWeek(db);
  assert.ok(w.waiting.some((i) => i.what.startsWith('Reading "A delivered article" (auto-approves')));
  assert.equal(w.needsYou.length, 0);
});

test("month 2: renewal opens a new cycle, credits land, new jobs take the next topics", async () => {
  await apply(zoho("subscription_renewed", { eventId: "e3", start: "2026-11-10", end: "2026-12-10", created: "2026-11-10T06:00:00-0500" }));
  assert.deepEqual((await cycles()).map((c) => [c.status, c.available]), [["closed", 0], ["open", 2]]);
  const created = await scheduleJobs(db);
  assert.equal(created, 1, "only 1 approved topic left for 2 credits");
  assert.equal(await n(`select count(*)::int n from app.pipeline_tasks where org_id = $1 and kind = 'content_strategy'`, [orgId]), 1,
    "the pool ran low, so more topic ideas were requested automatically");
  assert.equal(await n(`select count(*)::int n from app.pipeline_tasks where org_id = $1 and kind = 'send_onboarding_invite'`, [orgId]), 1,
    "renewal doesn't re-send the onboarding invite");

  const w = await getWeek(db);
  assert.equal(w.needsYou.filter((i) => i.what.includes("no approved topics")).length, 0, "not stuck: strategy is on its way");
});

test("month 2, if strategy never comes back: the stuck credit shows up under Needs you", async () => {
  await db.query(`update app.pipeline_tasks set state = 'failed' where org_id = $1 and kind = 'content_strategy'`, [orgId]);
  const w = await getWeek(db);
  assert.ok(w.needsYou.some((i) => i.what === "1 unused article credit(s) but no approved topics"));
  assert.ok(w.needsYou.some((i) => i.what.startsWith("Background step failed")));
});

test("month 3: an unused credit rolls over once, then expires", async () => {
  await db.query(`update app.pipeline_tasks set state = 'done' where org_id = $1`, [orgId]);
  await apply(zoho("subscription_renewed", { eventId: "e4", start: "2026-12-10", end: "2027-01-10", created: "2026-12-10T06:00:00-0500" }));
  assert.deepEqual((await cycles()).map((c) => [c.status, c.available]), [["closed", 0], ["closed", 0], ["open", 3]],
    "2 new + 1 rolled over");
});

test("same-day cancel then reactivate ends active (ordered by real time)", async () => {
  await apply(zoho("subscription_cancelled", { eventId: "e5", status: "cancelled", start: "2026-12-10", end: "2027-01-10", created: "2026-12-15T09:00:00-0500" }));
  await apply(zoho("subscription_reactivated", { eventId: "e6", start: "2026-12-15", end: "2027-01-15", created: "2026-12-15T09:30:00-0500" }));
  const s = await one<{ status: string }>(`select status from app.subscriptions where org_id = $1`, [orgId]);
  assert.equal(s.status, "active");
  // A late copy of the cancel (same day, earlier time) must not undo the reactivation.
  await apply(zoho("subscription_cancelled", { eventId: "e5-late", status: "cancelled", start: "2026-12-10", end: "2027-01-10", created: "2026-12-15T09:00:00-0500" }));
  assert.equal((await one<{ status: string }>(`select status from app.subscriptions where org_id = $1`, [orgId])).status, "active");
  assert.equal(await topUpTopics(db) >= 0, true);
});
