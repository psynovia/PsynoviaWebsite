import { createHash, randomUUID } from "node:crypto";

const BUCKET = "clinic-documents-encrypted";
const MAX_ENCRYPTED_BYTES = 33_554_432;
const MAX_BATCH_FILES = 100;
const ALLOWED_CASE_STATUSES = new Set([
  "clinic_ready_for_access",
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

function encodeObjectPath(path) {
  return String(path).split("/").map(encodeURIComponent).join("/");
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

async function validateCase({ supabaseUrl, key, caseId }) {
  const caseLookup = await requestJson(
    `${supabaseUrl}/rest/v1/cases?case_id=eq.${encodeURIComponent(caseId)}&select=case_id,status,payment_status&limit=1`,
    key
  );
  if (!caseLookup.response.ok || !Array.isArray(caseLookup.data) || caseLookup.data.length !== 1) {
    return { error: "case_not_found", status: 404 };
  }
  const row = caseLookup.data[0];
  if (row.payment_status !== "clinic_paid" || !ALLOWED_CASE_STATUSES.has(String(row.status || ""))) {
    return { error: "upload_not_available", status: 403 };
  }
  return { ok: true };
}

function validateTokenRow(row) {
  if (row.revoked_at) return { error: "upload_link_revoked", status: 403 };
  const expiresAt = new Date(row.expires_at).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return { error: "upload_link_expired", status: 403 };
  }
  return { ok: true };
}

async function resolveUploadAccess({ supabaseUrl, key, token }) {
  if (!validToken(token)) return { error: "invalid_token", status: 403 };
  const tokenHash = hashToken(token);

  const v2 = await requestJson(
    `${supabaseUrl}/rest/v1/clinic_document_upload_tokens_v2?token_hash=eq.${encodeURIComponent(tokenHash)}&select=id,case_id,purpose,mode,expires_at,revoked_at,upload_count&limit=1`,
    key
  );

  if (v2.response.ok && Array.isArray(v2.data) && v2.data.length === 1) {
    const row = v2.data[0];
    const tokenState = validateTokenRow(row);
    if (tokenState.error) return tokenState;
    const caseState = await validateCase({ supabaseUrl, key, caseId: row.case_id });
    if (caseState.error) return caseState;
    const purpose = String(row.purpose || "");
    return {
      tokenId: row.id,
      caseId: row.case_id,
      purpose,
      source: purpose === "clinic_collateral" ? "clinic" : "patient",
      mode: row.mode || "live",
      expiresAt: row.expires_at,
      uploadCount: Number(row.upload_count || 0)
    };
  }

  const legacy = await requestJson(
    `${supabaseUrl}/rest/v1/clinic_document_upload_tokens?token_hash=eq.${encodeURIComponent(tokenHash)}&select=case_id,expires_at,revoked_at,upload_count&limit=1`,
    key
  );

  if (!legacy.response.ok || !Array.isArray(legacy.data) || legacy.data.length !== 1) {
    return { error: "upload_link_invalid", status: 403 };
  }

  const row = legacy.data[0];
  const tokenState = validateTokenRow(row);
  if (tokenState.error) return tokenState;
  const caseState = await validateCase({ supabaseUrl, key, caseId: row.case_id });
  if (caseState.error) return caseState;

  const migrated = await requestJson(
    `${supabaseUrl}/rest/v1/clinic_document_upload_tokens_v2?on_conflict=case_id,purpose`,
    key,
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: {
        case_id: row.case_id,
        purpose: "patient_documents",
        token_hash: tokenHash,
        mode: "live",
        expires_at: row.expires_at,
        revoked_at: null,
        last_used_at: null,
        upload_count: Number(row.upload_count || 0)
      }
    }
  );

  if (!migrated.response.ok || !Array.isArray(migrated.data) || migrated.data.length !== 1) {
    return { error: "upload_link_migration_failed", status: 502 };
  }

  const newRow = migrated.data[0];
  return {
    tokenId: newRow.id,
    caseId: row.case_id,
    purpose: "patient_documents",
    source: "patient",
    mode: "live",
    expiresAt: row.expires_at,
    uploadCount: Number(newRow.upload_count || row.upload_count || 0)
  };
}

async function createSignedUpload({ supabaseUrl, key, objectPath }) {
  const response = await fetch(
    `${supabaseUrl}/storage/v1/object/upload/sign/${BUCKET}/${encodeObjectPath(objectPath)}`,
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
  return relative.startsWith("http")
    ? relative
    : `${supabaseUrl}/storage/v1${relative.startsWith("/") ? "" : "/"}${relative}`;
}

async function objectInfo({ supabaseUrl, key, objectPath }) {
  const response = await fetch(
    `${supabaseUrl}/storage/v1/object/info/authenticated/${BUCKET}/${encodeObjectPath(objectPath)}`,
    { method: "GET", headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) return null;
  const rawSize = data?.metadata?.size ?? data?.size ?? data?.metadata?.contentLength;
  const size = Number(rawSize);
  return Number.isFinite(size) && size > 0 ? { size } : { size: null };
}

async function notifyInternalUpload({ caseId, source, purpose, fileCount }) {
  const resendKey = String(Netlify.env.get("RESEND_API_KEY") || "").trim();
  const resendFrom = String(Netlify.env.get("RESEND_FROM_EMAIL") || "").trim();
  if (!resendKey || !resendFrom) return { ok: false, reason: "mail_config_missing" };

  const sourceLabel = source === "clinic" ? "Klinik" : "Patient";
  const purposeLabel = purpose === "clinic_collateral" ? "klinische Einschätzung / Fremdanamnese" : "ergänzende Patientenunterlagen";
  const singular = fileCount === 1;
  const subject = `${singular ? "Neue Datei" : `${fileCount} neue Dateien`} hochgeladen · ${sourceLabel} · ${caseId}`;
  const text = `${singular ? "Eine neue verschlüsselte Datei" : `${fileCount} neue verschlüsselte Dateien`} bei Psynovia eingegangen.

Fall-ID: ${caseId}
Quelle: ${sourceLabel}
Dokumenttyp: ${purposeLabel}

Dateiinhalte und ursprüngliche Dateinamen wurden nicht per E-Mail übertragen. Bitte den Fall anhand der Fall-ID im sicheren System öffnen.`;

  const mail = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: resendFrom, to: "info@psynovia.de", subject, text })
  });
  return { ok: mail.ok, reason: mail.ok ? null : "mail_failed" };
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const supabaseUrl = String(Netlify.env.get("SUPABASE_URL") || "").trim();
  const key = String(Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
  if (!supabaseUrl || !key) return json(500, { ok: false, error: "server_configuration_missing" });

  let body;
  try { body = await req.json(); } catch { return json(400, { ok: false, error: "invalid_json" }); }

  const action = String(body?.action || "").trim();
  const token = String(body?.token || "").trim();
  const access = await resolveUploadAccess({ supabaseUrl, key, token });
  if (access.error) return json(access.status, { ok: false, error: access.error });

  if (action === "status") {
    return json(200, {
      ok: true,
      case_id: access.caseId,
      purpose: access.purpose,
      source: access.source,
      mode: access.mode,
      expires_at: access.expiresAt,
      upload_count: access.uploadCount,
      max_file_bytes: 30 * 1024 * 1024
    });
  }

  if (action === "prepare") {
    const uploadId = randomUUID();
    const objectPath = `${access.caseId}/${uploadId}.enc`;
    const insert = await requestJson(`${supabaseUrl}/rest/v1/clinic_document_uploads_v2`, key, {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: {
        id: uploadId,
        case_id: access.caseId,
        token_id: access.tokenId,
        source: access.source,
        object_path: objectPath,
        status: "pending"
      }
    });

    if (!insert.response.ok) return json(502, { ok: false, error: "upload_prepare_failed" });

    try {
      const signedUrl = await createSignedUpload({ supabaseUrl, key, objectPath });
      return json(200, {
        ok: true,
        case_id: access.caseId,
        purpose: access.purpose,
        upload_id: uploadId,
        signed_upload_url: signedUrl,
        max_encrypted_bytes: MAX_ENCRYPTED_BYTES
      });
    } catch {
      await requestJson(
        `${supabaseUrl}/rest/v1/clinic_document_uploads_v2?id=eq.${encodeURIComponent(uploadId)}`,
        key,
        { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { status: "failed" } }
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
    if (!/^[a-f0-9]{64}$/.test(payloadSha256)) return json(400, { ok: false, error: "invalid_sha256" });

    const lookup = await requestJson(
      `${supabaseUrl}/rest/v1/clinic_document_uploads_v2?id=eq.${encodeURIComponent(uploadId)}&select=id,case_id,token_id,object_path,status&limit=1`,
      key
    );
    if (!lookup.response.ok || !Array.isArray(lookup.data) || lookup.data.length !== 1) {
      return json(404, { ok: false, error: "upload_not_found" });
    }

    const upload = lookup.data[0];
    if (upload.case_id !== access.caseId || upload.token_id !== access.tokenId) {
      return json(403, { ok: false, error: "upload_case_mismatch" });
    }
    if (upload.status === "uploaded") {
      return json(200, { ok: true, already_completed: true, upload_id: uploadId, case_id: access.caseId });
    }
    if (upload.status !== "pending") return json(409, { ok: false, error: "upload_not_pending" });

    const info = await objectInfo({ supabaseUrl, key, objectPath: upload.object_path });
    if (!info) return json(409, { ok: false, error: "encrypted_object_missing" });
    if (info.size !== null && info.size !== encryptedBytes) {
      return json(409, { ok: false, error: "encrypted_size_mismatch" });
    }

    const finalized = await requestJson(`${supabaseUrl}/rest/v1/rpc/mark_clinic_document_uploaded_v2`, key, {
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
    return json(200, { ok: true, upload_id: uploadId, case_id: access.caseId, purpose: access.purpose });
  }

  if (action === "notify_batch") {
    const uploadIds = Array.isArray(body?.upload_ids) ? body.upload_ids.map(String) : [];
    if (!uploadIds.length || uploadIds.length > MAX_BATCH_FILES || uploadIds.some((id) => !validUuid(id))) {
      return json(400, { ok: false, error: "invalid_upload_ids" });
    }

    const inFilter = uploadIds.map(encodeURIComponent).join(",");
    const lookup = await requestJson(
      `${supabaseUrl}/rest/v1/clinic_document_uploads_v2?id=in.(${encodeURIComponent(inFilter)})&select=id,case_id,token_id,source,status,notification_sent_at`,
      key
    );

    if (!lookup.response.ok || !Array.isArray(lookup.data) || lookup.data.length !== uploadIds.length) {
      return json(409, { ok: false, error: "upload_batch_incomplete" });
    }

    const validRows = lookup.data.filter((row) =>
      row.case_id === access.caseId &&
      row.token_id === access.tokenId &&
      row.source === access.source &&
      row.status === "uploaded"
    );
    if (validRows.length !== uploadIds.length) {
      return json(403, { ok: false, error: "upload_batch_mismatch" });
    }

    const pendingRows = validRows.filter((row) => !row.notification_sent_at);
    if (!pendingRows.length) {
      return json(200, { ok: true, already_notified: true, file_count: uploadIds.length });
    }

    const notification = await notifyInternalUpload({
      caseId: access.caseId,
      source: access.source,
      purpose: access.purpose,
      fileCount: pendingRows.length
    }).catch(() => ({ ok: false, reason: "mail_exception" }));

    if (notification.ok) {
      const pendingIds = pendingRows.map((row) => encodeURIComponent(row.id)).join(",");
      await requestJson(
        `${supabaseUrl}/rest/v1/clinic_document_uploads_v2?id=in.(${encodeURIComponent(pendingIds)})`,
        key,
        {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: { notification_sent_at: new Date().toISOString() }
        }
      ).catch(() => undefined);
    }

    return json(200, {
      ok: true,
      file_count: uploadIds.length,
      internal_notification: notification.ok ? "sent" : "failed"
    });
  }

  return json(400, { ok: false, error: "unknown_action" });
};
