# Blogs on Tap

Subscription blog production service. Zoho handles the website and billing;
this app owns onboarding, the data, the credit ledger and the AI pipeline.
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

## What's built (Phase 3: onboarding and strategy)

The customer journey from payment to approved topics, with no manual steps:

1. A paid Zoho subscription queues one onboarding email (once per customer, ever).
2. The customer fills a multi-step questionnaire at `/start/<link>`: saves as they go, resumes on any device, optional file uploads, explicit consent before we read their website.
3. On submit, the worker reads up to 8 public pages of their site (SSRF-safe, robots.txt honored), then **Agent A (Business Research)** drafts a profile. Anything not from the customer's own answers is flagged "please confirm".
4. The customer checks the profile at `/review/profile/<link>`: keep or remove each inferred item, edit the summary, call to action and guardrails.
5. **Agent B (Content Strategy)** proposes topics, with repeats of published posts, earlier topics and each other filtered out in code.
6. The customer picks topics at `/review/topics/<link>`. Skipped topics and notes feed the next batch. Any approval opens production; a short pool queues more ideas.
7. `ensure_jobs_for_cycle()` now creates no jobs until the profile is confirmed and topics are approved, and ties each job to one approved topic.

| Piece | File |
| --- | --- |
| Schema: links, onboarding, profiles, strategy, topics, AI runs, task queue, emails | `supabase/migrations/20261012000008_onboarding_strategy.sql` |
| Signed, expiring customer links | `src/lib/links.ts` |
| Durable task queue and handlers | `src/lib/tasks/` |
| Email (ZeptoMail or log-only), sent at most once per key | `src/lib/email/` |
| Questionnaire definition, autosave, submit | `src/lib/onboarding/` |
| Website reader (SSRF, robots, size and time caps) | `src/lib/web/fetch-site.ts` |
| OpenAI structured calls, cost logging, schemas | `src/lib/ai/` |
| Agents A and B, prompts, topic dedupe | `src/lib/agents/` |
| Customer review logic | `src/lib/review/` |
| Customer pages | `src/app/start/`, `src/app/review/` |
| Admin: onboarding status, links, tasks, emails, AI cost, recovery buttons | `src/app/admin/customers/[id]/onboarding-section.tsx` |

### Setup for Phase 3

1. Set the new environment variables in Vercel (see `.env.example`): `APP_BASE_URL`, `LINK_SECRET`, `EMAIL_PROVIDER`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `OPENAI_API_KEY`, `OPENAI_MODEL_DEFAULT` (or per-stage models).
2. Start with `EMAIL_PROVIDER=log`: emails print to the function log and every live customer link shows on the admin customer page. Switch to `zeptomail` once the sending domain is verified in ZeptoMail.
3. Add a price row per model so AI cost is tracked:
   `insert into app.ai_model_prices (model, input_per_mtok, cached_input_per_mtok, output_per_mtok) values ('<model id>', <in>, <cached in>, <out>);`
4. Prompts are versioned in code (`PROMPT_VERSION` in each agent). Change the text, bump the version; every AI run records which one it used.

### Security notes

- Customer links are `<id>.<HMAC>`; nothing secret is stored, links expire (21 to 30 days) and re-sending revokes the old one. Pages send `Referrer-Policy: no-referrer`.
- Website text and uploads are wrapped as untrusted data in prompts and never treated as instructions. The model's own "confirmed" labels are overridden in code.
- Uploads: PDF, .txt, .md only, checked by content, 4 MB each, 5 per customer, private bucket, paths prefixed by customer id.
- Tenants can read their own onboarding rows; links, emails, tasks and AI runs are server-only.

## What's built (Phase 4: writing, quality review, delivery)

One production job = one article = one credit. The worker moves each job through:

1. **Brief** (Agent: brief): reader, questions to answer, outline, facts allowed, links allowed.
2. **Draft** (Agent C: writing): Markdown only, structured fields (title, meta, slug, excerpt, tags, CTA, link list, claim sources).
3. **Quality review** (Agent D): code checks (length, title/meta, prohibited claims, avoided terms, placeholders, raw HTML, CTA, figures to verify) plus an AI editor scoring accuracy, usefulness, voice and more. Pass/fail is decided in code.
4. Fails are revised automatically up to 2 times, then escalate to you with a flag.
5. **Your review** at `/admin/articles`: approve and send (credit consumed here, once), edit it yourself, send it back with a note, retry a failed job, or give up (credit returned, topic kept or retired).
6. **Delivery**: email with a link to `/review/article/<link>`, where the customer reads, copies (rich text or HTML), downloads (HTML or Markdown with front matter), approves, or asks for changes within the plan's revision allowance. Changes go back through QA and your review.

Safety: AI text only becomes HTML through our own renderer (escapes everything, rebuilds headings, lists, emphasis, links). Links to anything but the customer's own site and CTA are stripped in code. AI failures back off and retry; after 4 tries the job is marked failed with its credit still reserved, never silently spent or released.

Models: `OPENAI_MODEL_BRIEF`, `OPENAI_MODEL_WRITING`, `OPENAI_MODEL_QA` (each falls back to `OPENAI_MODEL_DEFAULT`).

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

## Zoho Billing webhook: confirmed with a live test (Oct 10, 2026)

- Signature: HMAC-SHA256 of the raw JSON body with the webhook secret, hex encoded, in `X-Zoho-Webhook-Signature`.
- Payload: Zoho's previous format (`event_id`, `event_type`, `data.subscription`). The webhook is set to it via "restore it".
  The newer format (no event details) is also accepted, as a state snapshot.
- Plan codes in Zoho: `starter`, `growth`, `premium`.
- Rejected webhooks are written to `app.webhook_rejections` for diagnosis; purge it after debugging.
