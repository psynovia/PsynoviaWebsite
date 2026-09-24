// Clinic access flow: shell, Hogrefe and encrypted document upload.
const crypto = require("crypto");
const { sendGraphMail } = require("./lib/microsoft-graph-mail");

const HOGREFE_TEST_TYPE = "HASE-KOMBI";
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
  return /^CHIEM-[0-9]{4}-[A-HJ-NP-Z2-9]{8}$/.test(String(value || "").trim().toUpperCase());
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

async function reserveRealHogrefe({ supabaseUrl, key, caseId }) {
  const { response, data } = await sb({
    url: `${supabaseUrl}/rest/v1/rpc/reserve_hogrefe_link`,
    key,
    method: "POST",
    body: { p_case_id: caseId, p_test_type: HOGREFE_TEST_TYPE }
  });
  if (!response.ok || !Array.isArray(data) || data.length !== 1) {
    throw new Error("hogrefe_reservation_failed");
  }
  const a = data[0];
  if (!a.assignment_id || !a.hogrefe_id || !/^https:\/\//i.test(String(a.access_url || ""))) {
    throw new Error("hogrefe_reservation_incomplete");
  }
  return {
    assignmentId: a.assignment_id,
    hogrefeId: a.hogrefe_id,
    hogrefeUrl: a.access_url,
    source: "pool"
  };
}

async function markRealHogrefeMailSent({ supabaseUrl, key, caseId }) {
  const { response, data } = await sb({
    url: `${supabaseUrl}/rest/v1/rpc/mark_hogrefe_mail_sent`,
    key,
    method: "POST",
    body: { p_case_id: caseId, p_test_type: HOGREFE_TEST_TYPE }
  });
  if (!response.ok || data !== true) throw new Error("hogrefe_mail_mark_failed");
}

async function createDocumentUploadLink({ supabaseUrl, key, caseId }) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = futureIsoDate(DOCUMENT_UPLOAD_VALID_DAYS);

  const upsert = await sb({
    url: `${supabaseUrl}/rest/v1/clinic_document_upload_tokens?on_conflict=case_id`,
    key,
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      case_id: caseId,
      token_hash: tokenHash,
      expires_at: expiresAt,
      revoked_at: null,
      last_used_at: null,
      upload_count: 0
    }
  });

  if (!upsert.response.ok) throw new Error("document_upload_link_failed");

  return `https://www.psynovia.de/klinik-unterlagen.html#token=${encodeURIComponent(token)}`;
}

async function finalizeAcceptedMail({ supabaseUrl, key, caseId, mode }) {
  if (mode === "live") {
    await markRealHogrefeMailSent({ supabaseUrl, key, caseId });
  }

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

  return now;
}

