import type { Db, Queryable } from "@/lib/db/client";
import { callStructured, modelFor, type Fetcher } from "@/lib/ai/openai";
import type { BusinessProfile } from "@/lib/agents/business-profile";
import {
  BRIEF_INSTRUCTIONS, BRIEF_SCHEMA, BRIEF_VERSION, QA_INSTRUCTIONS, QA_SCHEMA, QA_VERSION, REVISION_INSTRUCTIONS,
  WRITER_INSTRUCTIONS, WRITER_VERSION, ARTICLE_SCHEMA, briefInput, changesFrom, qaInput, qaPasses, revisionInput,
  writerInput, type AllowedLink, type Brief, type QaReview, type TopicRow,
} from "@/lib/agents/writing";
import { checkArticle, normalizeArticle, type ArticleContent, type Finding } from "./content";
import { normUrl, wordCount } from "./markdown";
import { alertAdmin } from "@/lib/email/admin-alerts";
import { enqueue } from "@/lib/tasks/queue";

/**
 * The article pipeline. One production job = one article = one credit.
 *
 *   queued/brief -> drafting/draft -> quality_review/qa -> admin_review
 *                                            |  fails, < 2 rounds
 *                                            v
 *                                   needs_revision/revise -> quality_review/qa
 *
 * Admin approves (credit consumed) -> ready_for_customer -> delivered (email sent)
 * -> customer_approved, or customer_revision_requested/revise -> qa -> admin_review again.
 *
 * Every step is idempotent: if the function dies after the AI call but before
 * the state change, the re-run finds the saved brief, version or report and
 * moves on instead of paying for it twice.
 */
export const MAX_QA_ROUNDS = 2;
export const MAX_FAILED_TRIES = 4;
const BACKOFF = [60, 300, 900, 1800];

export type Job = {
  id: string; org_id: string; cycle_id: string; topic_id: string | null; state: string; step: string;
  attempts: number; qa_rounds: number;
};

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------
/** Open job slots for every paid, ready cycle with credits and approved topics. */
export async function scheduleJobs(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ id: string }>(`select app.cycles_needing_jobs() as id`);
  let created = 0;
  for (const r of rows) {
    const out = await db.query<{ n: number }>(`select app.ensure_jobs_for_cycle($1) as n`, [r.id]);
    created += out.rows[0]?.n ?? 0;
  }
  await topUpTopics(db);
  return created;
}

/**
 * Keep every paying, onboarded customer stocked with approved topics. When
 * fewer than one cycle's worth remain, nothing is waiting on the customer and
 * no strategy run is queued, ask the strategist for more (at most once a day).
 * Without this, production would quietly stop once the first batch ran out.
 */
export async function topUpTopics(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ org_id: string }>(`
    select cs.org_id
      from app.content_strategies cs
      join app.business_profiles bp on bp.org_id = cs.org_id and bp.status = 'confirmed'
      join lateral (
        select pv.articles_per_cycle from app.subscriptions s join app.plan_versions pv on pv.id = s.plan_version_id
         where s.org_id = cs.org_id and s.status in ('active', 'cancel_scheduled')
         order by s.created_at desc limit 1) plan on true
     where cs.status = 'approved'
       and (select count(*) from app.topics t where t.org_id = cs.org_id and t.status = 'approved') < plan.articles_per_cycle
       and not exists (select 1 from app.topics t where t.org_id = cs.org_id and t.status = 'proposed')
       and not exists (select 1 from app.pipeline_tasks p where p.org_id = cs.org_id and p.kind = 'content_strategy'
                         and p.state in ('pending', 'running'))`);
  let queued = 0;
  const day = new Date().toISOString().slice(0, 10);
  for (const r of rows) {
    if (await enqueue(db, r.org_id, "content_strategy", `content_strategy:${r.org_id}:topup:${day}`)) queued++;
  }
  return queued;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------
type Ctx = {
  job: Job;
  topic: TopicRow & { id: string };
  profile: BusinessProfile;
  minWords: number;
  maxWords: number;
  links: AllowedLink[];
  others: string[];
  brief: Brief | null;
  article: { id: string; current_version: number | null } | null;
  current: { id: string; version: number; content: ArticleContent } | null;
};

