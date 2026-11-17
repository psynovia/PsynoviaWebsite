import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

// Additive admin-only upload API. Existing patient-report and secure-delivery endpoints are unchanged.
const BUCKET = "secure-delivery-encrypted";
const MAX_ENCRYPTED_BYTES = 33_554_432;
const VALID_DAYS = 30;
const SCRYPT_OPTIONS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache", "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow, noarchive"
  }});
}
function env(name) { return String(Netlify.env.get(name) || "").trim(); }
function sha(input) { return createHash("sha256").update(String(input), "utf8").digest("hex"); }
function validToken(input) { return typeof input === "string" && /^[A-Za-z0-9_-]{40,128}$/.test(input); }
function safeEq(a, b) {
  try { const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex"); return x.length === y.length && timingSafeEqual(x, y); }
  catch { return false; }
}
function validCase(input) { return /^[A-Z0-9_-]{6,80}$/.test(String(input || "")); }
function validDob(input) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input || ""))) return false;
  const d = new Date(input + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === input;
}
function authOk(req, adminSecret) {
  const supplied = req.headers.get("x-admin-token") || "";
  return adminSecret.length >= 40 && validToken(supplied) && safeEq(sha(supplied), sha(adminSecret));
}
function headers(key) { return { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" }; }
async function db(base, key, path, opts = {}) {
  const r = await fetch(base + "/rest/v1/" + path, {
    method: opts.method || "GET", headers: { ...headers(key), ...(opts.prefer ? { Prefer: opts.prefer } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const data = await r.json().catch(() => null);
  return { r, data };
}
function encodePath(input) { return String(input).split("/").map(encodeURIComponent).join("/"); }
async function signedUpload(base, key, objectPath) {
  const r = await fetch(base + "/storage/v1/object/upload/sign/" + BUCKET + "/" + encodePath(objectPath), {
    method: "POST", headers: { ...headers(key), "x-upsert": "false" }, body: "{}"
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data) throw new Error("signed_upload_failed");
  const relative = data.url || data.signedURL || data.signedUrl;
  if (typeof relative !== "string" || !relative.includes("/object/upload/sign/")) throw new Error("signed_upload_invalid");
  return relative.startsWith("http") ? relative :
    base + "/storage/v1" + (relative.startsWith("/") ? "" : "/") + relative;
}
async function objectSize(base, key, path) {
  const r = await fetch(base + "/storage/v1/object/info/authenticated/" + BUCKET + "/" + encodePath(path), {
    headers: { apikey: key, Authorization: "Bearer " + key }
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data) return null;
  const size = Number(data?.metadata?.size ?? data?.size ?? data?.metadata?.contentLength);
  return Number.isFinite(size) ? size : null;
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  const base = env("SUPABASE_URL"), key = env("SUPABASE_SERVICE_ROLE_KEY"), admin = env("PATIENT_REPORT_ADMIN_TOKEN");
  if (!base || !key || !admin) return json(500, { ok: false, error: "server_configuration_missing" });
  if (!authOk(req, admin)) return json(403, { ok: false, error: "admin_denied" });
  let body;
  try { body = await req.json(); } catch { return json(400, { ok: false, error: "invalid_json" }); }
  const action = String(body?.action || "");

  if (action === "admin_prepare") {
    const caseId = String(body?.case_id || "").trim().toUpperCase();
    const protection = String(body?.protection_mode || "");
    const recipient = String(body?.recipient_type || "");
    const dob = String(body?.birth_date || "").trim();
    if (!validCase(caseId) || !["token_only", "dob"].includes(protection) ||
        !["patient", "clinic"].includes(recipient) || (protection === "dob" && !validDob(dob))) {
      return json(400, { ok: false, error: "invalid_input" });
    }
    const found = await db(base, key, "cases?case_id=eq." + encodeURIComponent(caseId) + "&select=case_id&limit=1");
    if (!found.r.ok || !Array.isArray(found.data)) return json(502, { ok: false, error: "case_lookup_failed" });
    if (found.data.length !== 1) return json(404, { ok: false, error: "case_not_found" });
    const groupId = randomUUID(), deliveryId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const path = caseId + "/" + deliveryId + ".enc";
    const expiresAt = new Date(Date.now() + VALID_DAYS * 86_400_000).toISOString();
    const salt = protection === "dob" ? randomBytes(16) : null;
    const hash = salt ? scryptSync(dob, salt, 32, SCRYPT_OPTIONS).toString("hex") : null;
    const item = {
      delivery_id: deliveryId, group_id: groupId, case_id: caseId,
      document_type: "other", document_label: "Sichere Dokumente",
      recipient_type: recipient, protection_mode: protection,
      object_path: path, status: "pending", access_token_hash: sha(token),
      dob_hmac: hash, dob_salt: salt ? salt.toString("base64url") : null,
      expires_at: expiresAt
    };
    const insert = await db(base, key, "secure_deliveries", { method: "POST", prefer: "return=minimal", body: item });
    if (!insert.r.ok) return json(502, { ok: false, error: "prepare_failed" });
    try {
      const url = await signedUpload(base, key, path);
      return json(200, { ok: true, delivery_id: deliveryId, access_token: token,
        signed_upload_url: url, expires_at: expiresAt, max_encrypted_bytes: MAX_ENCRYPTED_BYTES });
    } catch {
      await db(base, key, "secure_deliveries?delivery_id=eq." + encodeURIComponent(deliveryId) + "&status=eq.pending", {
        method: "PATCH", prefer: "return=minimal", body: { status: "revoked", revoked_at: new Date().toISOString() }
      }).catch(() => undefined);
      return json(502, { ok: false, error: "signed_upload_failed" });
    }
  }

  if (action === "admin_finalize") {
    const id = String(body?.delivery_id || "");
    const size = Number(body?.encrypted_bytes);
    const digest = String(body?.payload_sha256 || "").toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
        !Number.isSafeInteger(size) || size < 1 || size > MAX_ENCRYPTED_BYTES || !/^[0-9a-f]{64}$/.test(digest)) {
      return json(400, { ok: false, error: "invalid_finalize" });
    }
    const found = await db(base, key, "secure_deliveries?delivery_id=eq." + encodeURIComponent(id) + "&select=delivery_id,object_path,status&limit=1");
    if (!found.r.ok || !Array.isArray(found.data)) return json(502, { ok: false, error: "lookup_failed" });
    if (found.data.length !== 1 || found.data[0].status !== "pending") return json(409, { ok: false, error: "delivery_not_pending" });
    const actualSize = await objectSize(base, key, found.data[0].object_path);
    if (actualSize === null || actualSize !== size) return json(409, { ok: false, error: "encrypted_size_mismatch" });
    const patch = await db(base, key, "secure_deliveries?delivery_id=eq." + encodeURIComponent(id) + "&status=eq.pending&select=delivery_id", {
      method: "PATCH", prefer: "return=representation",
      body: { status: "ready", encrypted_bytes: size, payload_sha256: digest, ready_at: new Date().toISOString() }
    });
    if (!patch.r.ok || !Array.isArray(patch.data) || patch.data.length !== 1) return json(502, { ok: false, error: "finalize_failed" });
    return json(200, { ok: true, delivery_id: id });
  }

  return json(400, { ok: false, error: "unknown_action" });
};