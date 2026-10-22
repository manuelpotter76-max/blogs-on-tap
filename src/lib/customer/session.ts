import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "../db/client";
import { ipHash, sessionFor, type CustomerSession } from "./auth";

export const CUSTOMER_COOKIE = "bot_session";

/** Lax (not strict) so a link from an email or Google's return trip still arrives signed in. */
export async function setSessionCookie(token: string, expiresAt: Date) {
  (await cookies()).set(CUSTOMER_COOKIE, token, {
    httpOnly: true, secure: true, sameSite: "lax", path: "/", expires: expiresAt,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(CUSTOMER_COOKIE);
}

export async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(CUSTOMER_COOKIE)?.value;
}

/** The signed-in customer, or null. Never redirects. */
export async function currentCustomer(): Promise<CustomerSession | null> {
  return sessionFor(await getDb(), await sessionToken());
}

/** Use at the top of every dashboard page and action. */
export async function requireCustomer(next = "/dashboard"): Promise<CustomerSession> {
  const s = await currentCustomer();
  if (!s) redirect(`/login?next=${encodeURIComponent(next)}`);
  return s;
}

export async function requestInfo(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  return { ip: ipHash(h.get("x-forwarded-for") ?? h.get("x-real-ip")), userAgent: h.get("user-agent") };
}
