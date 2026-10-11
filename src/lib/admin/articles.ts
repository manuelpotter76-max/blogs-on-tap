import type { Db } from "../db/client";
import type { ArticleContent, Finding } from "../articles/content";
import type { Brief, QaReview } from "../agents/writing";
import { linkUrl } from "../links";

export type ArticleJobRow = {
  job_id: string; org_id: string; customer: string; topic: string | null; title: string | null; state: string;
  flagged: boolean; last_error: string | null; updated_at: string; version: number | null; cost_usd: string | null;
};

/** Every article job, newest activity first. The page groups them by what needs doing. */
export async function listArticleJobs(db: Db): Promise<ArticleJobRow[]> {
  const { rows } = await db.query<ArticleJobRow>(`
    select j.id as job_id, j.org_id, o.name as customer, t.title as topic, v.content->>'seo_title' as title,
           j.state, j.flagged, j.last_error, j.updated_at, a.current_version as version,
           (select sum(r.cost_usd)::text from app.ai_runs r where r.job_id = j.id) as cost_usd
      from app.production_jobs j
      join app.organizations o on o.id = j.org_id
      left join app.topics t on t.id = j.topic_id
      left join app.articles a on a.job_id = j.id
      left join app.article_versions v on v.article_id = a.id and v.version = a.current_version
     where j.state <> 'cancelled'
     order by j.updated_at desc
     limit 200`);
  return rows;
}

export type ArticleJobDetail = {
  job: { id: string; org_id: string; state: string; step: string; flagged: boolean; qa_rounds: number; last_error: string | null; updated_at: string };
  customer: { name: string; regulated: string | null };
  topic: { title: string; primary_keyword: string; audience: string; angle: string } | null;
  brief: Brief | null;
  article: { id: string; current_version: number | null; delivered_version: number | null; customer_decision: string | null } | null;
  current: { id: string; version: number; content: ArticleContent; word_count: number; created_by: string; created_at: string } | null;
  versions: { version: number; created_by: string; created_at: string; word_count: number }[];
  report: { passed: boolean; high_risk: boolean; code_findings: Finding[]; ai_review: QaReview | null } | null;
  revisions: { requested_by: string; note: string; status: string; created_at: string }[];
  costUsd: number;
  customerLink: string | null;
};

export async function getArticleJob(db: Db, jobId: string): Promise<ArticleJobDetail | null> {
  const job = (await db.query<ArticleJobDetail["job"] & { topic_id: string | null }>(
    `select id, org_id, state, step, flagged, qa_rounds, last_error, updated_at, topic_id from app.production_jobs where id = $1`,
    [jobId])).rows[0];
  if (!job) return null;
  const customer = (await db.query<ArticleJobDetail["customer"]>(
    `select o.name, pv.data->'compliance'->>'regulated_field' as regulated from app.organizations o
       left join app.business_profiles bp on bp.org_id = o.id
       left join app.profile_versions pv on pv.org_id = o.id and pv.version = bp.current_version
      where o.id = $1`, [job.org_id])).rows[0];
  const topic = job.topic_id ? (await db.query<NonNullable<ArticleJobDetail["topic"]>>(
    `select title, primary_keyword, audience, angle from app.topics where id = $1`, [job.topic_id])).rows[0] ?? null : null;
  const brief = (await db.query<{ data: Brief }>(`select data from app.article_briefs where job_id = $1`, [jobId])).rows[0]?.data ?? null;
  const article = (await db.query<NonNullable<ArticleJobDetail["article"]>>(
    `select id, current_version, delivered_version, customer_decision from app.articles where job_id = $1`, [jobId])).rows[0] ?? null;

  let current: ArticleJobDetail["current"] = null;
  let versions: ArticleJobDetail["versions"] = [];
  let report: ArticleJobDetail["report"] = null;
  let revisions: ArticleJobDetail["revisions"] = [];
  let customerLink: string | null = null;
  if (article) {
    versions = (await db.query<ArticleJobDetail["versions"][number]>(
      `select version, created_by, created_at, word_count from app.article_versions where article_id = $1 order by version desc`,
      [article.id])).rows;
    current = (await db.query<NonNullable<ArticleJobDetail["current"]>>(
      `select id, version, content, word_count, created_by, created_at from app.article_versions
        where article_id = $1 and version = $2`, [article.id, article.current_version])).rows[0] ?? null;
    if (current) {
      report = (await db.query<NonNullable<ArticleJobDetail["report"]>>(
        `select passed, high_risk, code_findings, ai_review from app.quality_reports
          where article_version_id = $1 order by created_at desc limit 1`, [current.id])).rows[0] ?? null;
    }
    revisions = (await db.query<ArticleJobDetail["revisions"][number]>(
      `select requested_by, note, status, created_at from app.revision_requests where article_id = $1 order by created_at desc`,
      [article.id])).rows;
    const link = (await db.query<{ id: string }>(
      `select id from app.access_links where purpose = 'article_review' and subject_id = $1 and revoked_at is null
          and expires_at > now() order by created_at desc limit 1`, [article.id])).rows[0];
    try {
      customerLink = link ? linkUrl(link.id, "article_review") : null;
    } catch {
      customerLink = null;
    }
  }
  const cost = (await db.query<{ usd: string | null }>(`select sum(cost_usd)::text as usd from app.ai_runs where job_id = $1`, [jobId])).rows[0];

  return { job, customer, topic, brief, article, current, versions, report, revisions, costUsd: Number(cost?.usd ?? 0), customerLink };
}
