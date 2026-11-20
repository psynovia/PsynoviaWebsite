const crypto = require("crypto");
const { sendGraphMail } = require("./lib/microsoft-graph-mail");

const ACCESS_VALID_DAYS = 14;
const DOCUMENT_UPLOAD_VALID_DAYS = 30;
const TEST_HOGREFE_ID = "TEST-HASE-KOMBI";
const TEST_HOGREFE_URL = "https://example.invalid/psynovia-hogrefe-test";

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    },
    body: JSON.stringify(body)
  };
}

function hashToken(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function validCaseId(value) {
  return /^CHIEM-[0-9]{4}-TST[A-HJ-NP-Z2-9]{5}$/.test(String(value || "").trim().toUpperCase());
}

function validEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function futureIsoDate(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function sb({ url, key, method = "GET", body, prefer }) {
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json"
  };
  if (prefer) headers.Prefer = prefer;
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => null);
  return { response, data };
}

async function createPatientDocumentUploadLink({ supabaseUrl, key, caseId, origin }) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = futureIsoDate(DOCUMENT_UPLOAD_VALID_DAYS);

  const upsert = await sb({
    url: `${supabaseUrl}/rest/v1/clinic_document_upload_tokens_v2?on_conflict=case_id,purpose`,
    key,
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      case_id: caseId,
      purpose: "patient_documents",
      token_hash: tokenHash,
      mode: "test",
      expires_at: expiresAt,
      revoked_at: null,
      last_used_at: null,
      upload_count: 0
    }
  });

  if (!upsert.response.ok) throw new Error("document_upload_link_failed");
  return `${origin}/klinik-unterlagen-v2.html#token=${encodeURIComponent(token)}`;
}

async function finalizeAcceptedMail({ supabaseUrl, key, caseId }) {
  const now = new Date().toISOString();

  const unlock = await sb({
    url: `${supabaseUrl}/rest/v1/cases?case_id=eq.${encodeURIComponent(caseId)}`,
    key,
    method: "PATCH",
    prefer: "return=minimal",
    body: {
      status: "clinic_access_granted",
      payment_status: "clinic_paid",
      download_locked: false
    }
  });
  if (!unlock.response.ok) throw new Error("case_unlock_failed");

  const consume = await sb({
    url: `${supabaseUrl}/rest/v1/clinic_intake_submissions?case_id=eq.${encodeURIComponent(caseId)}`,
    key,
    method: "PATCH",
    prefer: "return=minimal",
    body: { access_activation_consumed_at: now }
  });
  if (!consume.response.ok) throw new Error("activation_consume_failed");
}

function buildMail({ caseId, shellUrl, documentUploadUrl }) {
  return `<!doctype html><html lang="de"><body style="font-family:Arial,Helvetica,sans-serif;color:#173a5e;line-height:1.55">
    <p style="padding:12px;border:1px solid #f1c27d;border-radius:10px;background:#fff8ed"><strong>TESTUMGEBUNG:</strong> Dies ist ein Testfall. Es wird kein echter Hogrefe-Zugang verbraucht.</p>
    <p>Guten Tag,</p>
    <p>dies ist die Testversion der automatischen Psynovia-Zugangsmail.</p>

    <p>Ihre <strong>Psynovia-Fall-ID</strong> lautet:</p>
    <p><strong>${caseId}</strong></p>

    <h3>1. Testung über das Hogrefe Testsystem</h3>
    <p>Kennung: <strong>${TEST_HOGREFE_ID}</strong></p>
    <p><a href="${TEST_HOGREFE_URL}"><strong>Hogrefe-Testung starten</strong></a></p>
    <p><strong>Dieser Link ist absichtlich nur ein Dummy und verbraucht keinen echten Hogrefe-Link.</strong></p>

    <h3>2. Psynovia-Datenerhebung</h3>
    <p><a href="${shellUrl}"><strong>Psynovia-Datenerhebung starten</strong></a></p>

    <h3>3. Ergänzende Unterlagen des Patienten</h3>
    <p><a href="${documentUploadUrl}"><strong>Unterlagen sicher hochladen</strong></a></p>

    <p>Mit freundlichen Grüßen</p>
    <p><strong>Tobias Winner, M.Sc.</strong><br>Psychologischer Psychotherapeut<br>Psynovia</p>
  </body></html>`;
}

