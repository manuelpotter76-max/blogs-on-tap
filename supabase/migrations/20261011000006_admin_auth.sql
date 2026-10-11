-- Admin console authentication: password + TOTP two-factor, database-backed
-- sessions, and failed-attempt tracking for lockout. All server-only.

create table app.admin_credentials (
  user_id            uuid primary key references app.users(id) on delete cascade,
  password_hash      text not null,             -- scrypt$N$r$p$salt$hash (base64)
  totp_secret        text not null,             -- base32
  totp_last_counter  bigint not null default 0, -- blocks reuse of a code
  updated_at         timestamptz not null default now()
);

create table app.admin_sessions (
  token_hash   text primary key,                -- sha256 of the cookie token; the token itself is never stored
  user_id      uuid not null references app.users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz
);
create index admin_sessions_user_idx on app.admin_sessions (user_id);

create table app.admin_login_attempts (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  succeeded   boolean not null
);
create index admin_login_attempts_at_idx on app.admin_login_attempts (at desc);

alter table app.admin_credentials    enable row level security;
alter table app.admin_sessions       enable row level security;
alter table app.admin_login_attempts enable row level security;
