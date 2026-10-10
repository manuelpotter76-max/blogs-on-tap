import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Zoho Billing webhook signature check.
 *
 * Zoho's documented rule (kb/webhooks/securing-webhooks):
 *   1. Take every query-string key/value pair, plus every form-urlencoded body
 *      pair when the body is form-encoded.
 *   2. Sort the pairs alphabetically by key and concatenate them as
 *      key + value, with no separators and no spaces added.
 *   3. If the body is raw JSON, append the raw JSON text to the end.
 *   4. HMAC-SHA256 that string with the secret token set on the webhook.
 *   5. Compare with the X-Zoho-Webhook-Signature header.
 *
 * Zoho's page does not say whether the header is hex or base64, so both are
 * accepted. Confirm with a real test webhook in M2 and remove the unused one.
 */
export function buildSignatureString(input: {
  query: URLSearchParams;
  contentType: string | null;
  rawBody: string;
}): string {
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of input.query) pairs.push([k, v]);

  const isForm = (input.contentType ?? "").toLowerCase().includes("application/x-www-form-urlencoded");
  if (isForm) {
    // URLSearchParams decodes, which matches Zoho's "decode before hashing" warning.
    for (const [k, v] of new URLSearchParams(input.rawBody)) pairs.push([k, v]);
  }

  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const prefix = pairs.map(([k, v]) => k + v).join("");
  return isForm ? prefix : prefix + input.rawBody;
}

export function verifyZohoSignature(input: {
  secret: string;
  signatureHeader: string | null;
  query: URLSearchParams;
  contentType: string | null;
  rawBody: string;
}): boolean {
  if (!input.secret || !input.signatureHeader) return false;
  const message = buildSignatureString(input);
  const mac = createHmac("sha256", input.secret).update(message, "utf8").digest();
  const given = input.signatureHeader.trim();

  return safeEqual(Buffer.from(mac.toString("hex")), Buffer.from(given.toLowerCase())) ||
    safeEqual(Buffer.from(mac.toString("base64")), Buffer.from(given));
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
