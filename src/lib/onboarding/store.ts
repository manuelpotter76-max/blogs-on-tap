import type { Db, Queryable } from "@/lib/db/client";
import { enqueue } from "@/lib/tasks/queue";
import { cleanAnswers, firstIncompleteStep, TOTAL_STEPS, type Answers } from "./questions";

export type OnboardingState = {
  answers: Answers;
  currentStep: number;
  websiteConsent: boolean;
  submittedAt: string | null;
  files: { id: string; filename: string; size_bytes: number; status: string }[];
};

export async function loadOnboarding(db: Queryable, orgId: string): Promise<OnboardingState> {
  const row = (await db.query<{
    answers: Answers; current_step: number; website_consent: boolean; submitted_at: string | null;
  }>(`select answers, current_step, website_consent, submitted_at from app.onboarding_responses where org_id = $1`,
    [orgId])).rows[0];

  let answers = row?.answers ?? {};
  if (!row) {
    // Prefill what billing already told us, so the customer doesn't retype it.
    const org = (await db.query<{ name: string; website: string | null; full_name: string | null }>(
      `select o.name, o.website, u.full_name from app.organizations o
         left join app.memberships m on m.org_id = o.id and m.role = 'owner'
         left join app.users u on u.id = m.user_id
        where o.id = $1 limit 1`, [orgId])).rows[0];
    answers = cleanAnswers({
      business_name: org?.name && org.name !== "New customer" ? org.name : "",
      website: org?.website ?? "",
      contact_name: org?.full_name ?? "",
    });
  }
  const files = (await db.query<OnboardingState["files"][number]>(
    `select id, filename, size_bytes, status from app.source_documents
      where org_id = $1 and kind = 'upload' and status <> 'removed' order by created_at`, [orgId])).rows;

  return {
    answers,
    currentStep: row?.current_step ?? 0,
    websiteConsent: row?.website_consent ?? false,
    submittedAt: row?.submitted_at ?? null,
    files,
  };
}

export class OnboardingClosed extends Error {}

/** Autosave. Partial answers are fine here; validation happens per step in the form and fully on submit. */
export async function saveProgress(
  db: Queryable, orgId: string, rawAnswers: unknown, step: number, websiteConsent: boolean,
): Promise<void> {
  const answers = cleanAnswers(rawAnswers);
  const s = Math.max(0, Math.min(TOTAL_STEPS - 1, Math.trunc(Number(step) || 0)));
  const consent = Boolean(websiteConsent) && Boolean(answers.website || answers.blog_url);
  const { rows } = await db.query<{ org_id: string }>(
    `insert into app.onboarding_responses (org_id, answers, current_step, website_consent, website_consent_at)
     values ($1, $2, $3, $4, case when $4 then now() end)
     on conflict (org_id) do update set
       answers = excluded.answers,
       current_step = excluded.current_step,
       website_consent = excluded.website_consent,
       website_consent_at = case
         when excluded.website_consent and not app.onboarding_responses.website_consent then now()
         when not excluded.website_consent then null
         else app.onboarding_responses.website_consent_at end,
       updated_at = now()
     where app.onboarding_responses.submitted_at is null
     returning org_id`,
    [orgId, JSON.stringify(answers), s, consent]);
  if (!rows.length) throw new OnboardingClosed("Onboarding was already submitted");
}

export type SubmitResult = { ok: true } | { ok: false; step: number } | { ok: false; closed: true };

/**
 * Lock in the answers and start research. Runs once: a second submit (double
 * click, two tabs) finds submitted_at set and changes nothing.
 */
export async function submitOnboarding(db: Db, orgId: string, rawAnswers: unknown, websiteConsent: boolean): Promise<SubmitResult> {
  const answers = cleanAnswers(rawAnswers);
  const incomplete = firstIncompleteStep(answers);
  if (incomplete >= 0) return { ok: false, step: incomplete };

  return db.transaction(async (tx) => {
    try {
      await saveProgress(tx, orgId, answers, TOTAL_STEPS - 1, websiteConsent);
    } catch (e) {
      if (e instanceof OnboardingClosed) return { ok: false, closed: true } as const;
      throw e;
    }
    const { rows } = await tx.query<{ website_consent: boolean }>(
      `update app.onboarding_responses set submitted_at = now(), updated_at = now()
        where org_id = $1 and submitted_at is null returning website_consent`, [orgId]);
    if (!rows.length) return { ok: false, closed: true } as const;

    await tx.query(
      `update app.organizations set name = $2, website = nullif($3, '') where id = $1`,
      [orgId, String(answers.business_name), String(answers.website ?? "")]);
    await tx.query(
      `insert into app.business_profiles (org_id, status) values ($1, 'researching')
       on conflict (org_id) do update set status = 'researching', updated_at = now()`, [orgId]);
    await tx.query(
      `insert into app.audit_events (org_id, actor, action, target, details)
       values ($1, 'customer', 'onboarding.submitted', $1, $2)`,
      [orgId, JSON.stringify({ website_consent: rows[0].website_consent })]);

    if (rows[0].website_consent) await enqueue(tx, orgId, "website_fetch", `website_fetch:${orgId}:1`);
    else await enqueue(tx, orgId, "business_research", `business_research:${orgId}:1`);
    return { ok: true } as const;
  });
}
