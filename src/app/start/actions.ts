"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { resolveLink } from "@/lib/links";
import { OnboardingClosed, saveProgress, submitOnboarding } from "@/lib/onboarding/store";
import { removeUpload, saveUpload } from "@/lib/uploads/storage";
import { setUpOwnerLogin } from "@/lib/customer/auth";
import { requestInfo, setSessionCookie } from "@/lib/customer/session";

export type ActionResult = { ok: true } | { ok: false; error: string; step?: number; closed?: boolean };

const EXPIRED = "This link has expired. Reply to your welcome email and we'll send a fresh one.";

async function orgFor(token: string): Promise<string | null> {
  const link = await resolveLink(await getDb(), token, "onboarding");
  return link?.org_id ?? null;
}

export async function saveAction(token: string, answers: unknown, step: number, consent: boolean): Promise<ActionResult> {
  const orgId = await orgFor(token);
  if (!orgId) return { ok: false, error: EXPIRED };
  try {
    await saveProgress(await getDb(), orgId, answers, step, consent);
    return { ok: true };
  } catch (e) {
    if (e instanceof OnboardingClosed) return { ok: false, error: "You've already sent this in. Thanks!", closed: true };
    console.error("onboarding save failed", e);
    return { ok: false, error: "We couldn't save just now. Please try again in a moment." };
  }
}

export async function submitAction(token: string, answers: unknown, consent: boolean): Promise<ActionResult> {
  const orgId = await orgFor(token);
  if (!orgId) return { ok: false, error: EXPIRED };
  try {
    const r = await submitOnboarding(await getDb(), orgId, answers, consent);
    if (r.ok) return { ok: true };
    if ("closed" in r) return { ok: false, error: "You've already sent this in. Thanks!", closed: true };
    return { ok: false, error: "A few answers are still missing.", step: r.step };
  } catch (e) {
    console.error("onboarding submit failed", e);
    return { ok: false, error: "We couldn't send that just now. Your answers are saved, so please try again in a moment." };
  }
}

export type UploadResult = { ok: true; file: { id: string; filename: string; size_bytes: number; status: string } } | { ok: false; error: string };

export async function uploadAction(token: string, form: FormData): Promise<UploadResult> {
  const orgId = await orgFor(token);
  if (!orgId) return { ok: false, error: EXPIRED };
  const file = form.get("file");
  if (!(file instanceof File)) return { ok: false, error: "Choose a file first." };
  const db = await getDb();
  const done = await db.query(`select 1 from app.onboarding_responses where org_id = $1 and submitted_at is not null`, [orgId]);
  if (done.rows.length) return { ok: false, error: "You've already sent this in." };
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const r = await saveUpload(db, orgId, file.name, bytes);
    if (!r.ok) return { ok: false, error: r.reason };
    return { ok: true, file: { id: r.id, filename: file.name, size_bytes: bytes.length, status: "stored" } };
  } catch (e) {
    console.error("upload failed", e);
    return { ok: false, error: "That upload didn't go through. Please try again." };
  }
}

export async function removeFileAction(token: string, docId: string): Promise<ActionResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(docId))) return { ok: false, error: "Couldn't find that file." };
  const orgId = await orgFor(token);
  if (!orgId) return { ok: false, error: EXPIRED };
  const db = await getDb();
  const done = await db.query(`select 1 from app.onboarding_responses where org_id = $1 and submitted_at is not null`, [orgId]);
  if (done.rows.length) return { ok: false, error: "You've already sent this in." };
  await removeUpload(db, orgId, String(docId));
  return { ok: true };
}

/** First-time login setup, shown before the questionnaire on the welcome link. */
export async function setupLoginAction(token: string, form: FormData): Promise<void> {
  const back = `/start/${encodeURIComponent(token)}`;
  const db = await getDb();
  const link = await resolveLink(db, token, "onboarding");
  if (!link) redirect(back);
  const password = String(form.get("password") ?? "");
  if (password !== String(form.get("confirm") ?? "")) redirect(`${back}?setup=mismatch`);
  const { userAgent } = await requestInfo();
  const r = await setUpOwnerLogin(db, link.org_id, password, userAgent);
  if (!r.ok) {
    redirect(r.reason === "bad_password" ? `${back}?setup=weak&msg=${encodeURIComponent(r.message ?? "")}` : back);
  }
  await setSessionCookie(r.token, r.expiresAt);
  redirect(`${back}?setup=done`);
}
