import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase } from "./helpers/psql-db";
import { storeBillingEvent, processPendingBillingEvents, type ZohoEvent } from "../src/lib/zoho/billing-events";
import { runTasks } from "../src/lib/tasks/queue";
import { HANDLERS } from "../src/lib/tasks/handlers";
import { runArticleJobs, scheduleJobs } from "../src/lib/articles/jobs";
import {
  adminEdit, adminRequestRevision, approveAndSend, customerApprove, customerRequestRevision, giveUp, loadForCustomer, retryFailed,
} from "../src/lib/articles/review";
import { renderMarkdown, wordCount } from "../src/lib/articles/markdown";
import { checkArticle, type ArticleContent } from "../src/lib/articles/content";
import { resolveLink, linkToken } from "../src/lib/links";
import type { BusinessProfile } from "../src/lib/agents/business-profile";

process.env.LINK_SECRET = "test-link-secret-0123456789abcdef0123456789";
process.env.APP_BASE_URL = "https://app.test";
process.env.EMAIL_PROVIDER = "log";
process.env.OPENAI_API_KEY = "sk-test";
process.env.OPENAI_MODEL_DEFAULT = "test-model";

const db = freshDatabase("bot_articles_test");
const realFetch = globalThis.fetch;
const realLog = console.log;
const realErr = console.error;
before(() => {
  console.log = () => {};
  console.error = () => {};
});
after(() => {
  db.close();
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realErr;
});

const one = async <T>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0];
const n = async (sql: string, p: unknown[] = []) => (await one<{ n: number }>(sql, p)).n;
const work = () => runArticleJobs(db, { worker: "test", deadlineMs: 60_000 });
const wake = () => db.query(`update app.production_jobs set run_after = now() - interval '1 second'`);

// ---------------------------------------------------------------------------
// Fake OpenAI, answering by schema name, recording prompts
// ---------------------------------------------------------------------------
const queue: Record<string, unknown[]> = { article_brief: [], article: [], quality_review: [] };
const prompts: { schema: string; text: string }[] = [];
let failNext = 0;
globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body));
  const name = body.text.format.name as string;
  prompts.push({ schema: name, text: body.input[0].content.map((c: { text?: string }) => c.text ?? "").join("\n") });
  if (failNext > 0) {
    failNext--;
    return new Response("{}", { status: 500 });
  }
  const next = queue[name].shift() ?? defaults[name]();
  return new Response(JSON.stringify({
    id: "resp", status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(next) }] }],
    usage: { input_tokens: 3000, output_tokens: 1500 },
  }), { status: 200 });
}) as typeof fetch;

