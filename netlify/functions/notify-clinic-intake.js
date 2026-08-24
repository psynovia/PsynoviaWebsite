exports.handler = async function(event) {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !RESEND_API_KEY || !RESEND_FROM_EMAIL) {
      return json(500, { ok: false, error: "server_configuration_missing" });
    }

    const body = JSON.parse(event.body || "{}");
    const ref = String(body.intake_reference || "").trim().toUpperCase();
    if (!/^K-[A-HJ-NP-Z2-9]{8}$/.test(ref)) return json(400, { ok: false, error: "invalid_reference" });

    const headers = {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
    };

    const check = await fetch(
      `${SUPABASE_URL}/rest/v1/clinic_intake_submissions?intake_reference=eq.${encodeURIComponent(ref)}&select=submission_id,notification_status,created_at&limit=1`,
      { headers }
    );
    const rows = await check.json();
    if (!check.ok || !Array.isArray(rows) || !rows.length) return json(404, { ok: false, error: "reference_not_found" });

    if (rows[0].notification_status === "sent") return json(200, { ok: true, already_sent: true });

    const subject = `Neue Psynovia-Klinikaufnahme · ${ref}`;
    const text = `Neue verschlüsselte Klinikaufnahme eingegangen.\n\nAufnahmereferenz: ${ref}\n\nDie personenbezogenen Angaben befinden sich ausschließlich im verschlüsselten Intake. Bitte den Eintrag in Supabase anhand dieser Referenz öffnen und lokal entschlüsseln.`;

    const mail = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: "info@psynovia.de",
        subject,
        text
      })
    });

    if (!mail.ok) {
      await mark(ref, "failed", null, SUPABASE_URL, headers);
      return json(502, { ok: false, error: "notification_mail_failed" });
    }

    await mark(ref, "sent", new Date().toISOString(), SUPABASE_URL, headers);
    return json(200, { ok: true });
  } catch (error) {
    return json(500, { ok: false, error: "function_failed" });
  }
};

async function mark(ref, status, sentAt, base, headers) {
  await fetch(`${base}/rest/v1/clinic_intake_submissions?intake_reference=eq.${encodeURIComponent(ref)}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ notification_status: status, notification_sent_at: sentAt })
  });
}

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
