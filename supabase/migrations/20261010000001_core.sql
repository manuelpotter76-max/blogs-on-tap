-- Blogs on Tap: core schema (Phase 2, milestones M1 to M3)
-- Identity, plans, subscriptions, billing events, entitlement ledger,
-- production job skeleton, audit log, tenant row-level security.
--
-- Design notes
-- * Everything lives in schema "app", which Supabase does not expose through
--   its public REST API. Only our server talks to it.
-- * Tenant isolation: customer-facing requests run as role app_tenant with
--   SET LOCAL app.org_id = '<uuid>'. RLS policies compare against that.
-- * Credits are never a counter we overwrite. Every change is a ledger row,
--   and unique indexes make double grants, double reserves and double
--   consumes impossible at the database level.

create extension if not exists pgcrypto;

create schema if not exists app;

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_tenant') then
    create role app_tenant nologin;
  end if;
end $$;

grant app_tenant to current_user;
grant usage on schema app to app_tenant;

-- Keep Supabase's API roles out of the app schema entirely.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema app from %I', r);
    end if;
  end loop;
end $$;

create or replace function app.current_org_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.org_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
create table app.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  website     text,
  status      text not null default 'active' check (status in ('active', 'archived')),
  created_at  timestamptz not null default now()
);

create table app.users (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  full_name   text,
  created_at  timestamptz not null default now()
);
create unique index users_email_key on app.users (lower(email));

create table app.memberships (
  org_id      uuid not null references app.organizations(id) on delete cascade,
  user_id     uuid not null references app.users(id) on delete cascade,
  role        text not null default 'owner' check (role in ('owner', 'member')),
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);

-- Platform staff (you). Separate from customer memberships on purpose.
create table app.platform_admins (
  user_id     uuid primary key references app.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- External identifiers live apart from our canonical IDs.
create table app.external_ids (
  provider     text not null,              -- 'zoho_billing', 'zoho_forms', ...
  kind         text not null,              -- 'customer', 'subscription', ...
  external_id  text not null,
  org_id       uuid not null references app.organizations(id) on delete cascade,
  internal_id  uuid not null,
  created_at   timestamptz not null default now(),
  primary key (provider, kind, external_id)
);

-- ---------------------------------------------------------------------------
-- Plans (data, never hard-coded)
-- ---------------------------------------------------------------------------
create table app.plans (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,          -- 'starter', 'growth', 'authority'
  name        text not null,
  active      boolean not null default true
);

create table app.plan_versions (
  id                   uuid primary key default gen_random_uuid(),
  plan_id              uuid not null references app.plans(id),
  zoho_plan_code       text not null,
  price_cents          integer not null check (price_cents >= 0),
  articles_per_cycle   integer not null check (articles_per_cycle > 0),
  min_words            integer not null default 800,
  max_words            integer not null default 1200,
  revision_rounds      integer not null default 1,
  revision_window_days integer not null default 14,
  rollover_cycles      integer not null default 1,   -- unused credits live one extra cycle
  effective_from       timestamptz not null default now(),
  unique (zoho_plan_code, effective_from)
);

-- ---------------------------------------------------------------------------
-- Subscriptions (mirror of Zoho Billing, which stays the source of truth)
-- ---------------------------------------------------------------------------
create table app.subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references app.organizations(id) on delete cascade,
  plan_version_id        uuid not null references app.plan_versions(id),
  status                 text not null check (status in
                           ('pending_payment', 'active', 'past_due', 'suspended',
                            'cancel_scheduled', 'cancelled')),
  current_period_start   timestamptz,
  current_period_end     timestamptz,
  grace_until            timestamptz,
  zoho_subscription_id   text not null unique,
  zoho_customer_id       text,
  last_event_at          timestamptz,   -- ignore events older than this (out-of-order safety)
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index subscriptions_org_idx on app.subscriptions (org_id);

-- Raw, verified billing webhooks. Stored once, processed by the worker.
create table app.billing_events (
  id                 uuid primary key default gen_random_uuid(),
  provider           text not null default 'zoho_billing',
  provider_event_id  text not null,
  event_type         text not null,
  payload            jsonb not null,
  received_at        timestamptz not null default now(),
  processed_at       timestamptz,
  attempts           integer not null default 0,
  last_error         text,
  unique (provider, provider_event_id)
);
create index billing_events_unprocessed_idx
  on app.billing_events (received_at) where processed_at is null;

-- ---------------------------------------------------------------------------
-- Entitlements
-- ---------------------------------------------------------------------------
create table app.entitlement_cycles (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references app.organizations(id) on delete cascade,
  subscription_id  uuid not null references app.subscriptions(id),
  period_start     timestamptz not null,
  period_end       timestamptz not null,
  credits_granted  integer not null check (credits_granted >= 0),
  status           text not null default 'open' check (status in ('open', 'frozen', 'closed')),
  created_at       timestamptz not null default now(),
  unique (subscription_id, period_start),
  check (period_end > period_start)
);
create index entitlement_cycles_org_idx on app.entitlement_cycles (org_id);

create table app.production_jobs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references app.organizations(id) on delete cascade,
  cycle_id      uuid not null references app.entitlement_cycles(id),
  slot          integer not null check (slot > 0),
  state         text not null default 'queued' check (state in
                  ('queued', 'drafting', 'quality_review', 'needs_revision', 'admin_review',
                   'ready_for_customer', 'delivered', 'customer_revision_requested',
                   'customer_approved', 'failed', 'cancelled')),
  step          text not null default 'brief',
  attempts      integer not null default 0,
  run_after     timestamptz not null default now(),
  locked_until  timestamptz,
  locked_by     text,
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (cycle_id, slot)               -- acceptance tests 2 and 11
);
create index production_jobs_runnable_idx
  on app.production_jobs (run_after)
  where state not in ('delivered', 'customer_approved', 'failed', 'cancelled', 'admin_review',
                      'ready_for_customer');

