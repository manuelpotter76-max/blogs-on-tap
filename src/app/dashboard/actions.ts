"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import {
  checkPassword, endAllSessions, endSession, inviteTeammate, notifyPasswordChanged, passwordProblem, removeTeammate,
  setPassword, switchOrg,
} from "@/lib/customer/auth";
import { clearSessionCookie, requireCustomer, sessionToken } from "@/lib/customer/session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function signOutAction(): Promise<void> {
  await endSession(await getDb(), await sessionToken());
  await clearSessionCookie();
  redirect("/login?out=1");
}

export async function changePasswordAction(form: FormData): Promise<void> {
  const s = await requireCustomer("/dashboard/account");
  const db = await getDb();
  const next = String(form.get("password") ?? "");
  if (next !== String(form.get("confirm") ?? "")) redirect("/dashboard/account?pw=mismatch#password");
  if (s.hasPassword && !(await checkPassword(db, s.userId, String(form.get("current") ?? "")))) {
    redirect("/dashboard/account?pw=wrong#password");
  }
  const problem = passwordProblem(next, s.email);
  if (problem) redirect(`/dashboard/account?pw=weak&msg=${encodeURIComponent(problem)}#password`);
  await setPassword(db, s.userId, next, await sessionToken());
  await notifyPasswordChanged(db, s.userId, s.orgId);
  redirect("/dashboard/account?pw=ok#password");
}

export async function signOutEverywhereAction(): Promise<void> {
  const s = await requireCustomer("/dashboard/account");
  await endAllSessions(await getDb(), s.userId, await sessionToken());
  redirect("/dashboard/account?devices=ok#devices");
}

export async function inviteAction(form: FormData): Promise<void> {
  const s = await requireCustomer("/dashboard/account");
  const r = await inviteTeammate(await getDb(), s, String(form.get("email") ?? ""), String(form.get("name") ?? ""));
  redirect(`/dashboard/account?team=${r}#team`);
}

export async function removeTeammateAction(form: FormData): Promise<void> {
  const s = await requireCustomer("/dashboard/account");
  const userId = String(form.get("userId") ?? "");
  if (!UUID.test(userId)) redirect("/dashboard/account#team");
  const r = await removeTeammate(await getDb(), s, userId);
  redirect(`/dashboard/account?team=${r === "ok" ? "removed" : r}#team`);
}

export async function switchBusinessAction(form: FormData): Promise<void> {
  const s = await requireCustomer();
  const orgId = String(form.get("orgId") ?? "");
  const token = await sessionToken();
  if (UUID.test(orgId) && token) await switchOrg(await getDb(), token, s.userId, orgId);
  redirect("/dashboard");
}
