-- Indexes for foreign keys that queries actually filter or join on
-- (Supabase advisor 0001). The rest of the advisor's list are audit links
-- (ai_run_id and similar) that are never queried in that direction.
create index if not exists production_jobs_org_idx        on app.production_jobs (org_id, state);
create index if not exists entitlement_ledger_org_idx     on app.entitlement_ledger (org_id);
create index if not exists external_ids_org_idx           on app.external_ids (org_id);
create index if not exists memberships_user_idx           on app.memberships (user_id);
create index if not exists topics_strategy_version_idx    on app.topics (strategy_version_id);
create index if not exists article_versions_org_idx       on app.article_versions (org_id);
create index if not exists articles_topic_idx             on app.articles (topic_id);
create index if not exists revision_requests_org_idx      on app.revision_requests (org_id);
create index if not exists quality_reports_org_idx        on app.quality_reports (org_id);
create index if not exists subscriptions_plan_version_idx on app.subscriptions (plan_version_id);