-- One row per credit movement. Available credits for a cycle = sum(delta).
create table app.entitlement_ledger (
  id            bigint generated always as identity primary key,
  org_id        uuid not null references app.organizations(id) on delete cascade,
  cycle_id      uuid not null references app.entitlement_cycles(id),
  job_id        uuid references app.production_jobs(id),
  kind          text not null check (kind in
                  ('grant', 'rollover_in', 'rollover_out', 'reserve', 'release',
                   'consume', 'expire', 'adjust')),
  delta         integer not null,
  reason        text,
  actor         text not null default 'system',
  created_at    timestamptz not null default now(),
  check (
    (kind in ('grant', 'rollover_in', 'release') and delta > 0) or
    (kind in ('rollover_out', 'reserve', 'expire') and delta < 0) or
    (kind = 'consume' and delta = 0) or
    (kind = 'adjust' and delta <> 0 and reason is not null)
  ),
  check ((kind in ('reserve', 'release', 'consume')) = (job_id is not null))
);
create unique index ledger_one_grant_per_cycle on app.entitlement_ledger (cycle_id) where kind = 'grant';
create unique index ledger_one_rollover_in_per_cycle on app.entitlement_ledger (cycle_id) where kind = 'rollover_in';
create unique index ledger_one_rollover_out_per_cycle on app.entitlement_ledger (cycle_id) where kind = 'rollover_out';
create unique index ledger_one_expire_per_cycle on app.entitlement_ledger (cycle_id) where kind = 'expire';
create unique index ledger_one_reserve_per_job on app.entitlement_ledger (job_id) where kind = 'reserve';
-- A reservation ends exactly once: consumed or released, never both.
create unique index ledger_one_settlement_per_job on app.entitlement_ledger (job_id) where kind in ('consume', 'release');
create index ledger_cycle_idx on app.entitlement_ledger (cycle_id);

