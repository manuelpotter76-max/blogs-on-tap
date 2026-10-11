import { after } from "next/server";
import { getDb } from "@/lib/db/client";
import { verifyZohoSignature } from "@/lib/zoho/verify-signature";
import {
  storeBillingEvent,
  processPendingBillingEvents,
  normalizeZohoPayload,
  type ZohoEvent,
} from "@/lib/zoho/billing-events";

export const runtime = "nodejs";

/**
 * Zoho Billing webhook receiver.
 * 1. Verify the HMAC signature against the raw body (reject anything unsigned).
 * 2. Store the event once, keyed by Zoho's event_id.
 * 3. Answer 200 fast; process right after the response, and the worker tick
 *    retries anything that failed.
 * Rejected requests are written to app.webhook_rejections for diagnosis.
 */
export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const url = new URL(request.url);
  const contentType = request.headers.get("content-type");
  const signature = request.headers.get("x-zoho-webhook-signature");

  const ok = verifyZohoSignature({
    secret: process.env.ZOHO_BILLING_WEBHOOK_SECRET ?? "",
    signatureHeader: signature,
    query: url.searchParams,
    contentType,
    rawBody,
  });
  if (!ok) {
    await recordRejection(signature ? "bad_signature" : "missing_signature", contentType, signature, url.search, rawBody);
    return new Response("invalid signature", { status: 401 });
  }

  let event: ZohoEvent;
  try {
    event = await normalizeZohoPayload(JSON.parse(rawBody), rawBody);
  } catch (err) {
    await recordRejection("unreadable_payload: " + (err as Error).message, contentType, signature, url.search, rawBody);
    return new Response("unrecognized payload", { status: 400 });
  }

  const db = await getDb();
  const result = await storeBillingEvent(db, event);

  // Process now so the customer's onboarding is not waiting on the next cron tick.
  after(() => processPendingBillingEvents(db).catch((e) => console.error("billing processing failed", e)));

  return Response.json({ received: true, result });
}

async function recordRejection(
  reason: string, contentType: string | null, signature: string | null, query: string, body: string,
) {
  console.error("zoho webhook rejected:", reason);
  try {
    const db = await getDb();
    await db.query(
      `insert into app.webhook_rejections (reason, content_type, signature, query, body) values ($1, $2, $3, $4, $5)`,
      [reason, contentType, signature, query, body.slice(0, 8192)],
    );
  } catch (e) {
    console.error("could not record webhook rejection", e);
  }
}
