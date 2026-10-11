-- Record webhooks the app turned away (bad signature, unreadable body), so
-- integration problems can be diagnosed from the database. Server-only.
-- Bodies are capped at 8 KB by the app; purge this table periodically.
create table app.webhook_rejections (
  id            bigint generated always as identity primary key,
  received_at   timestamptz not null default now(),
  reason        text not null,
  content_type  text,
  signature     text,
  query         text,
  body          text
);
alter table app.webhook_rejections enable row level security;
