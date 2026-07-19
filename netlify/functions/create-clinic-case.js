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

    if (!payload.privacy_accepted || !payload.contract_accepted || !payload.service_overview_accepted) {
      return json(400, { error: "Required consents missing" });
    }

    const now = new Date();
    const year = now.getFullYear();
    const random = crypto.randomBytes(3).toString("hex").toUpperCase();
    const caseId = `CHIEM-${year}-${random}`;

    const downloadToken = crypto.randomBytes(32).toString("hex");

    const expires = new Date();
    expires.setDate(expires.getDate() + 14);

    const intakeJson = {
      schema_version: "psynovia_clinic_chiemseewinkel_intake_v1",
      source: "clinic_chiemseewinkel",
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
        clinic_name: "Privatklinik ChiemseeWinkel Seebruck",
        billing_mode: "clinic_cooperation_manual_access",
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
          accepted_iso: payload.release_to_clinic ? now.toISOString() : null,
          text: payload.release_to_clinic
            ? "Ich entbinde die Privatpraxis Psynovia gegenüber der Privatklinik ChiemseeWinkel Seebruck von der Schweigepflicht. Die Einwilligung umfasst den fachlichen Austausch, soweit dieser für die ADHS-diagnostische Abklärung erforderlich ist. Dazu gehören insbesondere Rückfragen zum Behandlungsverlauf, zur klinischen Einschätzung, zu anamnestischen Angaben, zu relevanten Vorbefunden sowie die Übermittlung diagnostischer Einschätzungen und Befundinformationen an die benannte klinische Ansprechperson. Mir ist bekannt, dass diese Einwilligung freiwillig ist und jederzeit mit Wirkung für die Zukunft widerrufen werden kann."
            : null
        },
        service_overview: {
          accepted: Boolean(payload.service_overview_accepted),
          accepted_iso: now.toISOString()
        }
      }
    };

    const row = {
      case_id: caseId,
      first_name: firstName,
      last_name: lastName,
      email,

      // Für den Klinik-MVP bleibt paid gesetzt,
      // damit spätere manuelle Freischaltung / Shell-Zugang technisch kompatibel bleibt.
      payment_status: "paid",

      intake_completed: true,
      assessment_completed: false,
      report_available: false,

      // Übergangsstatus: Zugang wird NICHT automatisch per Mail verschickt.
      status: "clinic_pending_manual_access",

      intake_json: intakeJson,

      // Token wird trotzdem intern erzeugt,
      // damit du den Zugang später manuell freischalten oder verwenden kannst.
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

    await sendManualAccessMail({
      apiKey: RESEND_API_KEY,
      from: RESEND_FROM_EMAIL,
      to: email,
      firstName,
      lastName,
      caseId
    });

    return json(200, {
      ok: true,
      case_id: caseId,
      email,
      status: "clinic_pending_manual_access"
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

async function sendManualAccessMail({ apiKey, from, to, firstName, lastName, caseId }) {
  const safeFirstName = escapeHtml(firstName);
  const safeLastName = escapeHtml(lastName);
  const safeCaseId = escapeHtml(caseId);

  const subject = "Ihre Anmeldung zur ADHS-diagnostischen Abklärung";

  const text = `
Guten Tag ${firstName} ${lastName},

wir freuen uns, Sie im Rahmen Ihrer Behandlung in der Privatklinik ChiemseeWinkel Seebruck diagnostisch begleiten zu dürfen.

Ihre Angaben sind bei Psynovia eingegangen. Ihre persönliche Fall-ID lautet:

${caseId}

Der Zugang zur digitalen diagnostischen Datenerhebung wird anschließend manuell freigeschaltet. Sie erhalten dazu eine gesonderte Nachricht mit dem weiteren Vorgehen.

Bitte bewahren Sie diese Fall-ID auf. Sie dient der eindeutigen Zuordnung Ihrer diagnostischen Datenerhebung.

Bei technischen Fragen können Sie direkt auf diese E-Mail antworten.

Mit freundlichen Grüßen
Tobias Winner, M.Sc.
Psychologischer Psychotherapeut

Technische Referenz: ${caseId}
`;

  const html = `
  <!doctype html>
  <html lang="de">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ihre Anmeldung zur ADHS-diagnostischen Abklärung</title>
  </head>

  <body style="margin:0;padding:0;background:#eaf5fb;font-family:Arial,Helvetica,sans-serif;color:#07335f;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
      Ihre Angaben sind bei Psynovia eingegangen.
    </div>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eaf5fb;margin:0;padding:24px 12px 34px;">
      <tr>
        <td align="center">

          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border-radius:24px;overflow:hidden;border:1px solid #d8e8f2;box-shadow:0 14px 34px rgba(7,51,95,0.12);">

            <tr>
              <td style="padding:22px 26px 18px;background:linear-gradient(180deg,#f8fdff 0%,#eef8fd 100%);">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="width:52px;vertical-align:middle;">
                      <img src="https://www.psynovia.de/psynovia-logo.png" alt="Psynovia" width="44" style="display:block;width:44px;max-width:44px;height:auto;border:0;">
                    </td>
                    <td style="vertical-align:middle;">
                      <div style="font-size:19px;line-height:1.1;color:#07335f;font-weight:900;letter-spacing:-0.02em;">
                        Psynovia
                      </div>
                      <div style="font-size:13px;line-height:1.25;color:#58758b;font-weight:700;margin-top:3px;">
                        Privatpraxis für klinische Diagnostik
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:28px 28px 8px;">
                <p style="margin:0 0 16px;font-size:16px;line-height:1.55;color:#294f6d;">
                  Guten Tag ${safeFirstName} ${safeLastName},
                </p>

                <p style="margin:0 0 18px;font-size:16px;line-height:1.58;color:#294f6d;">
                  Wir freuen uns, Sie im Rahmen Ihrer Behandlung in der Privatklinik ChiemseeWinkel Seebruck diagnostisch begleiten zu dürfen.
                </p>

                <p style="margin:0 0 18px;font-size:16px;line-height:1.55;color:#294f6d;">
                  Ihre Angaben sind bei Psynovia eingegangen.
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:8px 28px 14px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="padding:18px 18px;background:#eef9fd;border:1px solid #cfe8f3;border-radius:16px;text-align:center;">
                      <div style="font-size:13px;line-height:1.4;color:#58758b;font-weight:800;text-transform:uppercase;letter-spacing:0.05em;">
                        Ihre persönliche Fall-ID
                      </div>
                      <div style="font-size:24px;line-height:1.25;color:#07335f;font-weight:900;margin-top:8px;letter-spacing:0.02em;">
                        ${safeCaseId}
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:8px 28px 12px;">
                <p style="margin:0 0 14px;font-size:15.5px;line-height:1.55;color:#294f6d;">
                  Der Zugang zur digitalen diagnostischen Datenerhebung wird anschließend manuell freigeschaltet. Sie erhalten dazu eine gesonderte Nachricht mit dem weiteren Vorgehen.
                </p>

                <p style="margin:0 0 14px;font-size:15.5px;line-height:1.55;color:#294f6d;">
                  Bitte bewahren Sie diese Fall-ID auf. Sie dient der eindeutigen Zuordnung Ihrer diagnostischen Datenerhebung.
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:8px 28px 12px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="padding:14px 16px;background:#fffaf2;border:1px solid #f2d9b4;border-radius:16px;">
                      <div style="font-size:15px;line-height:1.5;color:#67420d;">
                        Bei technischen Fragen können Sie direkt auf diese E-Mail antworten.
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:12px 28px 26px;">
                <p style="margin:0;font-size:15.5px;line-height:1.55;color:#294f6d;">
                  Mit freundlichen Grüßen<br>
                  <strong>Tobias Winner, M.Sc.</strong><br>
                  Psychologischer Psychotherapeut
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:16px 28px;background:#07335f;">
                <p style="margin:0;font-size:12px;line-height:1.45;color:#d9ecf5;">
                  Technische Referenz: ${safeCaseId}
                </p>
              </td>
            </tr>

          </table>

        </td>
      </tr>
    </table>
  </body>
  </html>
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
      html,
      text
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
