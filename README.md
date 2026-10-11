# Blogs on Tap

Subscription blog production service. Zoho handles the website, billing and
onboarding forms; this app owns the data, the credit ledger and the AI pipeline.
Hosted on Vercel, database on Supabase Postgres.

## What's built (Phase 2, part 1)

| Piece | File |
| --- | --- |
| Core schema, tenant isolation, credit ledger, job queue | `supabase/migrations/20261010000001_core.sql` |
| Zoho Billing signature check | `src/lib/zoho/verify-signature.ts` |
| Billing events into subscriptions and credits | `src/lib/zoho/billing-events.ts` |
| Webhook endpoint | `src/app/api/webhooks/zoho-billing/route.ts` |
| Worker tick (Vercel Cron, every minute) | `src/app/api/worker/tick/route.ts`, `vercel.json` |
| Tests (run against a real Postgres) | `tests/` |

## How credits work

Credits are never a number we overwrite. Every movement is a row in
`app.entitlement_ledger`: `grant`, `reserve`, `consume`, `release`,
`rollover_in` / `rollover_out`, `expire`, `adjust`. Unique indexes make a
double grant, double reserve, or double consume impossible, so a replayed
webhook or a crashed job cannot create or lose a credit.

- Paid term arrives: `grant_cycle()` opens the cycle and grants the plan's credits once.
- Scheduler: `ensure_jobs_for_cycle()` creates one job per available credit, reserving each.
- Admin approves an article: `consume_credit()`.
- Job fails for good or is cancelled: `release_credit()`.
- Renewal: `close_cycle()` rolls unused credits forward one cycle (capped at one allowance), expires the rest.

## Tenant isolation

Customer-facing code runs inside `asTenant(db, orgId, fn)`, which switches to
the `app_tenant` role and sets `app.org_id`. Row-level security then limits
every query to that customer. Tenants can read their own rows and nothing
else: no writes, no billing events, no credit functions.

## Environment variables

See `.env.example`.

## Running tests

Tests need a local PostgreSQL 16+ and its socket folder in `PGHOST_TEST`:

```
npm install
PGHOST_TEST=/var/run/postgresql npm test
```

## Before going live, confirm with a real Zoho test webhook

1. Whether `X-Zoho-Webhook-Signature` is hex or base64 (both accepted now; drop the other).
2. The exact payload shape and event names (see the note at the top of `billing-events.ts`).
3. That each Zoho plan code matches `app.plan_versions.zoho_plan_code` (`starter`, `growth`, `premium`).
