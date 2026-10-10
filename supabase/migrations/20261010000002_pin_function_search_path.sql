-- Pin search_path on every app function (Supabase advisor 0011).
-- All references inside are schema-qualified, and pg_catalog is always searched,
-- so an empty search_path changes no behavior; it only blocks object shadowing.
alter function app.current_org_id() set search_path = '';
alter function app.grant_cycle(uuid, timestamptz, timestamptz) set search_path = '';
alter function app.ensure_jobs_for_cycle(uuid) set search_path = '';
alter function app.consume_credit(uuid, text) set search_path = '';
alter function app.release_credit(uuid, text, text) set search_path = '';
alter function app.adjust_credits(uuid, integer, text, text) set search_path = '';
alter function app.close_cycle(uuid, uuid, boolean) set search_path = '';
alter function app.claim_jobs(text, integer, integer) set search_path = '';

-- billing_events, external_ids and platform_admins have RLS on with no policy
-- on purpose (advisor 0008, INFO): tenants get no access at all; only the
-- server's privileged connection reads them.
