"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { login, logout } from "@/lib/admin/auth";
import { adjustCredits, updateCustomerDetails } from "@/lib/admin/queries";
import { runAdminOnboardingAction, type AdminOnboardingAction } from "@/lib/admin/onboarding";
import { adminEdit, adminRequestRevision, approveAndSend, giveUp, retryFailed } from "@/lib/articles/review";
import { ADMIN_COOKIE, requireAdmin } from "@/lib/admin/session";
import { sendDirect } from "@/lib/email/send";
import { sendAccountSetup } from "@/lib/customer/auth";

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

export async function customerDetailsAction(formData: FormData): Promise<void> {
  const adminId = await requireAdmin();
  const orgId = String(formData.get("orgId") ?? "");
  if (!UUID.test(orgId)) redirect("/admin");
  const result = await updateCustomerDetails(await getDb(), adminId, orgId, {
    businessName: String(formData.get("businessName") ?? ""),
    contactName: String(formData.get("contactName") ?? ""),
    email: String(formData.get("email") ?? ""),
  });
  redirect(`/admin/customers/${orgId}?details=${result}#details`);
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

export async function articleAction(formData: FormData): Promise<void> {
  const adminId = await requireAdmin();
  const jobId = String(formData.get("jobId") ?? "");
  const action = String(formData.get("action") ?? "");
  if (!UUID.test(jobId)) redirect("/admin/articles");
  const db = await getDb();
  let result: string;
  switch (action) {
    case "approve":
      result = await approveAndSend(db, adminId, jobId);
      break;
    case "edit":
      result = await adminEdit(db, adminId, jobId, {
        seo_title: String(formData.get("seo_title") ?? ""),
        meta_description: String(formData.get("meta_description") ?? ""),
        slug: String(formData.get("slug") ?? ""),
        excerpt: String(formData.get("excerpt") ?? ""),
        markdown: String(formData.get("markdown") ?? ""),
        cta: String(formData.get("cta") ?? ""),
      });
      break;
    case "revise":
      result = await adminRequestRevision(db, adminId, jobId, String(formData.get("note") ?? ""));
      break;
    case "give_up":
      result = await giveUp(db, adminId, jobId, formData.get("retire") === "on");
      break;
    case "retry":
      result = await retryFailed(db, adminId, jobId);
      break;
    default:
      result = "invalid";
  }
  redirect(`/admin/articles/${jobId}?done=${action}&result=${result}`);
}

export async function testEmailAction(): Promise<void> {
  await requireAdmin();
  const to = process.env.ADMIN_EMAIL?.trim();
  if (!to) redirect("/admin?email=" + encodeURIComponent("Set ADMIN_EMAIL first."));
  let msg: string;
  try {
    const r = await sendDirect(to!, "Blogs on Tap test email",
      "This is a test from your Blogs on Tap admin. If you're reading it, customer emails work.",
      "<p>This is a test from your Blogs on Tap admin.</p><p>If you're reading it, customer emails work.</p>");
    msg = r.provider === "log"
      ? "Email is in log mode, so nothing was really sent. Set EMAIL_PROVIDER to zeptomail."
      : `Sent to ${to}. Check your inbox (and spam) in a minute.`;
  } catch (e) {
    msg = `Failed: ${(e as Error).message.slice(0, 300)}`;
  }
  redirect("/admin?email=" + encodeURIComponent(msg));
}

export async function sendLoginSetupAction(formData: FormData): Promise<void> {
  const adminId = await requireAdmin();
  const orgId = String(formData.get("orgId") ?? "");
  if (!UUID.test(orgId)) redirect("/admin");
  const result = await sendAccountSetup(await getDb(), adminId, orgId);
  redirect(`/admin/customers/${orgId}?login=${result}#login`);
}
