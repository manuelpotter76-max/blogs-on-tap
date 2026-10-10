import { getDb } from "@/lib/db/client";
import { processPendingBillingEvents } from "@/lib/zoho/billing-events";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Called every minute by Vercel Cron (see vercel.json).
 * Phase 2: retries billing events that failed or were missed.
 * Phase 4 adds: open job slots for paid cycles, claim jobs, run AI steps.
 */
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const db = await getDb();
  const billing = await processPendingBillingEvents(db);
  return Response.json({ billing_events_processed: billing });
}
