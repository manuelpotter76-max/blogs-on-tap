"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { resolveLink } from "@/lib/links";
import { decideTopics } from "@/lib/review/topics";

export async function decideTopicsAction(token: string, form: FormData): Promise<void> {
  const db = await getDb();
  const link = await resolveLink(db, token, "topic_review");
  const base = `/review/topics/${encodeURIComponent(token)}`;
  if (!link?.subject_id) redirect(base);

  const ids = form.getAll("topic").map(String).slice(0, 50);
  const decisions = ids.map((id) => ({
    id,
    approve: form.get(`approve__${id}`) === "on",
    note: String(form.get(`note__${id}`) ?? ""),
  }));
  const r = await decideTopics(db, link.org_id, link.subject_id, decisions);
  if (r.ok) redirect(`${base}?done=${r.approved}${r.moreComing ? "&more=1" : ""}`);
  redirect(`${base}?error=${r.reason}`);
}
