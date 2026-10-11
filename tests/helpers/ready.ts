import type { Queryable } from "../../src/lib/db/client";

/** Put an org through onboarding by hand: confirmed profile, approved strategy, n approved topics. */
export async function makeReady(db: Queryable, orgId: string, topics = 20): Promise<void> {
  await db.query(
    `insert into app.profile_versions (org_id, version, data, created_by) values ($1, 1, '{}', 'customer')`, [orgId]);
  await db.query(
    `insert into app.business_profiles (org_id, status, current_version, confirmed_at) values ($1, 'confirmed', 1, now())`, [orgId]);
  const { rows } = await db.query<{ id: string }>(
    `insert into app.strategy_versions (org_id, version, profile_version, data, created_by)
     values ($1, 1, 1, '{}', 'ai') returning id`, [orgId]);
  for (let i = 1; i <= topics; i++) {
    await db.query(
      `insert into app.topics (org_id, strategy_version_id, topic_key, title, primary_keyword, search_intent, audience,
                               business_objective, angle, cta, priority, status)
       values ($1, $2, $3, $4, $5, 'informational', 'homeowners', 'leads', 'useful', 'Call us', $6, 'approved')`,
      [orgId, rows[0].id, `topic ${i}`, `Topic ${i}`, `keyword ${i}`, i]);
  }
  await db.query(
    `insert into app.content_strategies (org_id, status, current_version, review_rounds) values ($1, 'approved', 1, 1)`, [orgId]);
}
