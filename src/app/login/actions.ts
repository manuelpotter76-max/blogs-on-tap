"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import {
  completeLinkSignIn, completeLinkWithPassword, requestEmailLink, safeNext, signInWithPassword,
} from "@/lib/customer/auth";
import { requestInfo, setSessionCookie } from "@/lib/customer/session";

export async function passwordSignInAction(form: FormData): Promise<void> {
  const next = safeNext(form.get("next"));
  const { ip, userAgent } = await requestInfo();
  const r = await signInWithPassword(await getDb(), String(form.get("email") ?? ""), String(form.get("password") ?? ""), ip, userAgent);
  if (!r.ok) redirect(`/login?error=${r.reason}&next=${encodeURIComponent(next)}`);
  await setSessionCookie(r.token, r.expiresAt);
  redirect(next);
}

export async function emailLinkAction(form: FormData): Promise<void> {
  await requestEmailLink(await getDb(), String(form.get("email") ?? ""), "sign_in");
  redirect("/login?sent=link");
}

export async function forgotPasswordAction(form: FormData): Promise<void> {
  await requestEmailLink(await getDb(), String(form.get("email") ?? ""), "password_reset");
  redirect("/login/forgot?sent=1");
}

/** Setup, reset and invite links that set a password. */
export async function linkPasswordAction(token: string, form: FormData): Promise<void> {
  const back = `/login/l/${encodeURIComponent(token)}`;
  const password = String(form.get("password") ?? "");
  if (password !== String(form.get("confirm") ?? "")) redirect(`${back}?error=mismatch`);
  const { userAgent } = await requestInfo();
  const r = await completeLinkWithPassword(await getDb(), token, password, userAgent);
  if (!r.ok) {
    redirect(r.reason === "bad_password" ? `${back}?error=weak&msg=${encodeURIComponent(r.message ?? "")}` : `${back}?error=used`);
  }
  await setSessionCookie(r.token, r.expiresAt);
  redirect("/dashboard?welcome=1");
}

/** Sign-in links, and invites for someone who already has a login. */
export async function linkSignInAction(token: string): Promise<void> {
  const { userAgent } = await requestInfo();
  const s = await completeLinkSignIn(await getDb(), token, userAgent);
  if (!s) redirect(`/login/l/${encodeURIComponent(token)}?error=used`);
  await setSessionCookie(s.token, s.expiresAt);
  redirect("/dashboard");
}
