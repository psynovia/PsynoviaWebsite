import { createHash, randomUUID } from "node:crypto";

const BUCKET = "clinic-documents-encrypted";
const MAX_ENCRYPTED_BYTES = 26_214_400;
const ALLOWED_CASE_STATUSES = new Set([
  "clinic_access_granted",
  "assessment_pending",
  "download_ready",
  "assessment_uploaded",
  "assessment_completed",
  "result_uploaded",
  "completed"
]);

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

function hashToken(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function validToken(value) {
  return typeof value === "string" && value.length >= 43 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

async function requestJson(url, key, options = {}) {
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  const data = await response.json().catch(() => null);
  return { response, data };
}

async function resolveUploadAccess({ supabaseUrl, key, token }) {
  if (!validToken(token)) return { error: "invalid_token", status: 403 };

  const tokenHash = hashToken(token);
  const lookup = await requestJson(
    `${supabaseUrl}/rest/v1/clinic_document_upload_tokens?token_hash=eq.${encodeURIComponent(tokenHash)}&select=case_id,expires_at,revoked_at,upload_count&limit=1`,
    key
  );

  if (!lookup.response.ok || !Array.isArray(lookup.data) || lookup.data.length !== 1) {
    return { error: "upload_link_invalid", status: 403 };
  }

  const row = lookup.data[0];
  if (row.revoked_at) return { error: "upload_link_revoked", status: 403 };

  const expiresAt = new Date(row.expires_at).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return { error: "upload_link_expired", status: 403 };
  }

  const caseLookup = await requestJson(
    `${supabaseUrl}/rest/v1/cases?case_id=eq.${encodeURIComponent(row.case_id)}&select=case_id,status,payment_status&limit=1`,
    key
  );

  if (!caseLookup.response.ok || !Array.isArray(caseLookup.data) || caseLookup.data.length !== 1) {
    return { error: "case_not_found", status: 404 };
  }

  const caseRow = caseLookup.data[0];
  if (caseRow.payment_status !== "clinic_paid" || !ALLOWED_CASE_STATUSES.has(String(caseRow.status || ""))) {
    return { error: "upload_not_available", status: 403 };
  }

  return {
    caseId: row.case_id,
    expiresAt: row.expires_at,
    uploadCount: Number(row.upload_count || 0)
  };
}

async function createSignedUpload({ supabaseUrl, key, objectPath }) {
  const response = await fetch(
    `${supabaseUrl}/storage/v1/object/upload/sign/${BUCKET}/${encodeURIComponent(objectPath)}`,
    {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "x-upsert": "false"
      },
      body: JSON.stringify({})
    }
  );

  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error("signed_upload_failed");

  const relative = data.url || data.signedURL || data.signedUrl;
  if (typeof relative !== "string" || !relative.includes("/object/upload/sign/")) {
    throw new Error("signed_upload_invalid");
  }

  const signedUrl = relative.startsWith("http")
    ? relative
    : `${supabaseUrl}/storage/v1${relative.startsWith("/") ? "" : "/"}${relative}`;

  return signedUrl;
}

