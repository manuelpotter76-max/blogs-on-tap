import type { Db, Queryable } from "@/lib/db/client";
import { enqueue } from "@/lib/tasks/queue";
import { checkArticle, normalizeArticle, slugify, type ArticleContent } from "./content";
import { wordCount } from "./markdown";
import { loadContext, type Job } from "./jobs";

/**
 * Human decisions on articles: the admin (approve and send, edit, send back,
 * give up, retry) and the customer (approve or ask for changes). Every one
 * checks the job is in the right state inside a transaction, so a double click
 * or two tabs can't do anything twice.
 */
export type ActionResult = "ok" | "wrong_state" | "not_found" | "invalid";

async function lockJob(tx: Queryable, jobId: string): Promise<Job | null> {
  return (await tx.query<Job>(`select * from app.production_jobs where id = $1 for update`, [jobId])).rows[0] ?? null;
}

async function audit(tx: Queryable, orgId: string, actor: string, action: string, target: string, details: object = {}) {
  await tx.query(
    `insert into app.audit_events (org_id, actor, action, target, details) values ($1, $2, $3, $4, $5)`,
    [orgId, actor, action, target, JSON.stringify(details)]);
}

/** Admin approves: the credit is consumed (once), and the article is queued to send. */
export async function approveAndSend(db: Db, adminId: string, jobId: string): Promise<ActionResult> {
  return db.transaction(async (tx) => {
    const job = await lockJob(tx, jobId);
    if (!job) return "not_found";
    if (job.state !== "admin_review") return "wrong_state";
    const art = (await tx.query<{ id: string; current_version: number }>(
      `select id, current_version from app.articles where job_id = $1`, [jobId])).rows[0];
    if (!art?.current_version) return "invalid";

    const consumed = await tx.query(`select 1 from app.entitlement_ledger where job_id = $1 and kind = 'consume'`, [jobId]);
    if (!consumed.rows.length) await tx.query(`select app.consume_credit($1, $2)`, [jobId, `admin:${adminId}`]);

    await tx.query(
      `update app.articles set approved_by = $2, approved_at = now(), customer_decision = null, updated_at = now() where id = $1`,
      [art.id, `admin:${adminId}`]);
    await tx.query(
      `update app.production_jobs set state = 'ready_for_customer', step = 'send', flagged = false, updated_at = now() where id = $1`,
      [jobId]);
    await enqueue(tx, job.org_id, "send_article", `send_article:${art.id}:v${art.current_version}`,
      { article_id: art.id, version: art.current_version });
    await audit(tx, job.org_id, `admin:${adminId}`, "article.approved", jobId, { version: art.current_version });
    return "ok";
  });
}

export type AdminEdit = {
  seo_title: string; meta_description: string; slug: string; excerpt: string; markdown: string; cta: string;
};

