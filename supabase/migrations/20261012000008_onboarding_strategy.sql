-- Blogs on Tap: Phase 3 (onboarding, business profile, content strategy, topic approval)
--
-- New pieces
-- * access_links      signed, expiring customer links (onboarding, profile check, topic approval).
--                     The secret part of a link is an HMAC computed by the server, never stored.
-- * onboarding_responses, source_documents
-- * business_profiles + profile_versions (immutable versions, AI draft vs customer-confirmed)
-- * content_strategies + strategy_versions + topics
-- * ai_runs + ai_model_prices (every model call logged with tokens and cost)
-- * pipeline_tasks    durable queue for onboarding work (emails, website fetch, AI stages)
-- * notifications     every customer email, sent at most once per dedupe key
-- * Production gate   no article jobs until the profile is confirmed and topics are approved,
--                     and every job is tied to one approved topic.

-- ---------------------------------------------------------------------------
-- Customer links
-- ---------------------------------------------------------------------------
create table app.access_links (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references app.organizations(id) on delete cascade,
  purpose       text not null check (purpose in ('onboarding', 'profile_review', 'topic_review')),
  subject_id    uuid,                       -- e.g. the strategy version being reviewed
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index access_links_org_idx on app.access_links (org_id, purpose);

-- ---------------------------------------------------------------------------
-- Onboarding
-- ---------------------------------------------------------------------------
create table app.onboarding_responses (
  org_id              uuid primary key references app.organizations(id) on delete cascade,
  answers             jsonb not null default '{}'::jsonb,
  current_step        integer not null default 0,
  website_consent     boolean not null default false,
  website_consent_at  timestamptz,
  submitted_at        timestamptz,
  updated_at          timestamptz not null default now()
);

create table app.source_documents (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references app.organizations(id) on delete cascade,
  kind            text not null check (kind in ('upload', 'website_page')),
  filename        text,
  mime_type       text,
  size_bytes      integer,
  sha256          text,
  storage_path    text,                     -- uploads: path in the private storage bucket
  source_url      text,                     -- website pages
  extracted_text  text,
  status          text not null default 'stored' check (status in ('stored', 'skipped', 'removed')),
  note            text,
  created_at      timestamptz not null default now()
);
create unique index source_documents_upload_once on app.source_documents (org_id, sha256)
  where kind = 'upload' and status <> 'removed';
create unique index source_documents_page_once on app.source_documents (org_id, source_url)
  where kind = 'website_page';
create index source_documents_org_idx on app.source_documents (org_id, kind);

-- ---------------------------------------------------------------------------
-- AI runs and prices
-- ---------------------------------------------------------------------------
create table app.ai_model_prices (
  model                  text primary key,
  input_per_mtok         numeric(10, 4) not null,
  cached_input_per_mtok  numeric(10, 4) not null default 0,
  output_per_mtok        numeric(10, 4) not null,
  updated_at             timestamptz not null default now()
);

create table app.ai_runs (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references app.organizations(id) on delete cascade,
  stage                 text not null,      -- 'business_research', 'content_strategy', ...
  prompt_version        text not null,
  model                 text not null,
  status                text not null default 'running'
                          check (status in ('running', 'succeeded', 'failed', 'invalid_output')),
  input_tokens          integer,
  cached_input_tokens   integer,
  output_tokens         integer,
  cost_usd              numeric(12, 6),     -- null when the model has no price row
  provider_response_id  text,
  source_refs           jsonb not null default '[]'::jsonb,
  validation_errors     jsonb,
  error                 text,
  task_id               uuid,
  started_at            timestamptz not null default now(),
  finished_at           timestamptz
);
create index ai_runs_org_idx on app.ai_runs (org_id, started_at desc);

-- ---------------------------------------------------------------------------
-- Business profile
-- ---------------------------------------------------------------------------
create table app.business_profiles (
  org_id           uuid primary key references app.organizations(id) on delete cascade,
  status           text not null check (status in ('researching', 'awaiting_customer', 'confirmed')),
  current_version  integer,
  confirmed_at     timestamptz,
  updated_at       timestamptz not null default now()
);

create table app.profile_versions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references app.organizations(id) on delete cascade,
  version     integer not null check (version > 0),
  data        jsonb not null,
  created_by  text not null,                -- 'ai', 'customer', 'admin:<user id>'
  ai_run_id   uuid references app.ai_runs(id),
  created_at  timestamptz not null default now(),
  unique (org_id, version)
);

-- ---------------------------------------------------------------------------
-- Content strategy and topics
-- ---------------------------------------------------------------------------
create table app.content_strategies (
  org_id           uuid primary key references app.organizations(id) on delete cascade,
  status           text not null check (status in ('generating', 'awaiting_customer', 'approved', 'needs_admin')),
  current_version  integer,
  review_rounds    integer not null default 0,
  updated_at       timestamptz not null default now()
);

