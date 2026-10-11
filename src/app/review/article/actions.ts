"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { resolveLink } from "@/lib/links";
import { customerApprove, customerRequestRevision } from "@/lib/articles/review";

export async function articleDecisionAction(token: string, form: FormData): Promise<void> {
  const db = await getDb();
  const base = `/review/article/${encodeURIComponent(token)}`;
  const link = await resolveLink(db, token, "article_review");
  if (!link?.subject_id) redirect(base);
  const r = form.get("decision") === "approve"
    ? await customerApprove(db, link.org_id, link.subject_id)
    : await customerRequestRevision(db, link.org_id, link.subject_id, String(form.get("note") ?? ""));
  redirect(`${base}?result=${r}&d=${form.get("decision") === "approve" ? "approve" : "revise"}`);
}
