-- One row per successful worker tick. Lets us confirm from the database that
-- the cron timer, its secret and the database connection all work.
create table app.worker_heartbeats (
  id                        bigint generated always as identity primary key,
  ran_at                    timestamptz not null default now(),
  billing_events_processed  integer not null default 0
);
create index worker_heartbeats_ran_at_idx on app.worker_heartbeats (ran_at desc);
alter table app.worker_heartbeats enable row level security;  -- server-only, no tenant access
