-- Customer logins (dashboard, milestone 1)
--
-- * Email is the username. A user can belong to more than one business
--   (memberships), and a business can have an owner plus invited teammates.
-- * Passwords: scrypt hash only. Google sign-in (milestone 2) links by google_sub.
-- * Sessions: only the SHA-256 of the cookie token is stored.
-- * Login links (account setup, sign-in, password reset, teammate invite):
--   random tokens, only the hash stored, single use, short expiry. They are
--   used up when the person submits the page, not when the page loads, so
--   mail scanners that pre-open links don't burn them.
-- Everything here is server-only. The dashboard reads business data under
-- app_tenant and looks up review links server-side, so access_links stays
-- server-only too.

alter table app.users
  add column password_hash       text,
  add column google_sub          text,
  add column login_ready_at      timestamptz,   -- first time a password (or Google) was set
  add column password_changed_at timestamptz,
  add column last_sign_in_at     timestamptz;
create unique index users_google_sub_key on app.users (google_sub) where google_sub is not null;

alter table app.memberships
  add column status     text not null default 'active' check (status in ('active', 'invited')),
  add column invited_by uuid references app.users(id) on delete set null,
  add column invited_at timestamptz;

create table app.customer_sessions (
  token_hash    text primary key,
  user_id       uuid not null references app.users(id) on delete cascade,
  org_id        uuid not null references app.organizations(id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  last_seen_at  timestamptz not null default now(),
  user_agent    text,
  revoked_at    timestamptz
);
create index customer_sessions_user_idx on app.customer_sessions (user_id) where revoked_at is null;

create table app.customer_login_attempts (
  id         bigint generated always as identity primary key,
  email      text not null,
  ip_hash    text,
  at         timestamptz not null default now(),
  succeeded  boolean not null
);
create index customer_login_attempts_email_idx on app.customer_login_attempts (email, at desc);
create index customer_login_attempts_ip_idx on app.customer_login_attempts (ip_hash, at desc);

create table app.login_links (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text not null unique,
  user_id     uuid not null references app.users(id) on delete cascade,
  org_id      uuid not null references app.organizations(id) on delete cascade,
  purpose     text not null check (purpose in ('account_setup', 'sign_in', 'password_reset', 'invite')),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index login_links_open_idx on app.login_links (user_id, purpose) where used_at is null;

alter table app.customer_sessions       enable row level security;   -- server-only
alter table app.customer_login_attempts enable row level security;   -- server-only
alter table app.login_links             enable row level security;   -- server-only
