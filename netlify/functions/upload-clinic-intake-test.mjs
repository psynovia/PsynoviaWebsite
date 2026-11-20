import { createHash } from "node:crypto";

const BUCKET = "clinic-intake-encrypted";
const TABLE = "clinic_intake_submissions";
const CASES_TABLE = "cases";
const MAX_BODY_BYTES = 2_000_000;
const REF_RE = /^K-TST[A-HJ-NP-Z2-9]{5}$/;
const CASE_ID_RE = /^CHIEM-[0-9]{4}-TST[A-HJ-NP-Z2-9]{5}$/;
const EXPLANATION_STATUSES = new Set(["completed", "questions_open"]);

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow, noarchive"
    }
  });
}

function nonProductionOnly() {
  const context = String(Netlify.env.get("CONTEXT") || "").trim();
  return context !== "production";
}

function sameOrigin(req) {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(req.url).origin;
  } catch {
    return false;
  }
}

function isStrictBase64(value, minDecodedBytes = 1, maxDecodedBytes = 1_500_000) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    const bin = atob(value);
    return bin.length >= minDecodedBytes && bin.length <= maxDecodedBytes;
  } catch {
    return false;
  }
}

function validateEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid_envelope";
  const e = value;
  const allowedKeys = new Set([
    "v","type","content_encryption","key_encryption","intake_reference",
    "case_id","explanation_status","iv_b64","wrapped_key_b64","ciphertext_b64"
  ]);
  for (const key of Object.keys(e)) if (!allowedKeys.has(key)) return "unexpected_envelope_field";
  if (e.v !== 2) return "unsupported_version";
  if (e.type !== "psynovia_clinic_intake") return "invalid_type";
  if (e.content_encryption !== "AES-256-GCM") return "invalid_content_encryption";
  if (e.key_encryption !== "RSA-OAEP-256") return "invalid_key_encryption";
  if (typeof e.intake_reference !== "string" || !REF_RE.test(e.intake_reference)) return "invalid_test_reference";
  if (typeof e.case_id !== "string" || !CASE_ID_RE.test(e.case_id)) return "invalid_test_case_id";
  if (typeof e.explanation_status !== "string" || !EXPLANATION_STATUSES.has(e.explanation_status)) return "invalid_explanation_status";
  if (!e.case_id.endsWith(`-${e.intake_reference.slice(2)}`)) return "case_reference_mismatch";
  if (!isStrictBase64(e.iv_b64, 12, 12)) return "invalid_iv";
  if (!isStrictBase64(e.wrapped_key_b64, 128, 1024)) return "invalid_wrapped_key";
  if (!isStrictBase64(e.ciphertext_b64, 17, 1_500_000)) return "invalid_ciphertext";
  return null;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

async function createActivationToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = base64Url(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return { token, hash: bytesToHex(digest) };
}