exports.handler = async function(event) {
  if (String(process.env.CONTEXT || "").trim() === "production") {
    return json(404, { ok: false, error: "not_found" });
  }
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const supabaseUrl = String(process.env.SUPABASE_URL || "").trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!supabaseUrl || !key) return json(500, { ok: false, error: "server_configuration_missing" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "invalid_json" }); }

  const caseId = String(body.case_id || "").trim().toUpperCase();
  const activationToken = String(body.activation_token || "").trim();
  const submittedEmail = String(body.email || "").trim().toLowerCase();

  if (!validCaseId(caseId) || activationToken.length < 32 || !validEmail(submittedEmail)) {
    return json(400, { ok: false, error: "invalid_request" });
  }

  const tokenHash = hashToken(activationToken);
  const intakeResult = await sb({
    url: `${supabaseUrl}/rest/v1/clinic_intake_submissions?case_id=eq.${encodeURIComponent(caseId)}&select=case_id,explanation_status,access_activation_token_hash,access_activation_consumed_at&limit=1`,
    key
  });

  if (!intakeResult.response.ok || !Array.isArray(intakeResult.data) || intakeResult.data.length !== 1) {
    return json(404, { ok: false, error: "intake_not_found" });
  }

  const intake = intakeResult.data[0];
  if (intake.explanation_status !== "completed") return json(409, { ok: false, error: "explanation_not_completed" });
  if (intake.access_activation_consumed_at) return json(200, { ok: true, already_completed: true, case_id: caseId });
  if (!intake.access_activation_token_hash || intake.access_activation_token_hash !== tokenHash) {
    return json(403, { ok: false, error: "activation_token_invalid" });
  }

  const caseResult = await sb({
    url: `${supabaseUrl}/rest/v1/cases?case_id=eq.${encodeURIComponent(caseId)}&select=id,case_id,status,payment_status,download_token,download_locked&limit=1`,
    key
  });

  if (!caseResult.response.ok || !Array.isArray(caseResult.data) || caseResult.data.length !== 1) {
    return json(404, { ok: false, error: "case_not_found" });
  }

  const caseRow = caseResult.data[0];
  if (!["clinic_ready_for_access", "clinic_access_granted"].includes(String(caseRow.status || ""))) {
    return json(409, { ok: false, error: "case_not_ready" });
  }

  const dispatchResult = await sb({
    url: `${supabaseUrl}/rest/v1/clinic_access_dispatches?case_id=eq.${encodeURIComponent(caseId)}&select=case_id,mode,status,hogrefe_source,mail_sent_at&limit=1`,
    key
  });

  if (!dispatchResult.response.ok) return json(502, { ok: false, error: "dispatch_lookup_failed" });

  if (Array.isArray(dispatchResult.data) && dispatchResult.data[0]?.status === "sent") {
    try {
      await finalizeAcceptedMail({ supabaseUrl, key, caseId });
      return json(200, { ok: true, already_completed: true, case_id: caseId });
    } catch {
      return json(502, { ok: false, error: "access_finalize_failed" });
    }
  }

  if (Array.isArray(dispatchResult.data) && dispatchResult.data[0]?.status === "sending") {
    return json(409, { ok: false, error: "dispatch_in_progress" });
  }

  const downloadToken = /^[a-f0-9]{64}$/i.test(String(caseRow.download_token || ""))
    ? String(caseRow.download_token)
    : crypto.randomBytes(32).toString("hex");

  const origin = `https://${event.headers.host}`;
  const shellUrl = `${origin}/.netlify/functions/start-diagnostik?token=${encodeURIComponent(downloadToken)}`;

  const prepareCase = await sb({
    url: `${supabaseUrl}/rest/v1/cases?case_id=eq.${encodeURIComponent(caseId)}`,
    key,
    method: "PATCH",
    prefer: "return=minimal",
    body: {
      download_token: downloadToken,
      download_expires_at: futureIsoDate(ACCESS_VALID_DAYS),
      max_downloads: 0,
      download_locked: true
    }
  });
  if (!prepareCase.response.ok) return json(502, { ok: false, error: "case_prepare_failed" });

  const upsertDispatch = await sb({
    url: `${supabaseUrl}/rest/v1/clinic_access_dispatches?on_conflict=case_id`,
    key,
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      case_id: caseId,
      mode: "test",
      status: "sending",
      hogrefe_source: "test",
      hogrefe_assignment_id: null,
      last_error_code: null,
      updated_at: new Date().toISOString()
    }
  });
  if (!upsertDispatch.response.ok) return json(502, { ok: false, error: "dispatch_prepare_failed" });

  let graphAccepted = false;
  let dispatchRecorded = false;

  try {
    const documentUploadUrl = await createPatientDocumentUploadLink({
      supabaseUrl,
      key,
      caseId,
      origin
    });

    const html = buildMail({ caseId, shellUrl, documentUploadUrl });

    await sendGraphMail({
      to: submittedEmail,
      subject: `TEST · Ihre Psynovia-Zugänge · ${caseId}`,
      html
    });
    graphAccepted = true;

    const now = new Date().toISOString();
    const recordAccepted = await sb({
      url: `${supabaseUrl}/rest/v1/clinic_access_dispatches?case_id=eq.${encodeURIComponent(caseId)}`,
      key,
      method: "PATCH",
      prefer: "return=minimal",
      body: { status: "sent", mail_sent_at: now, updated_at: now, last_error_code: null }
    });
    if (!recordAccepted.response.ok) throw new Error("graph_accepted_dispatch_unconfirmed");
    dispatchRecorded = true;

    await finalizeAcceptedMail({ supabaseUrl, key, caseId });

    return json(200, {
      ok: true,
      case_id: caseId,
      mode: "test",
      hogrefe_source: "test",
      recipient: submittedEmail
    });
  } catch (error) {
    const errorCode = String(error?.message || "send_failed").slice(0, 120);
    const ambiguousGraphSend = errorCode === "graph_send_ambiguous";
    const mustNotRetryMail = ambiguousGraphSend || graphAccepted;

    await sb({
      url: `${supabaseUrl}/rest/v1/clinic_access_dispatches?case_id=eq.${encodeURIComponent(caseId)}`,
      key,
      method: "PATCH",
      prefer: "return=minimal",
      body: {
        status: dispatchRecorded ? "sent" : mustNotRetryMail ? "sending" : "failed",
        last_error_code: errorCode,
        updated_at: new Date().toISOString()
      }
    }).catch(() => undefined);

    return json(502, {
      ok: false,
      error: mustNotRetryMail ? "access_mail_status_uncertain" : "access_mail_failed"
    });
  }
};
