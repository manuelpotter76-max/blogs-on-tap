import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { buildSignatureString, verifyZohoSignature } from "../src/lib/zoho/verify-signature";

// Both expected strings are Zoho's own worked examples from
// https://www.zoho.com/billing/kb/webhooks/securing-webhooks.html
test("string for query params + raw JSON matches Zoho's example", () => {
  const s = buildSignatureString({
    query: new URLSearchParams({ subscription_id: "90343", name: "basic" }),
    contentType: "application/json",
    rawBody: '{"created_date":"2019-03-06","event_id":"5675"}',
  });
  assert.equal(s, 'namebasicsubscription_id90343{"created_date":"2019-03-06","event_id":"5675"}');
});

test("string for query params + form body matches Zoho's example (decoded, spaces kept)", () => {
  const s = buildSignatureString({
    query: new URLSearchParams({ customer_name: "Bowman", status: "active" }),
    contentType: "application/x-www-form-urlencoded",
    rawBody: "addon_description=Monthly%20addon&quantity=1",
  });
  assert.equal(s, "addon_descriptionMonthly addoncustomer_nameBowmanquantity1statusactive");
});

const secret = "testsecret123456";
const body = '{"event_id":"1","event_type":"subscription_created"}';
const sig = (enc: "hex" | "base64") => createHmac("sha256", secret).update(body).digest(enc);
const base = { secret, query: new URLSearchParams(), contentType: "application/json", rawBody: body };

test("accepts a valid hex or base64 signature", () => {
  assert.equal(verifyZohoSignature({ ...base, signatureHeader: sig("hex") }), true);
  assert.equal(verifyZohoSignature({ ...base, signatureHeader: sig("base64") }), true);
});

test("rejects tampered body, wrong secret, and missing header", () => {
  assert.equal(verifyZohoSignature({ ...base, rawBody: body.replace("1", "2"), signatureHeader: sig("hex") }), false);
  assert.equal(verifyZohoSignature({ ...base, secret: "othersecret12345", signatureHeader: sig("hex") }), false);
  assert.equal(verifyZohoSignature({ ...base, signatureHeader: null }), false);
  assert.equal(verifyZohoSignature({ ...base, secret: "", signatureHeader: sig("hex") }), false);
});
