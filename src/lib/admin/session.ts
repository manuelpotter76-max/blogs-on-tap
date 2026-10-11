import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "../db/client";
import { sessionUser } from "./auth";

export const ADMIN_COOKIE = "bot_admin";

/** Use at the top of every admin page and action. Sends visitors without a live session to the login page. */
export async function requireAdmin(): Promise<string> {
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  const userId = await sessionUser(await getDb(), token);
  if (!userId) redirect("/admin/login");
  return userId;
}