async function deleteStorageObject(supabaseUrl, headers, objectPath) {
  await fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}/${encodeURIComponent(objectPath)}`, {
    method: "DELETE",
    headers
  }).catch(() => undefined);
}

async function deleteCase(supabaseUrl, headers, caseId) {
  await fetch(`${supabaseUrl}/rest/v1/${CASES_TABLE}?case_id=eq.${encodeURIComponent(caseId)}`, {
    method: "DELETE",
    headers
  }).catch(() => undefined);
}

export default async (req) => {
  if (!nonProductionOnly()) return json(404, { ok: false, error: "not_found" });
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  if (!sameOrigin(req)) return json(403, { ok: false, error: "origin_not_allowed" });

  const contentType = (req.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("application/json")) return json(415, { ok: false, error: "content_type_not_allowed" });

  const raw = await req.text();
  const rawBytes = new TextEncoder().encode(raw);
  if (rawBytes.byteLength === 0 || rawBytes.byteLength > MAX_BODY_BYTES) {
    return json(rawBytes.byteLength === 0 ? 400 : 413, {
      ok: false,
      error: rawBytes.byteLength === 0 ? "empty_payload" : "payload_too_large"
    });
  }

  let envelope;
  try { envelope = JSON.parse(raw); } catch { return json(400, { ok: false, error: "invalid_json" }); }

  const validationError = validateEnvelope(envelope);
  if (validationError) return json(400, { ok: false, error: validationError });

  const supabaseUrl = String(Netlify.env.get("SUPABASE_URL") || "").trim();
  const serviceRoleKey = String(Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
  if (!supabaseUrl || !serviceRoleKey) return json(500, { ok: false, error: "server_configuration_missing" });

  const intakeReference = envelope.intake_reference;
  const caseId = envelope.case_id;
  const explanationStatus = envelope.explanation_status;
  const submissionId = crypto.randomUUID();
  const objectPath = `TEST-${intakeReference}.enc`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", rawBytes));
  const payloadSha256 = bytesToHex(digest);
  const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
  const activation = explanationStatus === "completed" ? await createActivationToken() : null;

  const storageResponse = await fetch(
    `${supabaseUrl}/storage/v1/object/${BUCKET}/${encodeURIComponent(objectPath)}`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/octet-stream", "x-upsert": "false" },
      body: raw
    }
  );

  if (!storageResponse.ok) {
    if (storageResponse.status === 400 || storageResponse.status === 409) {
      return json(409, { ok: false, error: "reference_collision" });
    }
    return json(502, { ok: false, error: "encrypted_upload_failed" });
  }

  const caseStatus = explanationStatus === "completed" ? "clinic_ready_for_access" : "clinic_questions_open";
  const caseResponse = await fetch(`${supabaseUrl}/rest/v1/${CASES_TABLE}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", "Prefer": "return=minimal" },
    body: JSON.stringify({
      case_id: caseId,
      first_name: null,
      last_name: null,
      email: null,
      payment_status: "clinic_paid",
      intake_completed: true,
      assessment_completed: false,
      intake_json: null,
      assessment_json: null,
      report_available: false,
      report_file: null,
      status: caseStatus,
      download_token: null,
      download_count: 0,
      first_downloaded_at: null,
      last_downloaded_at: null,
      download_expires_at: null,
      download_locked: true,
      max_downloads: 0,
      stripe_session_id: null
    })
  });

  if (!caseResponse.ok) {
    await deleteStorageObject(supabaseUrl, headers, objectPath);
    if (caseResponse.status === 409) return json(409, { ok: false, error: "reference_collision" });
    return json(502, { ok: false, error: "case_create_failed" });
  }

  const nowIso = new Date().toISOString();
  const metadataResponse = await fetch(`${supabaseUrl}/rest/v1/${TABLE}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", "Prefer": "return=minimal" },
    body: JSON.stringify({
      submission_id: submissionId,
      object_path: objectPath,
      status: "received",
      intake_reference: intakeReference,
      notification_status: "pending",
      payload_sha256: payloadSha256,
      payload_bytes: rawBytes.byteLength,
      created_at: nowIso,
      case_id: caseId,
      explanation_status: explanationStatus,
      access_activation_token_hash: activation?.hash || null,
      access_activation_consumed_at: null
    })
  });

  if (!metadataResponse.ok) {
    await deleteStorageObject(supabaseUrl, headers, objectPath);
    await deleteCase(supabaseUrl, headers, caseId);
    return json(502, { ok: false, error: "metadata_write_failed" });
  }

  try {
    const notifyUrl = new URL("/.netlify/functions/notify-clinic-intake-test", req.url);
    await fetch(notifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intake_reference: intakeReference,
        case_id: caseId,
        explanation_status: explanationStatus
      })
    });
  } catch {
    // Test intake remains stored even if notification fails.
  }

  return json(201, {
    ok: true,
    test_mode: true,
    submission_id: intakeReference,
    technical_submission_id: submissionId,
    intake_reference: intakeReference,
    case_id: caseId,
    explanation_status: explanationStatus,
    access_activation_token: activation?.token || null,
    received_at: nowIso
  });
};