const body = (words: number) => Array.from({ length: Math.ceil(words / 10) },
  (_, i) => `${i % 12 === 0 ? `\n\n## Section ${i / 12 + 1}\n\n` : ""}Homeowners should check the water heater pressure valve every year honestly.`).join(" ");

function article(over: Partial<ArticleContent> = {}): ArticleContent {
  return {
    seo_title: "When to Replace a Water Heater in Tampa",
    meta_description: "How to tell whether your water heater needs repair or replacement, what to check first, and when to call a licensed plumber in Tampa.",
    slug: "When To Replace A Water Heater!!",
    excerpt: "A practical guide to repair versus replacement.",
    markdown: `# When to Replace a Water Heater\n\nIntro paragraph about water heaters.\n\n${body(900)}\n\nSee [our services](https://ybor.test/services) or [this study](https://evil.example/x).\n\n## Get help\n\nCall for a free estimate at (813) 555-0100.`,
    tags: ["water heaters"], categories: ["Repairs"],
    internal_links: [{ anchor: "our services", url: "https://ybor.test/services", why: "service page" }],
    cta: "Call for a free estimate", source_notes: [{ claim: "Family owned", source: "profile" }],
    ...over,
  };
}
const goodQa = () => ({
  scores: { accuracy: 5, usefulness: 4, relevance: 5, voice: 4, structure: 4, seo: 4, cta: 5 },
  issues: [], unsupported_claims: [], repeats_other_articles: false, high_risk: false, high_risk_reason: "", summary: "Solid.",
});
const badQa = () => ({
  ...goodQa(), scores: { ...goodQa().scores, accuracy: 2 },
  issues: [{ severity: "major", area: "accuracy", problem: "Claims 30 years in business", fix: "Remove it" }],
  unsupported_claims: [{ claim: "30 years in business", why: "not in profile" }],
});
const brief = () => ({
  working_title: "When to replace a water heater", reader: "Tampa homeowner", reader_questions: ["Repair or replace?"],
  angle: "Practical checklist", outline: [{ heading: "Signs", points: ["age", "leaks"] }], facts_to_use: ["Family owned"],
  must_avoid: ["prices"], cta_approach: "Close with estimate offer", link_plan: [], target_words: 1000,
});
const defaults: Record<string, () => unknown> = { article_brief: brief, article: () => article(), quality_review: goodQa };

// ---------------------------------------------------------------------------
// Setup: a paid Starter customer (2 credits) who finished onboarding
// ---------------------------------------------------------------------------
const profile: BusinessProfile = {
  business_name: "Ybor Plumbing", summary: "Family plumbing company in Tampa.", industry: "Plumbing",
  service_area_type: "local", service_area: "Tampa", services: [{ name: "Water heaters", description: "Repair and install", priority: true, source: "customer", needs_confirmation: false }],
  audience: [], pain_points: [], differentiators: [{ text: "Family owned", source: "customer", needs_confirmation: false }],
  faqs: [], facts: [], voice: { tone: ["friendly"], style_notes: [], preferred_terms: [], avoid_terms: ["cheap"] },
  cta: { text: "Call for a free estimate", destination: "(813) 555-0100" },
  prohibited_claims: ["same-day service"], topics_to_avoid: ["commercial plumbing"], priority_topics: [], existing_content: [],
  compliance: { regulated_field: "none", notes: [] }, open_questions: [],
};

let orgId = "";
let cycleId = "";

before(async () => {
  const e: ZohoEvent = {
    event_id: "art_1", event_type: "subscription_created", event_time: "2026-01-01T00:00:00Z",
    data: { subscription: { subscription_id: "sub_art", status: "live", plan: { plan_code: "starter" },
      customer: { customer_id: "c_art", display_name: "Ybor Plumbing", email: "owner@ybor.test" },
      current_term_starts_at: "2026-01-01T00:00:00Z", current_term_ends_at: "2026-02-01T00:00:00Z" } },
  } as ZohoEvent;
  await storeBillingEvent(db, e);
  await processPendingBillingEvents(db);
  orgId = (await one<{ org_id: string }>(`select org_id from app.subscriptions where zoho_subscription_id = 'sub_art'`)).org_id;
  cycleId = (await one<{ id: string }>(`select id from app.entitlement_cycles where org_id = $1`, [orgId])).id;
  await db.query(`update app.pipeline_tasks set state = 'done'`);   // skip the onboarding invite

  await db.query(`update app.organizations set website = 'https://ybor.test' where id = $1`, [orgId]);
  await db.query(`insert into app.source_documents (org_id, kind, source_url, extracted_text) values ($1, 'website_page', 'https://ybor.test/services', 'Title: Services')`, [orgId]);
  await db.query(`insert into app.profile_versions (org_id, version, data, created_by) values ($1, 1, $2, 'customer')`, [orgId, JSON.stringify(profile)]);
  await db.query(`insert into app.business_profiles (org_id, status, current_version) values ($1, 'confirmed', 1)`, [orgId]);
  const sv = await one<{ id: string }>(`insert into app.strategy_versions (org_id, version, profile_version, data, created_by) values ($1, 1, 1, '{}', 'ai') returning id`, [orgId]);
  for (const [i, t] of ["When to Replace a Water Heater", "Signs of a Slab Leak", "Fixing Low Water Pressure"].entries()) {
    await db.query(
      `insert into app.topics (org_id, strategy_version_id, topic_key, title, primary_keyword, search_intent, audience,
                               business_objective, angle, cta, priority, status)
       values ($1, $2, $3, $4, $5, 'informational', 'homeowners', 'leads', 'practical', 'Call us', $6, 'approved')`,
      [orgId, sv.id, t.toLowerCase(), t, t.toLowerCase(), i + 1]);
  }
  await db.query(`insert into app.content_strategies (org_id, status, current_version) values ($1, 'approved', 1)`, [orgId]);
});

const jobByTopic = (title: string) => one<{ id: string; state: string; step: string; flagged: boolean; qa_rounds: number; attempts: number }>(
  `select j.* from app.production_jobs j join app.topics t on t.id = j.topic_id where t.title = $1 and j.state <> 'cancelled'`, [title]);

test("acceptance 5: the scheduler opens one job per credit, tied to approved topics, and no more", async () => {
  assert.equal(await scheduleJobs(db), 2, "Starter = 2 credits");
  assert.equal(await scheduleJobs(db), 0, "re-running creates nothing");
  assert.equal(await n(`select count(*)::int n from app.production_jobs where org_id = $1`, [orgId]), 2);
  assert.equal(await n(`select count(*)::int n from app.topics where org_id = $1 and status = 'in_production'`, [orgId]), 2);
  const third = await one<{ status: string }>(`select status from app.topics where title = 'Fixing Low Water Pressure'`);
  assert.equal(third.status, "approved", "third topic waits: no credit for it");
});

test("brief, draft and quality review run in one go; links and formatting are cleaned by code", async () => {
  // Only one job moves per call; first claimed is the first topic.
  const r = await work();
  assert.equal(r.steps, 3);
  const job = await jobByTopic("When to Replace a Water Heater");
  assert.deepEqual([job.state, job.flagged], ["admin_review", false]);

  const v = await one<{ content: ArticleContent; word_count: number; created_by: string }>(
    `select v.content, v.word_count, v.created_by from app.article_versions v join app.articles a on a.id = v.article_id
      where a.job_id = $1`, [job.id]);
  assert.equal(v.created_by, "ai");
  assert.equal(v.content.slug, "when-to-replace-a-water-heater");
  assert.ok(!v.content.markdown.startsWith("# "), "duplicate title heading removed");
  assert.ok(v.content.markdown.includes("[our services](https://ybor.test/services)"), "allowed link kept");
  assert.ok(!v.content.markdown.includes("evil.example"), "link to an unknown site stripped");
  assert.ok(v.content.markdown.includes("this study"), "its text stays");
  // Acceptance 13: everything a customer needs is there.
  for (const k of ["seo_title", "meta_description", "slug", "excerpt", "markdown", "cta", "internal_links"] as const) {
    assert.ok(v.content[k] && (!Array.isArray(v.content[k]) || (v.content[k] as unknown[]).length), `has ${k}`);
  }
  const brief = prompts.find((p) => p.schema === "article_brief")!.text;
  assert.match(brief, /https:\/\/ybor\.test\/services/);
  assert.match(brief, /tel:\(813\)555-0100|tel:8135550100|tel:\+?8135550100/);
  assert.match(brief, /Signs of a Slab Leak/, "knows the other articles so it won't overlap");
  assert.equal(await n(`select count(*)::int n from app.ai_runs where job_id = $1`, [job.id]), 3, "cost tracked per article");
});

test("acceptance 7: failing QA is revised twice, then escalated to a person with a flag", async () => {
  queue.quality_review.push(badQa(), badQa(), badQa());
  const r = await work();   // second job
  const job = await jobByTopic("Signs of a Slab Leak");
  assert.equal(r.steps, 7, "brief, draft, qa, revise, qa, revise, qa");
  assert.deepEqual([job.state, job.flagged, job.qa_rounds], ["admin_review", true, 2]);
  const revise = prompts.filter((p) => p.schema === "article").at(-1)!.text;
  assert.match(revise, /REQUIRED CHANGES[\s\S]*30 years in business/);
  assert.equal(await n(`select count(*)::int n from app.article_versions v join app.articles a on a.id = v.article_id where a.job_id = $1`, [job.id]), 3);
  assert.equal(await n(`select count(*)::int n from app.audit_events where action = 'article.qa_escalated'`), 1);
});

test("admin approval consumes the credit once and the article is delivered with a working link", async () => {
  const job = await jobByTopic("When to Replace a Water Heater");
  assert.equal(await approveAndSend(db, "00000000-0000-0000-0000-000000000001", job.id), "ok");
  assert.equal(await approveAndSend(db, "00000000-0000-0000-0000-000000000001", job.id), "wrong_state", "double click");
  assert.equal(await n(`select count(*)::int n from app.entitlement_ledger where job_id = $1 and kind = 'consume'`, [job.id]), 1);

  await runTasks(db, HANDLERS, { worker: "t", limit: 5 });
  const a = await one<{ id: string; delivered_version: number; state: string; topic: string }>(
    `select a.id, a.delivered_version, j.state, t.status as topic from app.articles a
       join app.production_jobs j on j.id = a.job_id join app.topics t on t.id = a.topic_id where a.job_id = $1`, [job.id]);
  assert.deepEqual([a.delivered_version, a.state, a.topic], [1, "delivered", "used"]);
  assert.equal(await n(`select count(*)::int n from app.notifications where kind = 'article_ready' and status = 'sent'`), 1);

  const link = await one<{ id: string }>(`select id from app.access_links where purpose = 'article_review' and subject_id = $1`, [a.id]);
  const resolved = await resolveLink(db, linkToken(link.id, "article_review"), "article_review");
  assert.equal(resolved?.subject_id, a.id);
  const view = await loadForCustomer(db, orgId, a.id);
  assert.equal(view?.content?.seo_title, "When to Replace a Water Heater in Tampa");
  assert.equal(view?.revisionsLeft, 1);
});

test("acceptance 12: customer revision keeps old versions, goes back through QA and the admin, credit not charged twice", async () => {
  const job = await jobByTopic("When to Replace a Water Heater");
  const a = await one<{ id: string }>(`select id from app.articles where job_id = $1`, [job.id]);
  assert.equal(await customerRequestRevision(db, orgId, a.id, "x"), "invalid", "note too short");
  assert.equal(await customerRequestRevision(db, orgId, a.id, "Please mention we install tankless heaters too."), "ok");
  assert.equal((await jobByTopic("When to Replace a Water Heater")).state, "customer_revision_requested");

  await wake();
  await work();
  const revise = prompts.filter((p) => p.schema === "article").at(-1)!.text;
  assert.match(revise, /The customer asked: Please mention we install tankless heaters too\./);
  assert.equal((await jobByTopic("When to Replace a Water Heater")).state, "admin_review", "a person checks it again");

  assert.equal(await approveAndSend(db, "00000000-0000-0000-0000-000000000001", job.id), "ok");
  await runTasks(db, HANDLERS, { worker: "t", limit: 5 });
  assert.equal(await n(`select count(*)::int n from app.entitlement_ledger where job_id = $1 and kind = 'consume'`, [job.id]), 1);
  const view = await loadForCustomer(db, orgId, a.id);
  assert.equal(view?.revisionsLeft, 0);
  assert.equal(await n(`select count(*)::int n from app.article_versions where article_id = $1`, [a.id]), 2, "v1 kept");
  assert.equal(await n(`select delivered_version as n from app.articles where id = $1`, [a.id]), 2);
  assert.equal(await customerRequestRevision(db, orgId, a.id, "One more change please"), "limit");
  assert.equal(await customerApprove(db, orgId, a.id), "ok");
  assert.equal((await jobByTopic("When to Replace a Water Heater")).state, "customer_approved");
});

test("admin can edit text directly and send an article back with a note", async () => {
  const job = await jobByTopic("Signs of a Slab Leak");
  const before = await one<{ content: ArticleContent }>(
    `select v.content from app.article_versions v join app.articles a on a.id = v.article_id and v.version = a.current_version where a.job_id = $1`, [job.id]);
  assert.equal(await adminEdit(db, "00000000-0000-0000-0000-000000000001", job.id, {
    ...before.content, markdown: before.content.markdown + "\n\nWe are the cheap option.",
  }), "ok");
  const report = await one<{ passed: boolean; code_findings: { code: string }[] }>(
    `select q.passed, q.code_findings from app.quality_reports q join app.article_versions v on v.id = q.article_version_id
       join app.articles a on a.id = v.article_id and v.version = a.current_version where a.job_id = $1`, [job.id]);
  assert.equal(report.passed, false, "code checks still apply to admin edits");
  assert.ok(report.code_findings.some((f) => f.code === "avoid_term"));

  assert.equal(await adminRequestRevision(db, "00000000-0000-0000-0000-000000000001", job.id, "Drop the last line."), "ok");
  await wake();
  await work();
  assert.match(prompts.filter((p) => p.schema === "article").at(-1)!.text, /The editor asked: Drop the last line\./);
  assert.equal((await jobByTopic("Signs of a Slab Leak")).state, "admin_review");
});

test("acceptance 6 and 11: AI outages retry, then fail without spending the credit; admin retry resumes with no duplicate", async () => {
  const job = await jobByTopic("Signs of a Slab Leak");
  assert.equal(await giveUp(db, "00000000-0000-0000-0000-000000000001", job.id, true), "ok");
  assert.equal(await n(`select count(*)::int n from app.entitlement_ledger where job_id = $1 and kind = 'release'`, [job.id]), 1);
  assert.equal((await one<{ status: string }>(`select status from app.topics where title = 'Signs of a Slab Leak'`)).status, "retired");

  assert.equal(await scheduleJobs(db), 1, "the returned credit goes to the next approved topic");
  failNext = 4;
  for (let i = 0; i < 4; i++) {
    await wake();
    await work();
  }
  const failed = await jobByTopic("Fixing Low Water Pressure");
  assert.equal(failed.state, "failed");
  const ledger = (await db.query<{ kind: string }>(`select kind from app.entitlement_ledger where job_id = $1`, [failed.id])).rows.map((r) => r.kind);
  assert.deepEqual(ledger, ["reserve"], "still reserved: not consumed, not silently released");
  assert.equal(await scheduleJobs(db), 0, "no second job for the same credit");

  assert.equal(await retryFailed(db, "00000000-0000-0000-0000-000000000001", failed.id), "ok");
  await work();
  const done = await jobByTopic("Fixing Low Water Pressure");
  assert.equal(done.id, failed.id, "same job, no duplicate");
  assert.equal(done.state, "admin_review");
  assert.equal(await n(`select count(*)::int n from app.production_jobs where org_id = $1 and state not in ('cancelled')`, [orgId]), 2);
});

test("the Markdown renderer never lets HTML or script links through", () => {
  const html = renderMarkdown("# Title\n\nHi <script>alert(1)</script> **bold** [x](javascript:alert(1)) [ok](https://a.test)\n\n- one\n- two");
  assert.match(html, /<h2>Title<\/h2>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script|href="javascript/);
  assert.match(html, /<a href="https:\/\/a.test">ok<\/a>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.equal(wordCount("## Hello world\n\nThree more words [link text](https://x.test)"), 7);
});

test("code checks catch prohibited claims, placeholders and thin articles", () => {
  const f = checkArticle(article({ markdown: "We offer same-day service. [Insert city] is great.", meta_description: "" }),
    { minWords: 800, maxWords: 1200, profile, allowedLinks: [] }).map((x) => x.code);
  for (const code of ["prohibited_claim", "placeholder", "too_short", "meta_missing"]) assert.ok(f.includes(code), code);
});