create table app.strategy_versions (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references app.organizations(id) on delete cascade,
  version          integer not null check (version > 0),
  profile_version  integer not null,
  data             jsonb not null,          -- summary, content pillars, notes
  created_by       text not null,
  ai_run_id        uuid references app.ai_runs(id),
  created_at       timestamptz not null default now(),
  unique (org_id, version)
);

create table app.topics (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references app.organizations(id) on delete cascade,
  strategy_version_id  uuid not null references app.strategy_versions(id),
  topic_key            text not null,       -- normalized title, blocks exact repeats per customer
  title                text not null,
  primary_keyword      text not null,
  search_intent        text not null,
  audience             text not null,
  business_objective   text not null,
  angle                text not null,
  subtopics            jsonb not null default '[]'::jsonb,
  cta                  text not null,
  internal_link_ideas  jsonb not null default '[]'::jsonb,
  pillar               text,
  priority             integer not null default 100,
  status               text not null default 'proposed' check (status in
                         ('proposed', 'approved', 'rejected', 'in_production', 'used', 'retired')),
  customer_note        text,
  decided_at           timestamptz,
  decided_by           text,
  created_at           timestamptz not null default now(),
  unique (org_id, topic_key)
);
create index topics_org_status_idx on app.topics (org_id, status, priority);