/** Admin edits the text directly. New version, code checks only, stays in review. */
export async function adminEdit(db: Db, adminId: string, jobId: string, e: AdminEdit): Promise<ActionResult> {
  const job = (await db.query<Job>(`select * from app.production_jobs where id = $1`, [jobId])).rows[0];
  if (!job) return "not_found";
  if (job.state !== "admin_review") return "wrong_state";
  if (!e.markdown.trim() || !e.seo_title.trim()) return "invalid";
  const ctx = await loadContext(db, job);
  if (!ctx.current || !ctx.article) return "invalid";

  const merged: ArticleContent = {
    ...ctx.current.content,
    seo_title: e.seo_title.slice(0, 200), meta_description: e.meta_description.slice(0, 400),
    slug: slugify(e.slug || e.seo_title), excerpt: e.excerpt.slice(0, 600), markdown: e.markdown.slice(0, 60_000),
    cta: e.cta.slice(0, 400),
  };
  const { content, removedLinks } = normalizeArticle(merged, ctx.links.map((l) => l.url));
  const findings = checkArticle(content, { minWords: ctx.minWords, maxWords: ctx.maxWords, profile: ctx.profile,
    allowedLinks: ctx.links.map((l) => l.url) }, removedLinks);

  return db.transaction(async (tx) => {
    const locked = await lockJob(tx, jobId);
    if (locked?.state !== "admin_review") return "wrong_state";
    const { rows } = await tx.query<{ v: number }>(
      `select coalesce(max(version), 0) + 1 as v from app.article_versions where article_id = $1`, [ctx.article!.id]);
    const v = rows[0].v;
    const { rows: ver } = await tx.query<{ id: string }>(
      `insert into app.article_versions (org_id, article_id, version, content, word_count, created_by)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [job.org_id, ctx.article!.id, v, JSON.stringify(content), wordCount(content.markdown), `admin:${adminId}`]);
    await tx.query(`update app.articles set current_version = $2, updated_at = now() where id = $1`, [ctx.article!.id, v]);
    await tx.query(
      `insert into app.quality_reports (org_id, article_version_id, passed, code_findings)
       values ($1, $2, $3, $4)`,
      [job.org_id, ver[0].id, !findings.some((f) => f.severity === "error"), JSON.stringify(findings)]);
    await audit(tx, job.org_id, `admin:${adminId}`, "article.edited", jobId, { version: v });
    return "ok";
  });
}

/** Admin sends it back to the writer with a note. Fresh automatic QA rounds. */
export async function adminRequestRevision(db: Db, adminId: string, jobId: string, note: string): Promise<ActionResult> {
  const text = note.trim().slice(0, 3000);
  if (text.length < 5) return "invalid";
  return db.transaction(async (tx) => {
    const job = await lockJob(tx, jobId);
    if (!job) return "not_found";
    if (job.state !== "admin_review") return "wrong_state";
    const art = (await tx.query<{ id: string }>(`select id from app.articles where job_id = $1`, [jobId])).rows[0];
    if (!art) return "invalid";
    await tx.query(
      `insert into app.revision_requests (org_id, article_id, requested_by, note) values ($1, $2, $3, $4)`,
      [job.org_id, art.id, `admin:${adminId}`, text]);
    await tx.query(
      `update app.production_jobs set state = 'needs_revision', step = 'revise', qa_rounds = 0, attempts = 0,
              run_after = now(), updated_at = now() where id = $1`, [jobId]);
    await audit(tx, job.org_id, `admin:${adminId}`, "article.sent_back", jobId, { note: text.slice(0, 200) });
    return "ok";
  });
}

/** Admin gives up on a job: the credit comes back. The topic returns to the pool or is retired. */
export async function giveUp(db: Db, adminId: string, jobId: string, retireTopic: boolean): Promise<ActionResult> {
  return db.transaction(async (tx) => {
    const job = await lockJob(tx, jobId);
    if (!job) return "not_found";
    if (!["admin_review", "failed", "needs_revision", "quality_review", "queued", "drafting"].includes(job.state)) return "wrong_state";
    const settled = await tx.query(
      `select 1 from app.entitlement_ledger where job_id = $1 and kind in ('consume', 'release')`, [jobId]);
    if (settled.rows.length) return "wrong_state";
    await tx.query(`select app.release_credit($1, $2, $3)`, [jobId, "admin gave up on this article", `admin:${adminId}`]);
    await tx.query(`update app.production_jobs set state = 'cancelled', updated_at = now() where id = $1`, [jobId]);
    if (retireTopic && job.topic_id) await tx.query(`update app.topics set status = 'retired' where id = $1`, [job.topic_id]);
    await audit(tx, job.org_id, `admin:${adminId}`, "article.given_up", jobId, { retire_topic: retireTopic });
    return "ok";
  });
}

const STEP_STATE: Record<string, string> = { brief: "queued", draft: "drafting", qa: "quality_review", revise: "needs_revision" };

/** Admin retries a failed job from the step where it stopped (acceptance test 11: no duplicate job). */
export async function retryFailed(db: Db, adminId: string, jobId: string): Promise<ActionResult> {
  return db.transaction(async (tx) => {
    const job = await lockJob(tx, jobId);
    if (!job) return "not_found";
    if (job.state !== "failed") return "wrong_state";
    await tx.query(
      `update app.production_jobs set state = $2, attempts = 0, last_error = null, run_after = now(), locked_until = null,
              updated_at = now() where id = $1`, [jobId, STEP_STATE[job.step] ?? "queued"]);
    await audit(tx, job.org_id, `admin:${adminId}`, "article.retried", jobId, { step: job.step });
    return "ok";
  });
}

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------
export type CustomerArticle = {
  articleId: string;
  jobState: string;
  content: ArticleContent | null;
  decision: string | null;
  revisionsLeft: number;
  windowOpen: boolean;
  revisionDays: number;
};

export async function loadForCustomer(db: Queryable, orgId: string, articleId: string): Promise<CustomerArticle | null> {
  const r = (await db.query<{
    id: string; delivered_version: number | null; delivered_at: string | null; customer_decision: string | null;
    customer_revisions: number; state: string; revision_rounds: number; revision_window_days: number;
  }>(
    `select a.id, a.delivered_version, a.delivered_at, a.customer_decision, a.customer_revisions, j.state,
            pv.revision_rounds, pv.revision_window_days
       from app.articles a
       join app.production_jobs j on j.id = a.job_id
       join app.entitlement_cycles c on c.id = j.cycle_id
       join app.subscriptions s on s.id = c.subscription_id
       join app.plan_versions pv on pv.id = s.plan_version_id
      where a.id = $1 and a.org_id = $2`, [articleId, orgId])).rows[0];
  if (!r) return null;
  const content = r.delivered_version
    ? (await db.query<{ content: ArticleContent }>(
        `select content from app.article_versions where article_id = $1 and version = $2`, [r.id, r.delivered_version])).rows[0]?.content ?? null
    : null;
  const windowOpen = !!r.delivered_at && Date.now() - new Date(r.delivered_at).getTime() < r.revision_window_days * 86_400_000;
  return {
    articleId: r.id, jobState: r.state, content, decision: r.customer_decision,
    revisionsLeft: Math.max(0, r.revision_rounds - r.customer_revisions), windowOpen, revisionDays: r.revision_window_days,
  };
}

export async function customerApprove(db: Db, orgId: string, articleId: string): Promise<ActionResult> {
  return db.transaction(async (tx) => {
    const a = (await tx.query<{ job_id: string }>(
      `select job_id from app.articles where id = $1 and org_id = $2`, [articleId, orgId])).rows[0];
    if (!a) return "not_found";
    const job = await lockJob(tx, a.job_id);
    if (job?.state !== "delivered") return "wrong_state";
    await tx.query(
      `update app.articles set customer_decision = 'approved', customer_decided_at = now(), updated_at = now() where id = $1`,
      [articleId]);
    await tx.query(`update app.production_jobs set state = 'customer_approved', updated_at = now() where id = $1`, [a.job_id]);
    await audit(tx, orgId, "customer", "article.customer_approved", a.job_id);
    return "ok";
  });
}

export async function customerRequestRevision(db: Db, orgId: string, articleId: string, note: string): Promise<ActionResult | "limit"> {
  const text = note.trim().slice(0, 3000);
  if (text.length < 5) return "invalid";
  const view = await loadForCustomer(db, orgId, articleId);
  if (!view) return "not_found";
  if (!view.revisionsLeft || !view.windowOpen) return "limit";
  return db.transaction(async (tx) => {
    const a = (await tx.query<{ job_id: string; customer_revisions: number }>(
      `select job_id, customer_revisions from app.articles where id = $1 and org_id = $2 for update`, [articleId, orgId])).rows[0];
    const job = await lockJob(tx, a.job_id);
    if (job?.state !== "delivered") return "wrong_state";
    await tx.query(
      `insert into app.revision_requests (org_id, article_id, requested_by, note) values ($1, $2, 'customer', $3)`,
      [orgId, articleId, text]);
    await tx.query(
      `update app.articles set customer_decision = 'revision_requested', customer_decided_at = now(),
              customer_revisions = customer_revisions + 1, updated_at = now() where id = $1`, [articleId]);
    await tx.query(
      `update app.production_jobs set state = 'customer_revision_requested', step = 'revise', qa_rounds = 0, attempts = 0,
              run_after = now(), updated_at = now() where id = $1`, [a.job_id]);
    await audit(tx, orgId, "customer", "article.customer_revision", a.job_id, { note: text.slice(0, 200) });
    return "ok";
  });
}