function buildMail({ caseId, hogrefeId, hogrefeUrl, shellUrl, documentUploadUrl, testMode }) {
  const testNotice = testMode
    ? `<p style="padding:12px;border:1px solid #f1c27d;border-radius:10px;background:#fff8ed"><strong>TESTVERSAND:</strong> Der Hogrefe-Link unten ist absichtlich kein echter Testzugang und verbraucht keinen Eintrag aus dem Hogrefe-Pool.</p>`
    : "";

  return `<!doctype html><html lang="de"><body style="font-family:Arial,Helvetica,sans-serif;color:#173a5e;line-height:1.55">
    <p>Guten Tag,</p>

    <p>vielen Dank für Ihre Anmeldung in meiner Praxis. Wie im Rahmen Ihrer Behandlung in der Privatklinik ChiemseeWinkel Seebruck besprochen, erhalten Sie nun die Unterlagen und Zugänge für die diagnostische Datenerhebung zur Abklärung einer möglichen ADHS im Erwachsenenalter.</p>

    ${testNotice}

    <h3>Vor Beginn – was Sie wissen sollten</h3>

    <p>Die Datenerhebung besteht aus verschiedenen Fragebögen und standardisierten Leistungstests. Dabei werden unter anderem aktuelle Beschwerden, Erfahrungen aus Kindheit und Lebensverlauf, mögliche Beeinträchtigungen im Alltag sowie verschiedene Bereiche der Aufmerksamkeit und kognitiven Leistungsfähigkeit erfasst.</p>

    <p><strong>Wichtig ist:</strong></p>
    <p>Kein einzelner Fragebogen und kein einzelner Test allein kann eine ADHS feststellen oder ausschließen.</p>
    <p>Die Ergebnisse werden nicht automatisiert diagnostisch bewertet, sondern anschließend von mir fachlich im Gesamtzusammenhang ausgewertet.</p>
    <p>Nach Auswertung der Datenerhebung erfolgt die weitere klinische Einordnung im diagnostischen Abschlussinterview. Dabei können offene Fragen geklärt und die Ergebnisse gemeinsam in den persönlichen Lebensverlauf eingeordnet werden.</p>

    <p>Bitte beantworten Sie die Fragen möglichst ehrlich und so, wie es für Sie tatsächlich zutrifft. Es gibt keine „richtigen“ oder „erwünschten“ Antworten. Auch bei den Leistungstests geht es nicht darum, möglichst gut abzuschneiden, sondern darum, ein möglichst realistisches Bild unter normalen Bedingungen zu erhalten.</p>

    <p>Falls während der Bearbeitung Fragen entstehen oder Sie unsicher sind, können Sie die Bearbeitung jederzeit unterbrechen und sich gerne bei mir melden.</p>

    <p>Ihre <strong>Psynovia-Fall-ID</strong> lautet:</p>
    <p><strong>${caseId}</strong></p>
    <p>Bitte bewahren Sie diese für eventuelle Rückfragen auf.</p>

    <p>Bitte wundern Sie sich nicht, dass im Hogrefe-Testsystem eine andere Kennung angezeigt wird als bei Psynovia. Das ist technisch bedingt und völlig korrekt.</p>

    <p>Die folgenden persönlichen Zugangslinks sind <strong>14 Tage gültig</strong>. Bitte bewahren Sie die Links auf und geben Sie sie nicht an andere Personen weiter.</p>

    <h3>1. Testung über das Hogrefe Testsystem</h3>
    <p>Ihre dortige Kennung lautet:</p>
    <p><strong>${hogrefeId}</strong></p>
    <p>Bitte prüfen Sie zu Beginn der Testung kurz, ob diese Kennung korrekt angezeigt wird.</p>
    <p><a href="${hogrefeUrl}">${hogrefeUrl}</a></p>
    <p>Bitte planen Sie hierfür etwa <strong>40 Minuten ungestörte Zeit</strong> ein. Die Hogrefe-Testung sollte möglichst in einem Durchgang bearbeitet werden. Sorgen Sie bitte für eine ruhige Umgebung und vermeiden Sie Unterbrechungen oder einen Wechsel zwischen verschiedenen Geräten.</p>

    <h3>2. Psynovia-Datenerhebung</h3>
    <p><a href="${shellUrl}">${shellUrl}</a></p>
    <p>Für diesen Teil können Sie sich mehr Zeit lassen. Die Datenerhebung dauert etwa <strong>90 Minuten</strong> und kann bei Bedarf unterbrochen und später über denselben persönlichen Link fortgesetzt werden.</p>
    <p>Bitte bearbeiten Sie insbesondere die Leistungstests in einer möglichst ruhigen Umgebung und nach Möglichkeit nicht unter starkem Zeitdruck, bei ausgeprägter Müdigkeit oder während häufiger Ablenkungen.</p>

    <h3>3. Ergänzende Unterlagen</h3>
    <p>Sofern Ihnen noch Schulzeugnisse aus der Grundschule oder der weiteren Schulzeit vorliegen, können Sie diese über den folgenden geschützten Upload übermitteln:</p>
    <p><a href="${documentUploadUrl}"><strong>Unterlagen sicher hochladen</strong></a></p>
    <p>Dort können Sie Scans oder gut lesbare Fotos verschlüsselt übertragen. Falls keine Zeugnisse mehr vorhanden sind, ist das selbstverständlich kein Problem. Gerne können Sie dort auch andere Dokumente hochladen, die Sie für die diagnostische Einordnung für relevant halten.</p>

    <h3>Wie geht es danach weiter?</h3>
    <p>Sobald die Datenerhebung vollständig vorliegt, werte ich die Ergebnisse fachlich aus und melde mich zur weiteren Terminplanung beziehungsweise zur Vereinbarung des diagnostischen Abschlussinterviews bei Ihnen.</p>

    <p>Ich wünsche Ihnen viel Freude bei der Datenerhebung. Bei technischen Schwierigkeiten oder Rückfragen können Sie jederzeit direkt auf diese E-Mail antworten.</p>

    <p>Mit freundlichen Grüßen</p>
    <p><strong>Tobias Winner, M.Sc.</strong><br>
    Psychologischer Psychotherapeut<br>
    Psynovia – Privatpraxis für Psychotherapie<br>
    Grillparzerstraße 16<br>
    83024 Rosenheim<br>
    tobiaswinner@psynovia.de</p>
  </body></html>`;
}