-- ---------------------------------------------------------------------------
-- Durable task queue for onboarding work
-- ---------------------------------------------------------------------------
create table app.pipeline_tasks (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references app.organizations(id) on delete cascade,
  kind          text not null check (kind in
                  ('send_onboarding_invite', 'website_fetch', 'business_research',
                   'send_profile_review', 'content_strategy', 'send_topic_review')),
  dedupe_key    text not null unique,
  payload       jsonb not null default '{}'::jsonb,
  state         text not null default 'pending' check (state in ('pending', 'running', 'done', 'failed', 'cancelled')),
  attempts      integer not null default 0,
  max_attempts  integer not null default 4,
  run_after     timestamptz not null default now(),
  locked_until  timestamptz,
  locked_by     text,
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index pipeline_tasks_runnable_idx on app.pipeline_tasks (run_after) where state in ('pending', 'running');
create index pipeline_tasks_org_idx on app.pipeline_tasks (org_id, created_at desc);

create or replace function app.claim_tasks(p_worker text, p_limit integer, p_lease_seconds integer default 240)
returns setof app.pipeline_tasks language plpgsql set search_path = '' as $$
begin
  return query
  update app.pipeline_tasks t
     set state = 'running',
         locked_by = p_worker,
         locked_until = now() + make_interval(secs => p_lease_seconds),
         attempts = t.attempts + 1,
         updated_at = now()
   where t.id in (
     select id from app.pipeline_tasks
      where run_after <= now()
        and (state = 'pending' or (state = 'running' and locked_until < now()))
      order by run_after
      limit p_limit
      for update skip locked)
  returning t.*;
end $$;
revoke execute on function app.claim_tasks(text, integer, integer) from public;

-- ---------------------------------------------------------------------------
-- Customer emails
-- ---------------------------------------------------------------------------
create table app.notifications (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references app.organizations(id) on delete cascade,
  kind                 text not null,
  dedupe_key           text not null unique,
  to_email             text not null,
  subject              text not null,
  link_id              uuid references app.access_links(id),
  status               text not null default 'sending'
                         check (status in ('sending', 'sent', 'failed', 'uncertain')),
  provider             text,
  provider_message_id  text,
  error                text,
  created_at           timestamptz not null default now(),
  sent_at              timestamptz
);
create index notifications_org_idx on app.notifications (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Production gate: jobs need a confirmed profile and an approved topic each
-- ---------------------------------------------------------------------------
alter table app.production_jobs add column topic_id uuid references app.topics(id);
create unique index production_jobs_one_live_job_per_topic on app.production_jobs (topic_id)
  where topic_id is not null and state not in ('failed', 'cancelled');

create or replace function app.org_ready_for_production(p_org_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select exists (select 1 from app.business_profiles where org_id = p_org_id and status = 'confirmed')
     and exists (select 1 from app.content_strategies where org_id = p_org_id and status = 'approved')
$$;

-- Same as before, plus: nothing until onboarding is done, at most one job per
-- approved topic, and each new job takes the highest-priority approved topic.
create or replace function app.ensure_jobs_for_cycle(p_cycle_id uuid)
returns integer language plpgsql set search_path = '' as $$
declare
  v_cycle     app.entitlement_cycles;
  v_sub_ok    boolean;
  v_available integer;
  v_next_slot integer;
  v_job       uuid;
  v_topic     uuid;
  v_created   integer := 0;
begin
  select * into strict v_cycle from app.entitlement_cycles where id = p_cycle_id for update;
  if v_cycle.status <> 'open' then
    return 0;
  end if;

  select status in ('active', 'cancel_scheduled') into v_sub_ok
    from app.subscriptions where id = v_cycle.subscription_id;
  if not coalesce(v_sub_ok, false) then
    return 0;   -- acceptance test 8
  end if;
  if not app.org_ready_for_production(v_cycle.org_id) then
    return 0;   -- acceptance tests 3 and 4
  end if;

  select coalesce(sum(delta), 0) into v_available
    from app.entitlement_ledger where cycle_id = p_cycle_id;
  select coalesce(max(slot), 0) + 1 into v_next_slot
    from app.production_jobs where cycle_id = p_cycle_id;

  while v_available > 0 loop
    select id into v_topic from app.topics
     where org_id = v_cycle.org_id and status = 'approved'
     order by priority, created_at
     limit 1
     for update skip locked;
    exit when v_topic is null;   -- out of approved topics: strategy needs topping up

    insert into app.production_jobs (org_id, cycle_id, slot, topic_id)
    values (v_cycle.org_id, p_cycle_id, v_next_slot, v_topic)
    returning id into v_job;
    update app.topics set status = 'in_production' where id = v_topic;

    insert into app.entitlement_ledger (org_id, cycle_id, job_id, kind, delta)
    values (v_cycle.org_id, p_cycle_id, v_job, 'reserve', -1);

    v_available := v_available - 1;
    v_next_slot := v_next_slot + 1;
    v_created := v_created + 1;
  end loop;

  return v_created;
end $$;

-- A released credit also hands its topic back for the replacement job.
create or replace function app.release_credit(p_job_id uuid, p_reason text, p_actor text default 'system')
returns void language plpgsql set search_path = '' as $$
declare v_job app.production_jobs;
begin
  select * into strict v_job from app.production_jobs where id = p_job_id for update;
  insert into app.entitlement_ledger (org_id, cycle_id, job_id, kind, delta, reason, actor)
  values (v_job.org_id, v_job.cycle_id, p_job_id, 'release', 1, p_reason, p_actor);
  if v_job.topic_id is not null then
    update app.production_jobs set state = 'cancelled', updated_at = now()
     where id = p_job_id and state not in ('failed', 'cancelled');
    update app.topics set status = 'approved' where id = v_job.topic_id and status = 'in_production';
  end if;
end $$;

revoke execute on function app.org_ready_for_production(uuid) from public;
revoke execute on function app.ensure_jobs_for_cycle(uuid) from public;
revoke execute on function app.release_credit(uuid, text, text) from public;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table app.access_links         enable row level security;   -- server-only
alter table app.notifications        enable row level security;   -- server-only
alter table app.pipeline_tasks       enable row level security;   -- server-only
alter table app.ai_runs              enable row level security;   -- server-only
alter table app.ai_model_prices      enable row level security;   -- server-only
alter table app.onboarding_responses enable row level security;
alter table app.source_documents     enable row level security;
alter table app.business_profiles    enable row level security;
alter table app.profile_versions     enable row level security;
alter table app.content_strategies   enable row level security;
alter table app.strategy_versions    enable row level security;
alter table app.topics               enable row level security;

create policy tenant_isolation on app.onboarding_responses to app_tenant using (org_id = app.current_org_id());
create policy tenant_isolation on app.source_documents     to app_tenant using (org_id = app.current_org_id());
create policy tenant_isolation on app.business_profiles    to app_tenant using (org_id = app.current_org_id());
create policy tenant_isolation on app.profile_versions     to app_tenant using (org_id = app.current_org_id());
create policy tenant_isolation on app.content_strategies   to app_tenant using (org_id = app.current_org_id());
create policy tenant_isolation on app.strategy_versions    to app_tenant using (org_id = app.current_org_id());
create policy tenant_isolation on app.topics               to app_tenant using (org_id = app.current_org_id());

grant select on app.onboarding_responses, app.source_documents, app.business_profiles,
                app.profile_versions, app.content_strategies, app.strategy_versions, app.topics
  to app_tenant;

-- Supabase advisor (rls_disabled): these three had RLS off. They were never
-- reachable by Supabase's API roles (no schema access), but turn it on anyway.
-- Plans are public catalog data, so tenants may read every row.
alter table app.users         enable row level security;   -- server-only
alter table app.plans         enable row level security;
alter table app.plan_versions enable row level security;
create policy catalog_read on app.plans         to app_tenant using (true);
create policy catalog_read on app.plan_versions to app_tenant using (true);

-- Heartbeats also count onboarding tasks run per tick.
alter table app.worker_heartbeats add column tasks_run integer not null default 0;
