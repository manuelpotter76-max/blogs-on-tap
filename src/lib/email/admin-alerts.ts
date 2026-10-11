import type { Queryable } from "@/lib/db/client";
import { sendEmail } from "./send";

/**
 * Tells the owner when something needs a person: an article waiting for
 * review, a failed job or background step, a customer who skipped every topic
 * batch. Sent to ADMIN_EMAIL, at most once per dedupe key. Alerts never break
 * the work that triggered them: any failure is logged and ignored.
 */
export type AlertKind = "article_review" | "article_failed" | "task_failed" | "strategy_needs_admin";

const SUBJECT: Record<AlertKind, string> = {
  article_review: "Article ready for your review",
  article_failed: "An article failed",
  task_failed: "A background step failed",
  strategy_needs_admin: "A customer skipped every topic batch",
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export async function alertAdmin(
  db: Queryable, a: { orgId: string; kind: AlertKind; dedupeKey: string; detail: string; path: string },
): Promise<void> {
  const to = process.env.ADMIN_EMAIL?.trim();
  if (!to) return;
  try {
    const org = (await db.query<{ name: string }>(`select name from app.organizations where id = $1`, [a.orgId])).rows[0];
    const base = (process.env.APP_BASE_URL ?? "").trim().replace(/\/$/, "");
    const url = `${base}${a.path}`;
    const subject = `${SUBJECT[a.kind]}: ${org?.name ?? "a customer"}`;
    await sendEmail(db, {
      orgId: a.orgId, kind: `admin_${a.kind}`, dedupeKey: `admin:${a.dedupeKey}`, to, subject,
      text: `${subject}\n\n${a.detail}\n\n${url}`,
      html: `<p><strong>${esc(subject)}</strong></p><p>${esc(a.detail)}</p><p><a href="${esc(url)}">Open in admin</a></p>`,
    });
  } catch (err) {
    console.error("admin alert failed", a.kind, (err as Error).message);
  }
}
