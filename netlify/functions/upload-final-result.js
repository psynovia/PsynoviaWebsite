// netlify/functions/upload-final-result.js

const crypto = require("crypto");

const RESULT_BUCKET = "results";
const MAX_REQUEST_BYTES = 4_500_000;
const MAX_RESULT_CONTENT_BYTES = 4_000_000;
const MIN_GCM_CIPHERTEXT_BYTES = 17;

const ALLOWED_PAYMENT_STATUS = new Set([
  "paid",
  "clinic_paid",
  "clinic_access_granted",
  "clinic_pending_manual_access"
]);

const ALLOWED_CASE_STATUS = new Set([
  "paid",
  "active",
  "clinic_paid",
  "clinic_access_granted",
  "clinic_pending_manual_access",
  "assessment_pending",
  "download_ready",
  "assessment_uploaded",
  "assessment_completed",
  "result_uploaded",
  "completed"
]);

exports.handler = async function handler(event) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow, noarchive"
  };

  function json(statusCode, body, extraHeaders = {}) {
    return {
      statusCode,
      headers: { ...corsHeaders, ...extraHeaders },
      body: JSON.stringify(body)
    };
  }

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" }, { Allow: "POST, OPTIONS" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("upload-final-result: missing Supabase environment variables");
    return json(500, { ok: false, error: "Server configuration missing" });
  }

  const rawBody = String(event.body || "");
  if (Buffer.byteLength(rawBody, "utf8") > MAX_REQUEST_BYTES) {
    return json(413, { ok: false, error: "Request body too large" });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody || "{}");
  } catch (error) {
    return json(400, { ok: false, error: "Request body is not valid JSON" });
  }

  const caseId = String(payload.case_id || "").trim();
  const downloadToken = String(payload.download_token || "").trim();
  const resultContent = payload.result_content;
  const requestedFilename = String(payload.filename || "result.psynovia").trim();

  if (!caseId || caseId.startsWith("__PSYNOVIA_")) {
    return json(400, { ok: false, error: "Missing or invalid case_id" });
  }

  if (!downloadToken || downloadToken.startsWith("__PSYNOVIA_")) {
    return json(400, { ok: false, error: "Missing or invalid download_token" });
  }

  if (typeof resultContent !== "string" || resultContent.length === 0) {
    return json(400, { ok: false, error: "Missing result_content" });
  }

  const resultContentBytes = Buffer.byteLength(resultContent, "utf8");
  if (resultContentBytes > MAX_RESULT_CONTENT_BYTES) {
    return json(413, { ok: false, error: "Result file is too large" });
  }

  let encryptedContainer;
  try {
    encryptedContainer = JSON.parse(resultContent);
  } catch (error) {
    return json(400, { ok: false, error: "Result file is not valid JSON" });
  }

  const containerCheck = validateEncryptedContainer(encryptedContainer);
  if (!containerCheck.ok) {
    return json(400, { ok: false, error: containerCheck.error });
  }

  const safeCaseId = sanitizePathPart(caseId, "case");
  const safeFilename = sanitizeResultFilename(requestedFilename);
  const objectPath = `${safeCaseId}/${safeFilename}`;
  const contentSha256 = crypto.createHash("sha256").update(resultContent, "utf8").digest("hex");

  try {
    const caseResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/cases?case_id=eq.${encodeURIComponent(caseId)}&select=id,case_id,payment_status,status,download_locked,download_expires_at,download_token&limit=1`,
      {
        method: "GET",
        headers: supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY)
      }
    );

    let cases;
    try {
      cases = await caseResponse.json();
    } catch (error) {
      console.error("upload-final-result: invalid case lookup response", error);
      return json(502, { ok: false, error: "Case lookup returned an invalid response" });
    }

    if (!caseResponse.ok) {
      console.error("upload-final-result: case lookup failed", caseResponse.status, cases);
      return json(502, { ok: false, error: "Case lookup failed" });
    }

    if (!Array.isArray(cases) || cases.length === 0) {
      return json(404, { ok: false, error: "Case not found" });
    }

    const row = cases[0];
    const accessCheck = validateCaseAccess(row, downloadToken);
    if (!accessCheck.ok) {
      return json(accessCheck.statusCode, { ok: false, error: accessCheck.error });
    }

    const uploadResponse = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${RESULT_BUCKET}/${encodeURIComponent(objectPath).replace(/%2F/g, "/")}`,
      {
        method: "POST",
        headers: {
          ...supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY),
          "Content-Type": "application/octet-stream",
          "x-upsert": "true"
        },
        body: resultContent
      }
    );

    const uploadText = await uploadResponse.text();
    if (!uploadResponse.ok) {
      console.error("upload-final-result: storage upload failed", uploadResponse.status, uploadText);
      return json(502, { ok: false, error: "Result upload failed" });
    }

    const nowIso = new Date().toISOString();
    const patchBody = {
      assessment_completed: true,
      status: "assessment_uploaded",
      assessment_json: {
        uploaded: true,
        uploaded_at: nowIso,
        bucket: RESULT_BUCKET,
        path: objectPath,
        filename: safeFilename,
        format: "psynovia_encrypted_v1",
        content_sha256: contentSha256,
        content_bytes: resultContentBytes
      }
    };

    let patchResponse;
    try {
      patchResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/cases?id=eq.${encodeURIComponent(row.id)}`,
        {
          method: "PATCH",
          headers: {
            ...supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY),
            "Content-Type": "application/json",
            "Prefer": "return=minimal"
          },
          body: JSON.stringify(patchBody)
        }
      );
    } catch (error) {
      console.error("upload-final-result: case status update network error", error);
      return json(503, {
        ok: false,
        stored: true,
        retryable: true,
        error: "Result stored, but case status update failed"
      });
    }

    if (!patchResponse.ok) {
      let patchText = "";
      try {
        patchText = await patchResponse.text();
      } catch (_) {}

      console.error(
        "upload-final-result: case status update failed",
        patchResponse.status,
        patchText
      );

      return json(503, {
        ok: false,
        stored: true,
        retryable: true,
        error: "Result stored, but case status update failed"
      });
    }

    return json(200, {
      ok: true,
      case_id: caseId,
      bucket: RESULT_BUCKET,
      path: objectPath,
      filename: safeFilename,
      content_sha256: contentSha256,
      content_bytes: resultContentBytes,
      uploaded_at: nowIso,
      status: "assessment_uploaded"
    });
  } catch (error) {
    console.error("upload-final-result failed", error);
    return json(500, { ok: false, error: "Function failed" });
  }
};

function supabaseHeaders(serviceRoleKey) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json"
  };
}

function validateCaseAccess(row, suppliedToken) {
  if (!row || typeof row !== "object") {
    return { ok: false, statusCode: 404, error: "Case not found" };
  }

  if (row.download_locked === true) {
    return { ok: false, statusCode: 403, error: "Case access is locked" };
  }

  if (row.download_expires_at) {
    const expiresAt = new Date(row.download_expires_at).getTime();
    if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
      return { ok: false, statusCode: 403, error: "Case access has expired" };
    }
  }

  const paymentStatus = String(row.payment_status || "").trim();
  const caseStatus = String(row.status || "").trim();

  if (!ALLOWED_PAYMENT_STATUS.has(paymentStatus)) {
    return { ok: false, statusCode: 403, error: "Case is not authorized for upload" };
  }

  if (caseStatus && !ALLOWED_CASE_STATUS.has(caseStatus)) {
    return { ok: false, statusCode: 403, error: "Case status does not allow upload" };
  }

  const expectedToken = row.download_token || null;

  if (!expectedToken) {
    return { ok: false, statusCode: 409, error: "No token stored for this case" };
  }

  if (!safeTokenEqual(String(expectedToken), String(suppliedToken))) {
    return { ok: false, statusCode: 403, error: "Invalid token" };
  }

  return { ok: true };
}

function safeTokenEqual(expected, actual) {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function validateEncryptedContainer(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Invalid .psynovia result format" };
  }

  if (value.v !== 1 || value.alg !== "AES-256-GCM" || value.kdf !== "MASTERKEY") {
    return { ok: false, error: "Invalid .psynovia result format" };
  }

  const iv = decodeStrictBase64(value.iv_b64);
  if (!iv.ok || iv.buffer.length !== 12) {
    return { ok: false, error: "Invalid AES-GCM IV" };
  }

  const ciphertext = decodeStrictBase64(value.ct_b64);
  if (!ciphertext.ok || ciphertext.buffer.length < MIN_GCM_CIPHERTEXT_BYTES) {
    return { ok: false, error: "Invalid AES-GCM ciphertext" };
  }

  return {
    ok: true,
    ivBytes: iv.buffer.length,
    ciphertextBytes: ciphertext.buffer.length
  };
}

function decodeStrictBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) {
    return { ok: false, buffer: Buffer.alloc(0) };
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return { ok: false, buffer: Buffer.alloc(0) };
  }

  try {
    const buffer = Buffer.from(value, "base64");

    if (buffer.length === 0 || buffer.toString("base64") !== value) {
      return { ok: false, buffer: Buffer.alloc(0) };
    }

    return { ok: true, buffer };
  } catch (_) {
    return { ok: false, buffer: Buffer.alloc(0) };
  }
}

function sanitizePathPart(value, fallback) {
  const safe = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160);

  return safe || fallback;
}

function sanitizeResultFilename(value) {
  let safe = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 180);

  if (!safe.toLowerCase().endsWith(".psynovia")) {
    safe = "result.psynovia";
  }

  return safe || "result.psynovia";
}
