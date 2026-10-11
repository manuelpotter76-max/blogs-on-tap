"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { login, logout } from "@/lib/admin/auth";
import { adjustCredits } from "@/lib/admin/queries";
import { runAdminOnboardingAction, type AdminOnboardingAction } from "@/lib/admin/onboarding";
import { ADMIN_COOKIE, requireAdmin } from "@/lib/admin/session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loginAction(formData: FormData): Promise<void> {
  const db = await getDb();
  const result = await login(db, String(formData.get("password") ?? ""), String(formData.get("code") ?? ""));
  if (!result.ok) {
    redirect(`/admin/login?error=${result.reason}`);
  } else {
    (await cookies()).set(ADMIN_COOKIE, result.token, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      expires: result.expiresAt,
    });
    redirect("/admin");
  }
}

export async function logoutAction(): Promise<void> {
  const jar = await cookies();
  await logout(await getDb(), jar.get(ADMIN_COOKIE)?.value);
  jar.delete(ADMIN_COOKIE);
  redirect("/admin/login");
}

export async function adjustCreditsAction(formData: FormData): Promise<void> {
  const adminId = await requireAdmin();
  const orgId = String(formData.get("orgId") ?? "");
  const cycleId = String(formData.get("cycleId") ?? "");
  const delta = Number.parseInt(String(formData.get("delta") ?? ""), 10);
  const reason = String(formData.get("reason") ?? "");
  if (!UUID.test(orgId) || !UUID.test(cycleId)) redirect("/admin");

  const result = await adjustCredits(await getDb(), adminId, orgId, cycleId, delta, reason);
  redirect(`/admin/customers/${orgId}?adjust=${result}`);
}

export async function onboardingAction(formData: FormData): Promise<void> {
  const adminId = await requireAdmin();
  const orgId = String(formData.get("orgId") ?? "");
  const action = String(formData.get("action") ?? "") as AdminOnboardingAction;
  const taskId = String(formData.get("taskId") ?? "") || undefined;
  if (!UUID.test(orgId) || (taskId && !UUID.test(taskId))) redirect("/admin");
  if (!["resend_invite", "rerun_research", "more_topics", "retry_task"].includes(action)) redirect(`/admin/customers/${orgId}`);
  const result = await runAdminOnboardingAction(await getDb(), adminId, orgId, action, taskId);
  redirect(`/admin/customers/${orgId}?onb=${result}#onboarding`);
}
