import { createHash, randomBytes } from "node:crypto";

const DOCUMENT_UPLOAD_VALID_DAYS = 30;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function nonProductionOnly() {
  return String(Netlify.env.get("CONTEXT") || "").trim() !== "production";
}

function hashToken(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function futureIsoDate(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function createClinicUploadLink({ supabaseUrl, key, caseId, origin }) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = futureIsoDate(DOCUMENT_UPLOAD_VALID_DAYS);

  const response = await fetch(
    `${supabaseUrl}/rest/v1/clinic_document_upload_tokens_v2?on_conflict=case_id,purpose`,
    {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({
        case_id: caseId,
        purpose: "clinic_collateral",
        token_hash: tokenHash,
        mode: "test",
        expires_at: expiresAt,
        revoked_at: null,
        last_used_at: null,
        upload_count: 0
      })
    }
  );

  if (!response.ok) throw new Error("clinic_upload_link_failed");
  return `${origin}/klinik-unterlagen-v2.html#token=${encodeURIComponent(token)}`;
}

async function mark(ref, status, sentAt, base, headers) {
  await fetch(`${base}/rest/v1/clinic_intake_submissions?intake_reference=eq.${encodeURIComponent(ref)}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ notification_status: status, notification_sent_at: sentAt })
  });
}

export default async (req) => {
  if (!nonProductionOnly()) return json(404, { ok: false, error: "not_found" });
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  try {
    const supabaseUrl = String(Netlify.env.get("SUPABASE_URL") || "").trim();
    const key = String(Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
    const resendKey = String(Netlify.env.get("RESEND_API_KEY") || "").trim();
    const resendFrom = String(Netlify.env.get("RESEND_FROM_EMAIL") || "").trim();

    if (!supabaseUrl || !key || !resendKey || !resendFrom) {
      return json(500, { ok: false, error: "server_configuration_missing" });
    }

    const body = await req.json();
    const ref = String(body?.intake_reference || "").trim().toUpperCase();
    const questionsOpen = String(body?.explanation_status || "") === "questions_open";
    if (!/^K-TST[A-HJ-NP-Z2-9]{5}$/.test(ref)) {
      return json(400, { ok: false, error: "invalid_test_reference" });
    }

    const headers = { apikey: key, Authorization: `Bearer ${key}` };
    const check = await fetch(
      `${supabaseUrl}/rest/v1/clinic_intake_submissions?intake_reference=eq.${encodeURIComponent(ref)}&select=submission_id,case_id,notification_status,created_at&limit=1`,
      { headers }
    );
    const rows = await check.json();
    if (!check.ok || !Array.isArray(rows) || !rows.length) {
      return json(404, { ok: false, error: "reference_not_found" });
    }

    if (rows[0].notification_status === "sent") {
      return json(200, { ok: true, already_sent: true });
    }

    const caseId = String(rows[0].case_id || "").trim().toUpperCase();
    if (!/^CHIEM-[0-9]{4}-TST[A-HJ-NP-Z2-9]{5}$/.test(caseId)) {
      return json(400, { ok: false, error: "invalid_test_case_id" });
    }

    const origin = new URL(req.url).origin;
    const clinicUploadUrl = await createClinicUploadLink({
      supabaseUrl,
      key,
      caseId,
      origin
    });

    const subject = questionsOpen
      ? `TEST · Rückfragen offen · Psynovia-Klinikaufnahme · ${caseId}`
      : `TEST · Neue Psynovia-Klinikaufnahme · ${caseId}`;

    const text = questionsOpen
      ? `TESTUMGEBUNG – kein realer Patient.\n\nNeue verschlüsselte Klinikaufnahme eingegangen.\n\nStatus: Fragen vor Beginn noch offen – keine Patientenzugänge versendet.\n\nFall-ID: ${caseId}\n\nGeheimer Klinik-Upload-Link für die Fremdanamnese:\n${clinicUploadUrl}\n\nDiesen Link im späteren Live-Betrieb nur bei vorliegender Schweigepflichtentbindung an die behandelnde Ärztin oder Psychotherapeutin weitergeben.`
      : `TESTUMGEBUNG – kein realer Patient.\n\nNeue verschlüsselte Klinikaufnahme eingegangen.\n\nFall-ID: ${caseId}\n\nGeheimer Klinik-Upload-Link für die Fremdanamnese:\n${clinicUploadUrl}\n\nDiesen Link im späteren Live-Betrieb nur bei vorliegender Schweigepflichtentbindung an die behandelnde Ärztin oder Psychotherapeutin weitergeben.\n\nDie personenbezogenen Angaben befinden sich ausschließlich im verschlüsselten Intake.`;

    const mail = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: resendFrom,
        to: "info@psynovia.de",
        subject,
        text
      })
    });

    if (!mail.ok) {
      await mark(ref, "failed", null, supabaseUrl, headers);
      return json(502, { ok: false, error: "notification_mail_failed" });
    }

    await mark(ref, "sent", new Date().toISOString(), supabaseUrl, headers);
    return json(200, { ok: true, case_id: caseId });
  } catch (error) {
    return json(500, { ok: false, error: "function_failed", detail: String(error?.message || error) });
  }
};
