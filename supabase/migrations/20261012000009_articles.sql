-- Blogs on Tap: Phase 4 (briefs, writing, quality review, admin review, delivery)
--
-- * production_jobs (Phase 2) remains the workflow record: one job = one article = one credit.
-- * article_briefs     the plan for one article (Agent: brief)
-- * articles           the deliverable for a job; points at its current version
-- * article_versions   immutable: every AI draft, AI revision and admin edit
-- * quality_reports    code checks + AI review for one version
-- * revision_requests  notes from the admin or customer that the next revision must address

alter table app.access_links drop constraint access_links_purpose_check;
alter table app.access_links add constraint access_links_purpose_check
  check (purpose in ('onboarding', 'profile_review', 'topic_review', 'article_review'));

alter table app.pipeline_tasks drop constraint pipeline_tasks_kind_check;
alter table app.pipeline_tasks add constraint pipeline_tasks_kind_check check (kind in
  ('send_onboarding_invite', 'website_fetch', 'business_research', 'send_profile_review',
   'content_strategy', 'send_topic_review', 'send_article'));

alter table app.production_jobs add column qa_rounds integer not null default 0;   -- AI revisions since the last human note
alter table app.production_jobs add column flagged boolean not null default false; -- reached admin with unresolved QA problems
alter table app.ai_runs add column job_id uuid references app.production_jobs(id);
create index ai_runs_job_idx on app.ai_runs (job_id) where job_id is not null;

create table app.article_briefs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references app.organizations(id) on delete cascade,
  job_id      uuid not null unique references app.production_jobs(id) on delete cascade,
  topic_id    uuid not null references app.topics(id),
  data        jsonb not null,
  ai_run_id   uuid references app.ai_runs(id),
  created_at  timestamptz not null default now()
);

create table app.articles (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references app.organizations(id) on delete cascade,
  job_id           uuid not null unique references app.production_jobs(id) on delete cascade,
  topic_id         uuid not null references app.topics(id),
  current_version  integer,
  delivered_version integer,          -- the version the customer sees
  approved_by      text,              -- admin who released it to the customer
  approved_at      timestamptz,
  delivered_at     timestamptz,
  customer_decision text check (customer_decision in ('approved', 'revision_requested')),
  customer_decided_at timestamptz,
  customer_revisions integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index articles_org_idx on app.articles (org_id, created_at desc);

create table app.article_versions (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references app.organizations(id) on delete cascade,
  article_id   uuid not null references app.articles(id) on delete cascade,
  version      integer not null check (version > 0),
  content      jsonb not null,        -- title, meta, slug, excerpt, markdown, tags, links, cta, source notes
  word_count   integer not null,
  created_by   text not null,         -- 'ai', 'ai_revision', 'admin:<user id>'
  ai_run_id    uuid references app.ai_runs(id),
  created_at   timestamptz not null default now(),
  unique (article_id, version)
);

create table app.quality_reports (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references app.organizations(id) on delete cascade,
  article_version_id  uuid not null references app.article_versions(id) on delete cascade,
  passed              boolean not null,
  high_risk           boolean not null default false,
  code_findings       jsonb not null default '[]'::jsonb,
  ai_review           jsonb,
  ai_run_id           uuid references app.ai_runs(id),
  created_at          timestamptz not null default now()
);
create index quality_reports_version_idx on app.quality_reports (article_version_id, created_at desc);

create table app.revision_requests (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references app.organizations(id) on delete cascade,
  article_id   uuid not null references app.articles(id) on delete cascade,
  requested_by text not null,          -- 'customer' or 'admin:<user id>'
  note         text not null,
  status       text not null default 'open' check (status in ('open', 'addressed')),
  addressed_in integer,                -- article version that addressed it
  created_at   timestamptz not null default now()
);
create index revision_requests_article_idx on app.revision_requests (article_id, status);

-- Open cycles that can take new jobs right now: paid, onboarding done, credits left.
create or replace function app.cycles_needing_jobs()
returns setof uuid language sql stable set search_path = '' as $$
  select c.id
    from app.entitlement_cycles c
    join app.subscriptions s on s.id = c.subscription_id
   where c.status = 'open'
     and s.status in ('active', 'cancel_scheduled')
     and app.org_ready_for_production(c.org_id)
     and (select coalesce(sum(l.delta), 0) from app.entitlement_ledger l where l.cycle_id = c.id) > 0
     and exists (select 1 from app.topics t where t.org_id = c.org_id and t.status = 'approved')
$$;
revoke execute on function app.cycles_needing_jobs() from public;

alter table app.article_briefs    enable row level security;
alter table app.articles          enable row level security;
alter table app.article_versions  enable row level security;
alter table app.quality_reports   enable row level security;   -- server-only (internal review notes)
alter table app.revision_requests enable row level security;

create policy tenant_isolation on app.articles          to app_tenant using (org_id = app.current_org_id());
create policy tenant_isolation on app.article_versions  to app_tenant using (org_id = app.current_org_id());
create policy tenant_isolation on app.revision_requests to app_tenant using (org_id = app.current_org_id());
grant select on app.articles, app.article_versions, app.revision_requests to app_tenant;