function ctaLink(destination: string): AllowedLink[] {
  const d = destination.trim();
  if (/^https?:\/\//i.test(d)) return [{ url: d, label: "call to action" }];
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d)) return [{ url: `mailto:${d}`, label: "email for the call to action" }];
  const digits = d.replace(/[^\d+]/g, "");
  if (digits.replace(/\D/g, "").length >= 10) return [{ url: `tel:${digits}`, label: "phone for the call to action" }];
  return [];
}

export async function loadContext(db: Queryable, job: Job): Promise<Ctx> {
  const topic = (await db.query<Ctx["topic"]>(
    `select id, title, primary_keyword, search_intent, audience, business_objective, angle, subtopics, cta, internal_link_ideas
       from app.topics where id = $1`, [job.topic_id])).rows[0];
  if (!topic) throw new Error("job has no topic");
  const prof = (await db.query<{ data: BusinessProfile }>(
    `select pv.data from app.business_profiles bp
       join app.profile_versions pv on pv.org_id = bp.org_id and pv.version = bp.current_version
      where bp.org_id = $1 and bp.status = 'confirmed'`, [job.org_id])).rows[0];
  if (!prof) throw new Error("profile is not confirmed");
  const plan = (await db.query<{ min_words: number; max_words: number }>(
    `select pv.min_words, pv.max_words from app.entitlement_cycles c
       join app.subscriptions s on s.id = c.subscription_id
       join app.plan_versions pv on pv.id = s.plan_version_id where c.id = $1`, [job.cycle_id])).rows[0];
  const pages = (await db.query<{ source_url: string; extracted_text: string | null }>(
    `select source_url, extracted_text from app.source_documents
      where org_id = $1 and kind = 'website_page' and status = 'stored' order by created_at limit 40`, [job.org_id])).rows;
  const website = (await db.query<{ website: string | null }>(`select website from app.organizations where id = $1`, [job.org_id])).rows[0];

  const seen = new Set<string>();
  const links: AllowedLink[] = [];
  const add = (l: AllowedLink) => {
    const k = normUrl(l.url);
    if (!seen.has(k)) {
      seen.add(k);
      links.push(l);
    }
  };
  for (const p of pages) add({ url: p.source_url, label: p.extracted_text?.match(/^Title: (.+)$/m)?.[1]?.slice(0, 80) ?? "page on their site" });
  if (website?.website) add({ url: website.website, label: "home page" });
  for (const l of ctaLink(prof.data.cta.destination)) add(l);

  const others = (await db.query<{ title: string }>(
    `select title from app.topics where org_id = $1 and id <> $2 and status in ('approved', 'in_production', 'used')`,
    [job.org_id, topic.id])).rows.map((r) => r.title);
  others.push(...prof.data.existing_content);

  const brief = (await db.query<{ data: Brief }>(`select data from app.article_briefs where job_id = $1`, [job.id])).rows[0]?.data ?? null;
  const article = (await db.query<{ id: string; current_version: number | null }>(
    `select id, current_version from app.articles where job_id = $1`, [job.id])).rows[0] ?? null;
  const current = article?.current_version
    ? (await db.query<NonNullable<Ctx["current"]>>(
        `select id, version, content from app.article_versions where article_id = $1 and version = $2`,
        [article.id, article.current_version])).rows[0] ?? null
    : null;

  return {
    job, topic, profile: prof.data, minWords: plan?.min_words ?? 800, maxWords: plan?.max_words ?? 1200,
    links, others: others.slice(0, 60), brief, article, current,
  };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------
async function setStep(db: Queryable, jobId: string, state: string, step: string, extra = "") {
  await db.query(
    `update app.production_jobs set state = $2, step = $3, attempts = 0, last_error = null, run_after = now(),
            updated_at = now() ${extra} where id = $1`, [jobId, state, step]);
}

async function audit(db: Queryable, orgId: string, action: string, target: string, details: object) {
  await db.query(
    `insert into app.audit_events (org_id, actor, action, target, details) values ($1, 'system', $2, $3, $4)`,
    [orgId, action, target, JSON.stringify(details)]);
}

async function stepBrief(db: Db, ctx: Ctx, fetcher?: Fetcher) {
  if (!ctx.brief) {
    const r = await callStructured<Brief>(db, {
      orgId: ctx.job.org_id, stage: "article_brief", promptVersion: BRIEF_VERSION, model: modelFor("brief"),
      instructions: BRIEF_INSTRUCTIONS, schemaName: "article_brief", schema: BRIEF_SCHEMA, jobId: ctx.job.id,
      input: [{ type: "input_text", text: briefInput({ ...ctx, topic: ctx.topic }) }],
      sourceRefs: [{ kind: "topic", id: ctx.topic.id }],
    }, fetcher);
    await db.query(
      `insert into app.article_briefs (org_id, job_id, topic_id, data, ai_run_id) values ($1, $2, $3, $4, $5)
       on conflict (job_id) do nothing`, [ctx.job.org_id, ctx.job.id, ctx.topic.id, JSON.stringify(r.data), r.runId]);
  }
  await setStep(db, ctx.job.id, "drafting", "draft");
}

async function saveVersion(db: Db, ctx: Ctx, raw: ArticleContent, createdBy: string, runId: string | null): Promise<number> {
  const { content } = normalizeArticle(raw, ctx.links.map((l) => l.url));
  return db.transaction(async (tx) => {
    const art = (await tx.query<{ id: string }>(
      `insert into app.articles (org_id, job_id, topic_id) values ($1, $2, $3)
       on conflict (job_id) do update set updated_at = now() returning id`,
      [ctx.job.org_id, ctx.job.id, ctx.topic.id])).rows[0];
    const { rows } = await tx.query<{ v: number }>(
      `select coalesce(max(version), 0) + 1 as v from app.article_versions where article_id = $1`, [art.id]);
    const v = rows[0].v;
    await tx.query(
      `insert into app.article_versions (org_id, article_id, version, content, word_count, created_by, ai_run_id)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [ctx.job.org_id, art.id, v, JSON.stringify(content), wordCount(content.markdown), createdBy, runId]);
    await tx.query(`update app.articles set current_version = $2, updated_at = now() where id = $1`, [art.id, v]);
    return v;
  });
}

async function stepDraft(db: Db, ctx: Ctx, fetcher?: Fetcher) {
  if (!ctx.current) {
    if (!ctx.brief) throw new Error("no brief");
    const r = await callStructured<ArticleContent>(db, {
      orgId: ctx.job.org_id, stage: "article_writing", promptVersion: WRITER_VERSION, model: modelFor("writing"),
      instructions: WRITER_INSTRUCTIONS, schemaName: "article", schema: ARTICLE_SCHEMA, jobId: ctx.job.id,
      input: [{ type: "input_text", text: writerInput({ ...ctx, brief: ctx.brief }) }],
      sourceRefs: [{ kind: "topic", id: ctx.topic.id }], maxOutputTokens: 20_000,
    }, fetcher);
    await saveVersion(db, ctx, r.data, "ai", r.runId);
  }
  await setStep(db, ctx.job.id, "quality_review", "qa");
}

export function codeFindings(ctx: Pick<Ctx, "minWords" | "maxWords" | "profile" | "links">, content: ArticleContent): Finding[] {
  return checkArticle(content, { minWords: ctx.minWords, maxWords: ctx.maxWords, profile: ctx.profile,
    allowedLinks: ctx.links.map((l) => l.url) });
}

async function stepQa(db: Db, ctx: Ctx, fetcher?: Fetcher) {
  if (!ctx.current) throw new Error("no draft to review");
  let report = (await db.query<{ passed: boolean; high_risk: boolean }>(
    `select passed, high_risk from app.quality_reports where article_version_id = $1 and ai_review is not null
      order by created_at desc limit 1`, [ctx.current.id])).rows[0];

  if (!report) {
    const findings = codeFindings(ctx, ctx.current.content);
    const errors = findings.filter((f) => f.severity === "error");
    const r = await callStructured<QaReview>(db, {
      orgId: ctx.job.org_id, stage: "quality_review", promptVersion: QA_VERSION, model: modelFor("qa"),
      instructions: QA_INSTRUCTIONS, schemaName: "quality_review", schema: QA_SCHEMA, jobId: ctx.job.id,
      input: [{ type: "input_text", text: qaInput({ ...ctx, article: ctx.current.content,
        codeFindings: findings.filter((f) => f.severity !== "info").map((f) => f.message) }) }],
      sourceRefs: [{ kind: "article_version", id: ctx.current.id }],
    }, fetcher);
    const passed = qaPasses(r.data, errors.length);
    const highRisk = r.data.high_risk || ctx.profile.compliance.regulated_field !== "none";
    await db.query(
      `insert into app.quality_reports (org_id, article_version_id, passed, high_risk, code_findings, ai_review, ai_run_id)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [ctx.job.org_id, ctx.current.id, passed, highRisk, JSON.stringify(findings), JSON.stringify(r.data), r.runId]);
    report = { passed, high_risk: highRisk };
  }

  if (report.passed) {
    // Passed. High-risk content (regulated fields, possible liability) still gets a flag for extra care.
    await setStep(db, ctx.job.id, "admin_review", "admin", report.high_risk ? ", flagged = true" : ", flagged = false");
    await alertAdmin(db, { orgId: ctx.job.org_id, kind: "article_review", dedupeKey: `review:${ctx.current.id}`,
      detail: `"${ctx.current.content.seo_title}" passed the quality check${report.high_risk ? " (flagged: read carefully)" : ""}.`,
      path: `/admin/articles/${ctx.job.id}` });
  } else if (ctx.job.qa_rounds < MAX_QA_ROUNDS) {
    await setStep(db, ctx.job.id, "needs_revision", "revise", ", qa_rounds = qa_rounds + 1");
  } else {
    // Out of automatic tries: a person decides (acceptance test 7).
    await setStep(db, ctx.job.id, "admin_review", "admin", ", flagged = true");
    await audit(db, ctx.job.org_id, "article.qa_escalated", ctx.job.id, { version: ctx.current.version });
    await alertAdmin(db, { orgId: ctx.job.org_id, kind: "article_review", dedupeKey: `review:${ctx.current.id}`,
      detail: `"${ctx.current.content.seo_title}" still has quality problems after ${MAX_QA_ROUNDS} automatic revisions. It needs you.`,
      path: `/admin/articles/${ctx.job.id}` });
  }
}

async function stepRevise(db: Db, ctx: Ctx, fetcher?: Fetcher) {
  if (!ctx.current || !ctx.article) throw new Error("no draft to revise");
  const requests = (await db.query<{ id: string; note: string; requested_by: string }>(
    `select id, note, requested_by from app.revision_requests where article_id = $1 and status = 'open' order by created_at`,
    [ctx.article.id])).rows;
  const changes = requests.map((r) => `${r.requested_by === "customer" ? "The customer asked" : "The editor asked"}: ${r.note}`);

  if (ctx.job.state === "needs_revision" && !requests.length) {
    const qa = (await db.query<{ code_findings: Finding[]; ai_review: QaReview | null }>(
      `select code_findings, ai_review from app.quality_reports where article_version_id = $1 order by created_at desc limit 1`,
      [ctx.current.id])).rows[0];
    changes.push(...changesFrom(qa?.code_findings ?? [], qa?.ai_review ?? null));
  }
  if (!changes.length) changes.push("Tighten the writing and make sure every claim is supported by the profile.");

  const base = writerInput({ ...ctx, brief: ctx.brief ?? ({} as Brief) });
  const r = await callStructured<ArticleContent>(db, {
    orgId: ctx.job.org_id, stage: "article_revision", promptVersion: WRITER_VERSION, model: modelFor("writing"),
    instructions: REVISION_INSTRUCTIONS, schemaName: "article", schema: ARTICLE_SCHEMA, jobId: ctx.job.id,
    input: [{ type: "input_text", text: revisionInput(base, ctx.current.content, changes) }],
    sourceRefs: [{ kind: "article_version", id: ctx.current.id }], maxOutputTokens: 20_000,
  }, fetcher);
  const v = await saveVersion(db, ctx, r.data, "ai_revision", r.runId);
  if (requests.length) {
    await db.query(
      `update app.revision_requests set status = 'addressed', addressed_in = $2 where article_id = $1 and status = 'open'`,
      [ctx.article.id, v]);
  }
  await setStep(db, ctx.job.id, "quality_review", "qa");
}

const STEPS: Record<string, (db: Db, ctx: Ctx, fetcher?: Fetcher) => Promise<void>> = {
  brief: stepBrief, draft: stepDraft, qa: stepQa, revise: stepRevise,
};
const RUNNABLE = new Set(["queued", "drafting", "quality_review", "needs_revision", "customer_revision_requested"]);

/**
 * Claim one job and move it forward step by step until it waits on a person
 * or time runs out. Errors back off and retry; after MAX_FAILED_TRIES the job
 * is marked failed for the admin. A failure never consumes the credit
 * (acceptance test 6): the reservation stays until the admin retries or gives up.
 */
export async function runArticleJobs(db: Db, opts: { worker: string; deadlineMs: number; fetcher?: Fetcher }): Promise<{ steps: number; failed: number }> {
  const deadline = Date.now() + opts.deadlineMs;
  const out = { steps: 0, failed: 0 };
  const { rows } = await db.query<Job>(`select * from app.claim_jobs($1, 1, 300)`, [opts.worker]);
  const claimed = rows[0];
  if (!claimed) return out;

  // A step that kills the function (timeout, crash) never reaches the catch
  // below, so the claim count is the only thing that grows. Stop it here
  // instead of paying for the same AI call every few minutes forever.
  if (claimed.attempts > MAX_FAILED_TRIES + 1) {
    const msg = "Stopped after repeated crashes or timeouts on this step";
    await db.query(
      `update app.production_jobs set state = 'failed', last_error = $2, locked_until = null, locked_by = null,
              updated_at = now() where id = $1`, [claimed.id, msg]);
    await audit(db, claimed.org_id, "article.failed", claimed.id, { step: claimed.step, error: msg });
    await alertAdmin(db, { orgId: claimed.org_id, kind: "article_failed", dedupeKey: `failed:${claimed.id}:${claimed.attempts}`,
      detail: `${msg} (${claimed.step}). The credit is still reserved. Retry or give up from the article page.`,
      path: `/admin/articles/${claimed.id}` });
    out.failed++;
    return out;
  }

  let job = claimed;
  try {
    while (RUNNABLE.has(job.state) && Date.now() < deadline) {
      const step = STEPS[job.step];
      if (!step) throw new Error(`unknown step "${job.step}"`);
      await step(db, await loadContext(db, job), opts.fetcher);
      out.steps++;
      job = (await db.query<Job>(`select * from app.production_jobs where id = $1`, [job.id])).rows[0];
    }
    await db.query(`update app.production_jobs set locked_until = null, locked_by = null where id = $1`, [job.id]);
  } catch (err) {
    const msg = `${(err as Error).name}: ${(err as Error).message}`.slice(0, 2000);
    const tries = (await db.query<{ attempts: number }>(`select attempts from app.production_jobs where id = $1`, [job.id])).rows[0].attempts;
    console.error(`article job ${job.id} step ${job.step} failed (try ${tries}):`, msg);
    if (tries >= MAX_FAILED_TRIES) {
      await db.query(
        `update app.production_jobs set state = 'failed', last_error = $2, locked_until = null, locked_by = null,
                updated_at = now() where id = $1`, [job.id, msg]);
      await audit(db, job.org_id, "article.failed", job.id, { step: job.step, error: msg });
      await alertAdmin(db, { orgId: job.org_id, kind: "article_failed", dedupeKey: `failed:${job.id}:${tries}:${Date.now()}`,
        detail: `Failed at the "${job.step}" step after ${tries} tries: ${msg}. The credit is still reserved.`,
        path: `/admin/articles/${job.id}` });
      out.failed++;
    } else {
      await db.query(
        `update app.production_jobs set last_error = $2, locked_until = null, locked_by = null, updated_at = now(),
                run_after = now() + make_interval(secs => $3) where id = $1`,
        [job.id, msg, BACKOFF[Math.min(tries - 1, BACKOFF.length - 1)]]);
    }
  }
  return out;
}