create view app.cycle_balances as
  select c.id as cycle_id, c.org_id, c.subscription_id, c.period_start, c.period_end, c.status,
         coalesce(sum(l.delta), 0)::int as available
  from app.entitlement_cycles c
  left join app.entitlement_ledger l on l.cycle_id = c.id
  group by c.id;

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
create table app.audit_events (
  id          bigint generated always as identity primary key,
  org_id      uuid references app.organizations(id) on delete set null,
  actor       text not null,            -- 'system', 'admin:<user id>', 'customer:<user id>'
  action      text not null,
  target      text,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index audit_events_org_idx on app.audit_events (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Ledger functions. All credit movement goes through these.
-- ---------------------------------------------------------------------------

-- Open (or fetch) the cycle for a paid period and grant its credits once.
-- Safe to call any number of times for the same period.
create or replace function app.grant_cycle(
  p_subscription_id uuid, p_period_start timestamptz, p_period_end timestamptz)
returns uuid language plpgsql as $$
declare
  v_sub     app.subscriptions;
  v_credits integer;
  v_cycle   uuid;
begin
  select * into strict v_sub from app.subscriptions where id = p_subscription_id;
  select articles_per_cycle into strict v_credits
    from app.plan_versions where id = v_sub.plan_version_id;

  insert into app.entitlement_cycles (org_id, subscription_id, period_start, period_end, credits_granted)
  values (v_sub.org_id, v_sub.id, p_period_start, p_period_end, v_credits)
  on conflict (subscription_id, period_start) do nothing;

  select id into strict v_cycle from app.entitlement_cycles
   where subscription_id = p_subscription_id and period_start = p_period_start;

  insert into app.entitlement_ledger (org_id, cycle_id, kind, delta)
  select v_sub.org_id, v_cycle, 'grant', credits_granted
    from app.entitlement_cycles where id = v_cycle
  on conflict do nothing;

  return v_cycle;
end $$;

-- Create the missing job slots for a cycle, reserving one credit per job,
-- up to the credits available. Idempotent: re-running creates nothing new.
-- Returns the number of jobs created.
create or replace function app.ensure_jobs_for_cycle(p_cycle_id uuid)
returns integer language plpgsql as $$
declare
  v_cycle     app.entitlement_cycles;
  v_sub_ok    boolean;
  v_available integer;
  v_next_slot integer;
  v_job       uuid;
  v_created   integer := 0;
begin
  -- Serialize everything touching this cycle.
  select * into strict v_cycle from app.entitlement_cycles where id = p_cycle_id for update;
  if v_cycle.status <> 'open' then
    return 0;
  end if;

  select status in ('active', 'cancel_scheduled') into v_sub_ok
    from app.subscriptions where id = v_cycle.subscription_id;
  if not coalesce(v_sub_ok, false) then
    return 0;   -- acceptance test 8: unpaid or cancelled means no new work
  end if;

  select coalesce(sum(delta), 0) into v_available
    from app.entitlement_ledger where cycle_id = p_cycle_id;
  select coalesce(max(slot), 0) + 1 into v_next_slot
    from app.production_jobs where cycle_id = p_cycle_id;

  while v_available > 0 loop
    insert into app.production_jobs (org_id, cycle_id, slot)
    values (v_cycle.org_id, p_cycle_id, v_next_slot)
    returning id into v_job;

    insert into app.entitlement_ledger (org_id, cycle_id, job_id, kind, delta)
    values (v_cycle.org_id, p_cycle_id, v_job, 'reserve', -1);

    v_available := v_available - 1;
    v_next_slot := v_next_slot + 1;
    v_created := v_created + 1;
  end loop;

  return v_created;
end $$;

-- Final consumption: called when admin approves the article.
create or replace function app.consume_credit(p_job_id uuid, p_actor text default 'system')
returns void language plpgsql as $$
declare v_job app.production_jobs;
begin
  select * into strict v_job from app.production_jobs where id = p_job_id for update;
  if not exists (select 1 from app.entitlement_ledger where job_id = p_job_id and kind = 'reserve') then
    raise exception 'job % has no reservation', p_job_id;
  end if;
  insert into app.entitlement_ledger (org_id, cycle_id, job_id, kind, delta, actor)
  values (v_job.org_id, v_job.cycle_id, p_job_id, 'consume', 0, p_actor);
end $$;

-- Return a reserved credit: job failed for good or was cancelled.
-- Calling it twice, or after consumption, raises (unique index) instead of
-- silently minting a credit.
create or replace function app.release_credit(p_job_id uuid, p_reason text, p_actor text default 'system')
returns void language plpgsql as $$
declare v_job app.production_jobs;
begin
  select * into strict v_job from app.production_jobs where id = p_job_id for update;
  insert into app.entitlement_ledger (org_id, cycle_id, job_id, kind, delta, reason, actor)
  values (v_job.org_id, v_job.cycle_id, p_job_id, 'release', 1, p_reason, p_actor);
end $$;

-- Admin correction, always with a reason and an audit row.
create or replace function app.adjust_credits(
  p_cycle_id uuid, p_delta integer, p_reason text, p_actor text)
returns void language plpgsql as $$
declare v_org uuid;
begin
  select org_id into strict v_org from app.entitlement_cycles where id = p_cycle_id for update;
  insert into app.entitlement_ledger (org_id, cycle_id, kind, delta, reason, actor)
  values (v_org, p_cycle_id, 'adjust', p_delta, p_reason, p_actor);
  insert into app.audit_events (org_id, actor, action, target, details)
  values (v_org, p_actor, 'credits.adjust', p_cycle_id::text,
          jsonb_build_object('delta', p_delta, 'reason', p_reason));
end $$;

-- Close an old cycle when the next one opens: move unused, unreserved
-- credits forward (rollover policy), or expire them.
create or replace function app.close_cycle(p_old_cycle uuid, p_new_cycle uuid, p_rollover boolean)
returns integer language plpgsql as $$
declare
  v_old       app.entitlement_cycles;
  v_cap       integer;
  v_available integer;
  v_moved     integer := 0;
begin
  select * into strict v_old from app.entitlement_cycles where id = p_old_cycle for update;
  if v_old.status = 'closed' then
    return 0;
  end if;
  perform 1 from app.entitlement_cycles where id = p_new_cycle for update;

  select coalesce(sum(delta), 0) into v_available from app.entitlement_ledger where cycle_id = p_old_cycle;
  -- Rolled-over credits are spent first and never roll a second time, so only
  -- what is left of this cycle's own grant can move forward. That also caps
  -- rollover at one cycle's allowance.
  select greatest(0, v_available - greatest(0,
           coalesce(sum(delta) filter (where kind = 'rollover_in'), 0)
           - (coalesce(sum(delta) filter (where kind in ('grant', 'rollover_in', 'adjust')), 0) - v_available)))
    into v_cap
    from app.entitlement_ledger where cycle_id = p_old_cycle;
  v_moved := least(v_available, v_cap);

  if p_rollover and v_moved > 0 then
    insert into app.entitlement_ledger (org_id, cycle_id, kind, delta, reason)
    values (v_old.org_id, p_old_cycle, 'rollover_out', -v_moved, 'rollover to next cycle'),
           (v_old.org_id, p_new_cycle, 'rollover_in', v_moved, 'rollover from previous cycle');
    v_available := v_available - v_moved;
  end if;
  if v_available > 0 then
    insert into app.entitlement_ledger (org_id, cycle_id, kind, delta, reason)
    values (v_old.org_id, p_old_cycle, 'expire', -v_available, 'cycle closed');
  end if;

  update app.entitlement_cycles set status = 'closed' where id = p_old_cycle;
  return case when p_rollover then v_moved else 0 end;
end $$;

-- Worker: claim runnable jobs. SKIP LOCKED means overlapping cron ticks
-- never grab the same job.
create or replace function app.claim_jobs(p_worker text, p_limit integer, p_lease_seconds integer default 300)
returns setof app.production_jobs language plpgsql as $$
begin
  return query
  update app.production_jobs j
     set locked_by = p_worker,
         locked_until = now() + make_interval(secs => p_lease_seconds),
         attempts = j.attempts + 1,
         updated_at = now()
   where j.id in (
     select id from app.production_jobs
      where state in ('queued', 'drafting', 'quality_review', 'needs_revision',
                      'customer_revision_requested')
        and run_after <= now()
        and (locked_until is null or locked_until < now())
      order by run_after
      limit p_limit
      for update skip locked)
  returning j.*;
end $$;

-- ---------------------------------------------------------------------------
-- Row-level security for tenant-scoped access
-- ---------------------------------------------------------------------------
alter table app.organizations      enable row level security;
alter table app.memberships        enable row level security;
alter table app.subscriptions      enable row level security;
alter table app.entitlement_cycles enable row level security;
alter table app.entitlement_ledger enable row level security;
alter table app.production_jobs    enable row level security;
alter table app.audit_events       enable row level security;
-- Server-only tables: RLS on, no tenant policy, no tenant grants.
alter table app.billing_events     enable row level security;
alter table app.external_ids       enable row level security;
alter table app.platform_admins    enable row level security;

create policy tenant_isolation on app.organizations      to app_tenant using (id = app.current_org_id());
create policy tenant_isolation on app.memberships        to app_tenant using (org_id = app.current_org_id());
create policy tenant_isolation on app.subscriptions      to app_tenant using (org_id = app.current_org_id());
create policy tenant_isolation on app.entitlement_cycles to app_tenant using (org_id = app.current_org_id());
create policy tenant_isolation on app.entitlement_ledger to app_tenant using (org_id = app.current_org_id());
create policy tenant_isolation on app.production_jobs    to app_tenant using (org_id = app.current_org_id());
create policy tenant_isolation on app.audit_events       to app_tenant using (org_id = app.current_org_id());

-- Tenants read their own records; all writes go through server code.
grant select on app.organizations, app.memberships, app.subscriptions, app.entitlement_cycles,
                app.entitlement_ledger, app.production_jobs, app.audit_events, app.plans,
                app.plan_versions
  to app_tenant;
-- Credit and job functions are server-only.
revoke execute on all functions in schema app from public;
grant execute on function app.current_org_id() to app_tenant;

alter view app.cycle_balances set (security_invoker = true);
grant select on app.cycle_balances to app_tenant;

-- ---------------------------------------------------------------------------
-- Seed: the three proposed plans (prices configurable, not final)
-- ---------------------------------------------------------------------------
insert into app.plans (code, name) values
  ('starter', 'Starter'), ('growth', 'Growth'), ('authority', 'Authority');

insert into app.plan_versions (plan_id, zoho_plan_code, price_cents, articles_per_cycle)
select id, code, price, articles from app.plans
join (values ('starter', 4900, 2), ('growth', 9900, 4), ('authority', 19900, 8))
  as v(c, price, articles) on v.c = plans.code;
