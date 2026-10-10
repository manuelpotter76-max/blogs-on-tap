import { after } from "next/server";
import { getDb } from "@/lib/db/client";
import { verifyZohoSignature } from "@/lib/zoho/verify-signature";
import { storeBillingEvent, processPendingBillingEvents, type ZohoEvent } from "@/lib/zoho/billing-events";

export const runtime = "nodejs";

/**
 * Zoho Billing webhook receiver.
 * 1. Verify the HMAC signature against the raw body (reject anything unsigned).
 * 2. Store the event once, keyed by Zoho's event_id.
 * 3. Answer 200 fast; process right after the response, and the worker tick
 *    retries anything that failed.
 */
export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const url = new URL(request.url);

  const ok = verifyZohoSignature({
    secret: process.env.ZOHO_BILLING_WEBHOOK_SECRET ?? "",
    signatureHeader: request.headers.get("x-zoho-webhook-signature"),
    query: url.searchParams,
    contentType: request.headers.get("content-type"),
    rawBody,
  });
  if (!ok) return new Response("invalid signature", { status: 401 });

  let event: ZohoEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("expected JSON body", { status: 400 });
  }

  const db = await getDb();
  const result = await storeBillingEvent(db, event);

  // Process now so the customer's onboarding is not waiting on the next cron tick.
  after(() => processPendingBillingEvents(db).catch((e) => console.error("billing processing failed", e)));

  return Response.json({ received: true, result });
}