async function objectInfo({ supabaseUrl, key, objectPath }) {
  const response = await fetch(
    `${supabaseUrl}/storage/v1/object/info/authenticated/${BUCKET}/${encodeURIComponent(objectPath)}`,
    {
      method: "GET",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`
      }
    }
  );

  const data = await response.json().catch(() => null);
  if (!response.ok || !data) return null;

  const rawSize = data?.metadata?.size ?? data?.size ?? data?.metadata?.contentLength;
  const size = Number(rawSize);
  return Number.isFinite(size) && size > 0 ? { size } : { size: null };
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const supabaseUrl = String(Netlify.env.get("SUPABASE_URL") || "").trim();
  const key = String(Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
  if (!supabaseUrl || !key) return json(500, { ok: false, error: "server_configuration_missing" });

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }

  const action = String(body?.action || "").trim();
  const token = String(body?.token || "").trim();
  const access = await resolveUploadAccess({ supabaseUrl, key, token });
  if (access.error) return json(access.status, { ok: false, error: access.error });

  if (action === "status") {
    return json(200, {
      ok: true,
      case_id: access.caseId,
      expires_at: access.expiresAt,
      upload_count: access.uploadCount,
      max_file_bytes: 20 * 1024 * 1024
    });
  }

  if (action === "prepare") {
    const uploadId = randomUUID();
    const objectPath = `${uploadId}.enc`;

    const insert = await requestJson(`${supabaseUrl}/rest/v1/clinic_document_uploads`, key, {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: {
        id: uploadId,
        case_id: access.caseId,
        object_path: objectPath,
        status: "pending"
      }
    });

    if (!insert.response.ok) {
      return json(502, { ok: false, error: "upload_prepare_failed" });
    }

    try {
      const signedUrl = await createSignedUpload({ supabaseUrl, key, objectPath });
      return json(200, {
        ok: true,
        case_id: access.caseId,
        upload_id: uploadId,
        signed_upload_url: signedUrl,
        max_encrypted_bytes: MAX_ENCRYPTED_BYTES
      });
    } catch {
      await requestJson(
        `${supabaseUrl}/rest/v1/clinic_document_uploads?id=eq.${encodeURIComponent(uploadId)}`,
        key,
        {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: { status: "failed" }
        }
      ).catch(() => undefined);
      return json(502, { ok: false, error: "signed_upload_failed" });
    }
  }

  if (action === "finalize") {
    const uploadId = String(body?.upload_id || "").trim();
    const encryptedBytes = Number(body?.encrypted_bytes);
    const payloadSha256 = String(body?.payload_sha256 || "").trim().toLowerCase();

    if (!validUuid(uploadId)) return json(400, { ok: false, error: "invalid_upload_id" });
    if (!Number.isInteger(encryptedBytes) || encryptedBytes <= 0 || encryptedBytes > MAX_ENCRYPTED_BYTES) {
      return json(400, { ok: false, error: "invalid_encrypted_size" });
    }
    if (!/^[a-f0-9]{64}$/.test(payloadSha256)) {
      return json(400, { ok: false, error: "invalid_sha256" });
    }

    const uploadLookup = await requestJson(
      `${supabaseUrl}/rest/v1/clinic_document_uploads?id=eq.${encodeURIComponent(uploadId)}&select=id,case_id,object_path,status,encrypted_bytes,payload_sha256&limit=1`,
      key
    );

    if (!uploadLookup.response.ok || !Array.isArray(uploadLookup.data) || uploadLookup.data.length !== 1) {
      return json(404, { ok: false, error: "upload_not_found" });
    }

    const upload = uploadLookup.data[0];
    if (upload.case_id !== access.caseId) return json(403, { ok: false, error: "upload_case_mismatch" });

    if (upload.status === "uploaded") {
      return json(200, {
        ok: true,
        already_completed: true,
        upload_id: uploadId,
        case_id: access.caseId
      });
    }
    if (upload.status !== "pending") return json(409, { ok: false, error: "upload_not_pending" });

    const info = await objectInfo({ supabaseUrl, key, objectPath: upload.object_path });
    if (!info) return json(409, { ok: false, error: "encrypted_object_missing" });
    if (info.size !== null && info.size !== encryptedBytes) {
      return json(409, { ok: false, error: "encrypted_size_mismatch" });
    }

    const finalized = await requestJson(`${supabaseUrl}/rest/v1/rpc/mark_clinic_document_uploaded`, key, {
      method: "POST",
      body: {
        p_upload_id: uploadId,
        p_case_id: access.caseId,
        p_encrypted_bytes: encryptedBytes,
        p_payload_sha256: payloadSha256
      }
    });

    if (!finalized.response.ok || finalized.data !== true) {
      return json(502, { ok: false, error: "upload_finalize_failed" });
    }

    return json(200, {
      ok: true,
      upload_id: uploadId,
      case_id: access.caseId
    });
  }

  return json(400, { ok: false, error: "unknown_action" });
};
