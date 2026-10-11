"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { resolveLink } from "@/lib/links";
import { confirmProfile } from "@/lib/review/profile";
import { FACT_LISTS, type FactList } from "@/lib/agents/business-profile";

const lines = (v: FormDataEntryValue | null) => String(v ?? "").split("\n").map((s) => s.trim()).filter(Boolean);

export async function confirmProfileAction(token: string, form: FormData): Promise<void> {
  const db = await getDb();
  const link = await resolveLink(db, token, "profile_review");
  if (!link) redirect(`/review/profile/${encodeURIComponent(token)}`);

  const keep: Partial<Record<FactList, boolean[]>> = {};
  for (const list of FACT_LISTS) {
    const count = Math.min(50, Number(form.get(`${list}__count`) ?? 0) || 0);
    const arr: boolean[] = [];
    for (let i = 0; i < count; i++) {
      const v = form.get(`${list}__${i}`);
      if (v === "keep") arr[i] = true;
      else if (v === "remove") arr[i] = false;
    }
    keep[list] = arr;
  }

  const result = await confirmProfile(db, link.org_id, String(form.get("version_id") ?? ""), {
    keep,
    summary: String(form.get("summary") ?? ""),
    ctaText: String(form.get("cta_text") ?? ""),
    ctaDestination: String(form.get("cta_destination") ?? ""),
    prohibitedClaims: lines(form.get("prohibited_claims")),
    topicsToAvoid: lines(form.get("topics_to_avoid")),
    extraNotes: String(form.get("notes") ?? ""),
  });

  const base = `/review/profile/${encodeURIComponent(token)}`;
  if (result.ok) redirect(`${base}?done=1`);
  redirect(`${base}?error=${result.reason}${result.detail ? `&detail=${encodeURIComponent(result.detail)}` : ""}`);
}
