const crypto = require("crypto");

exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !RESEND_API_KEY || !RESEND_FROM_EMAIL) {
      return json(500, { error: "Missing environment variables" });
    }

    const payload = JSON.parse(event.body || "{}");

    const firstName = clean(payload.first_name);
    const lastName = clean(payload.last_name);
    const email = clean(payload.email).toLowerCase();

    if (!firstName || !lastName || !email) {
      return json(400, { error: "Missing required patient data" });
    }

    const now = new Date();
    const year = now.getFullYear();
    const random = crypto.randomBytes(3).toString("hex").toUpperCase();
    const caseId = `CHIEM-${year}-${random}`;

    const downloadToken = crypto.randomBytes(32).toString("hex");

    const expires = new Date();
    expires.setDate(expires.getDate() + 14);

    const intakeJson = {
      schema_version: "psynovia_clinic_chiemsee_intake_v1",
      source: "clinic_chiemsee",
      created_iso: now.toISOString(),
      basis: {
        first_name: firstName,
        last_name: lastName,
        name: `${firstName} ${lastName}`,
        birth: clean(payload.birth),
        email,
        phone: clean(payload.phone),
        sex_at_birth: clean(payload.sex_at_birth)
      },
      clinic: {
        clinic_name: "Privatklinik am Chiemsee",
        billing_mode: "clinic_cooperation_no_stripe",
        release_to_clinic: Boolean(payload.release_to_clinic),
        clinic_contact_person: clean(payload.clinic_contact_person),
        clinical_contact_optional: true
      },
      consents: {
        privacy: {
          accepted: Boolean(payload.privacy_accepted),
          accepted_iso: now.toISOString()
        },
        contract: {
          accepted: Boolean(payload.contract_accepted),
          accepted_iso: now.toISOString()
        },
        clinic_release: {
          accepted: Boolean(payload.release_to_clinic),
          accepted_iso: payload.release_to_clinic ? now.toISOString() : null
        },
        service_overview: {
          accepted: Boolean(payload.service_overview_accepted),
          accepted_iso: now.toISOString()
        }
      }
    };

    if (!payload.privacy_accepted || !payload.contract_accepted || !payload.service_overview_accepted) {
      return json(400, { error: "Required consents missing" });
    }

    const row = {
      case_id: caseId,
      first_name: firstName,
      last_name: lastName,
      email,
      payment_status: "paid",
      intake_completed: true,
      assessment_completed: false,
      report_available: false,
      status: "clinic_access_granted",
      intake_json: intakeJson,
      download_token: downloadToken,
      download_count: 0,
      max_downloads: 99,
      download_locked: false,
      download_expires_at: expires.toISOString()
    };

    const supabaseResponse = await fetch(`${SUPABASE_URL}/rest/v1/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Prefer": "return=representation"
      },
      body: JSON.stringify(row)
    });

    const supabaseData = await supabaseResponse.json();

    if (!supabaseResponse.ok) {
      return json(supabaseResponse.status, {
        error: "Supabase insert failed",
        details: supabaseData
      });
    }

    const shellLink =
      `https://www.psynovia.de/.netlify/functions/get-shell-link?token=${encodeURIComponent(downloadToken)}`;

    await sendAccessMail({
      apiKey: RESEND_API_KEY,
      from: RESEND_FROM_EMAIL,
      to: email,
      firstName,
      lastName,
      caseId,
      shellLink
    });

    return json(200, {
      ok: true,
      case_id: caseId,
      email,
      status: "clinic_access_granted"
    });

  } catch (error) {
    return json(500, {
      error: "Function failed",
      details: error.message
    });
  }
};

function clean(value) {
  return String(value || "").trim();
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  };
}

async function sendAccessMail({ apiKey, from, to, firstName, lastName, caseId, shellLink }) {
  const subject = "Ihr Zugang zur Psynovia-Datenerhebung";

  const html = `
  <div style="font-family:Arial,sans-serif;line-height:1.55;color:#1f2937;max-width:640px;margin:0 auto;">
    <h2 style="color:#2454d6;">Ihr Zugang zur diagnostischen Datenerhebung</h2>

    <p>Guten Tag ${escapeHtml(firstName)} ${escapeHtml(lastName)},</p>

    <p>
      Ihre Anmeldung über die Privatklinik am Chiemsee ist bei Psynovia eingegangen.
      Sie können nun mit der digitalen diagnostischen Datenerhebung beginnen.
    </p>

    <p>
      Bitte bearbeiten Sie die Datenerhebung möglichst auf einem Gerät mit stabiler Internetverbindung.
      Die Bearbeitung kann einige Zeit in Anspruch nehmen.
    </p>

    <p style="margin:24px 0;">
      <a href="${shellLink}" style="background:#2454d6;color:white;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block;font-weight:bold;">
        Datenerhebung öffnen
      </a>
    </p>

    <p>
      Ihre Fall-ID lautet: <strong>${escapeHtml(caseId)}</strong>
    </p>

    <p>
      Nach Abschluss der Datenerhebung senden Sie die erzeugte Ergebnisdatei bitte über die vorgesehene Upload-Funktion zurück.
    </p>

    <p>
      Bei technischen Problemen können Sie auf diese E-Mail antworten.
    </p>

    <p style="margin-top:24px;">
      Mit freundlichen Grüßen<br>
      Tobias Winner<br>
      Psynovia
    </p>
  </div>
  `;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      html
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error("Resend mail failed: " + JSON.stringify(data));
  }

  return data;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