exports.handler = async function(event) {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const supabaseUrl = String(process.env.SUPABASE_URL || "").trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!supabaseUrl || !key) return json(500, { ok: false, error: "server_configuration_missing" });

  const liveEnabled = String(process.env.CLINIC_AUTO_ACCESS_ENABLED || "").toLowerCase() === "true";
  const testEnabled = String(process.env.CLINIC_ACCESS_TEST_ENABLED || "").toLowerCase() === "true";
  const mode = liveEnabled ? "live" : testEnabled ? "test" : "disabled";
  if (mode === "disabled") return json(503, { ok: false, error: "clinic_access_disabled" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "invalid_json" }); }

  const caseId = String(body.case_id || "").trim().toUpperCase();
  const activationToken = String(body.activation_token || "").trim();
  const submittedEmail = String(body.email || "").trim().toLowerCase();

  if (!validCaseId(caseId) || activationToken.length < 32 || !validEmail(submittedEmail)) {
    return json(400, { ok: false, error: "invalid_request" });
  }

  let recipient = submittedEmail;
  if (mode === "test") {
    const forcedTestRecipient = String(process.env.CLINIC_ACCESS_TEST_RECIPIENT || "").trim().toLowerCase();
    if (!validEmail(forcedTestRecipient)) return json(500, { ok: false, error: "test_recipient_missing" });
    recipient = forcedTestRecipient;
  }

  const tokenHash = hashToken(activationToken);
  const intakeUrl = `${supabaseUrl}/rest/v1/clinic_intake_submissions?case_id=eq.${encodeURIComponent(caseId)}&select=case_id,explanation_status,access_activation_token_hash,access_activation_consumed_at&limit=1`;
  const intakeResult = await sb({ url: intakeUrl, key });
  if (!intakeResult.response.ok || !Array.isArray(intakeResult.data) || intakeResult.data.length !== 1) {
    return json(404, { ok: false, error: "intake_not_found" });
  }
  const intake = intakeResult.data[0];
  if (intake.explanation_status !== "completed") return json(409, { ok: false, error: "explanation_not_completed" });
  if (intake.access_activation_consumed_at) return json(200, { ok: true, already_completed: true, case_id: caseId });
  if (!intake.access_activation_token_hash || intake.access_activation_token_hash !== tokenHash) {
    return json(403, { ok: false, error: "activation_token_invalid" });
  }

  const caseUrl = `${supabaseUrl}/rest/v1/cases?case_id=eq.${encodeURIComponent(caseId)}&select=id,case_id,status,payment_status,download_token,download_locked&limit=1`;
  const caseResult = await sb({ url: caseUrl, key });
  if (!caseResult.response.ok || !Array.isArray(caseResult.data) || caseResult.data.length !== 1) {
    return json(404, { ok: false, error: "case_not_found" });
  }
  const caseRow = caseResult.data[0];
  if (!["clinic_ready_for_access", "clinic_access_granted"].includes(String(caseRow.status || ""))) {
    return json(409, { ok: false, error: "case_not_ready" });
  }

  const dispatchUrl = `${supabaseUrl}/rest/v1/clinic_access_dispatches?case_id=eq.${encodeURIComponent(caseId)}&select=case_id,mode,status,hogrefe_source,mail_sent_at&limit=1`;
  const dispatchResult = await sb({ url: dispatchUrl, key });
  if (!dispatchResult.response.ok) return json(502, { ok: false, error: "dispatch_lookup_failed" });
  if (Array.isArray(dispatchResult.data) && dispatchResult.data[0]?.status === "sent") {
    try {
      await finalizeAcceptedMail({ supabaseUrl, key, caseId, mode: dispatchResult.data[0]?.mode || mode });
      return json(200, { ok: true, already_completed: true, case_id: caseId });
    } catch (error) {
      return json(502, { ok: false, error: "access_finalize_failed" });
    }
  }
  if (Array.isArray(dispatchResult.data) && dispatchResult.data[0]?.status === "sending") {
    return json(409, { ok: false, error: "dispatch_in_progress" });
  }

  let hogrefe;
  if (mode === "test") {
    hogrefe = {
      assignmentId: null,
      hogrefeId: TEST_HOGREFE_ID,
      hogrefeUrl: TEST_HOGREFE_URL,
      source: "test"
    };
  } else {
    hogrefe = await reserveRealHogrefe({ supabaseUrl, key, caseId });
  }

  const downloadToken = /^[a-f0-9]{64}$/i.test(String(caseRow.download_token || ""))
    ? String(caseRow.download_token)
    : crypto.randomBytes(32).toString("hex");
  const shellUrl = `https://www.psynovia.de/.netlify/functions/start-diagnostik?token=${encodeURIComponent(downloadToken)}`;

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
      mode,
      status: "sending",
      hogrefe_source: hogrefe.source,
      hogrefe_assignment_id: hogrefe.assignmentId,
      last_error_code: null,
      updated_at: new Date().toISOString()
    }
  });
  if (!upsertDispatch.response.ok) return json(502, { ok: false, error: "dispatch_prepare_failed" });

  try {
    const documentUploadUrl = await createDocumentUploadLink({ supabaseUrl, key, caseId });
    const html = buildMail({
      caseId,
      hogrefeId: hogrefe.hogrefeId,
      hogrefeUrl: hogrefe.hogrefeUrl,
      shellUrl,
      documentUploadUrl,
      testMode: mode === "test"
    });

    let graphAccepted = false;
    let dispatchRecorded = false;

    await sendGraphMail({
      to: recipient,
      subject: mode === "test"
        ? `TEST · Ihre Psynovia-Zugänge · ${caseId}`
        : "Ihre Psynovia-Zugänge",
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

    await finalizeAcceptedMail({ supabaseUrl, key, caseId, mode });

    return json(200, {
      ok: true,
      case_id: caseId,
      mode,
      hogrefe_source: hogrefe.source
    });
  } catch (error) {
    const errorCode = String(error?.message || "send_failed").slice(0, 120);
    const ambiguousGraphSend = errorCode === "graph_send_ambiguous";
    const graphWasAccepted = typeof graphAccepted !== "undefined" && graphAccepted;
    const acceptedWasRecorded = typeof dispatchRecorded !== "undefined" && dispatchRecorded;
    const mustNotRetryMail = ambiguousGraphSend || graphWasAccepted;

    await sb({
      url: `${supabaseUrl}/rest/v1/clinic_access_dispatches?case_id=eq.${encodeURIComponent(caseId)}`,
      key,
      method: "PATCH",
      prefer: "return=minimal",
      body: {
        // Once Microsoft may have accepted the message, never fall back to a
        // retryable state: that could send the same patient access twice.
        status: acceptedWasRecorded ? "sent" : mustNotRetryMail ? "sending" : "failed",
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
