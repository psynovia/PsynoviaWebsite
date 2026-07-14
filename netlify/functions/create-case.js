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
  const safeFirstName = escapeHtml(firstName);
  const safeLastName = escapeHtml(lastName);
  const safeCaseId = escapeHtml(caseId);

  const subject = "Ihr Zugang zur diagnostischen Datenerhebung";

  const text = `
Guten Tag ${firstName} ${lastName},

wir freuen uns, Sie im Rahmen Ihrer Behandlung in der Privatklinik ChiemseeWinkel Seebruck diagnostisch begleiten zu dürfen. Ihre Daten sind bei Psynovia eingegangen, sodass Sie nun mit der digitalen diagnostischen Datenerhebung beginnen können.

Bitte laden Sie das Diagnostiktool über den folgenden Link herunter:

${shellLink}

Wichtig: Der Link lädt eine Datei auf Ihr Gerät herunter. Die Datei heißt:

PsynoviaADHSDiagnostiktool.html

Sie finden diese Datei in der Regel im Download-Ordner Ihres Geräts – auch dann, wenn nach dem Download keine besondere Anzeige erscheint.

Bitte öffnen Sie für die Bearbeitung möglichst immer diese heruntergeladene Datei. Wenn Sie die Datenerhebung unterbrechen, öffnen Sie später dieselbe Datei erneut aus Ihrem Download-Ordner.

Die Datenerhebung umfasst Fragebögen, biografische Angaben und kurze Testaufgaben. Bitte bearbeiten Sie die Module möglichst in einer ruhigen Umgebung und nehmen Sie sich ausreichend Zeit.

Am Ende der Datenerhebung wird die Ergebnisdatei automatisch verschlüsselt an die Praxis übermittelt. Im Diagnostiktool erhalten Sie anschließend eine Eingangsbestätigung.

Nach Eingang der Ergebnisdatei beginnt die fachliche Auswertung. Psynovia meldet sich innerhalb von 1 bis 2 Werktagen mit Terminvorschlägen für das klinische Interview sowie mit Informationen zum weiteren Vorgehen.

Bei technischen Problemen können Sie direkt auf diese E-Mail antworten.

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
    <title>Ihr Zugang zur diagnostischen Datenerhebung</title>
  </head>

  <body style="margin:0;padding:0;background:#eaf5fb;font-family:Arial,Helvetica,sans-serif;color:#07335f;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
      Ihr Zugang zur digitalen diagnostischen Datenerhebung.
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
                  Wir freuen uns, Sie im Rahmen Ihrer Behandlung in der Privatklinik ChiemseeWinkel Seebruck diagnostisch begleiten zu dürfen. Ihre Daten sind bei Psynovia eingegangen, sodass Sie nun mit der digitalen diagnostischen Datenerhebung beginnen können.
                </p>

                <p style="margin:0 0 18px;font-size:16px;line-height:1.55;color:#294f6d;">
                  Bitte laden Sie das Diagnostiktool über den folgenden Link herunter:
                </p>
              </td>
            </tr>

            <tr>
              <td align="center" style="padding:10px 28px 24px;">
                <a href="${shellLink}" style="display:inline-block;background:#07335f;color:#ffffff;text-decoration:none;font-size:17px;font-weight:900;padding:15px 26px;border-radius:16px;box-shadow:0 12px 24px rgba(7,51,95,0.22);">
                  Diagnostiktool herunterladen
                </a>
              </td>
            </tr>

            <tr>
              <td style="padding:0 28px 12px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="padding:15px 16px;background:#eef9fd;border:1px solid #cfe8f3;border-radius:16px;">
                      <div style="font-size:15px;line-height:1.5;color:#294f6d;">
                        <strong style="color:#07335f;">Wichtig:</strong><br>
                        Der Link lädt eine Datei auf Ihr Gerät herunter. Die Datei heißt:
                        <br><br>
                        <strong style="color:#07335f;">PsynoviaADHSDiagnostiktool.html</strong>
                        <br><br>
                        Sie finden diese Datei in der Regel im <strong>Download-Ordner</strong> Ihres Geräts – auch dann, wenn nach dem Download keine besondere Anzeige erscheint.
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:6px 28px 10px;">
                <p style="margin:0 0 14px;font-size:15.5px;line-height:1.55;color:#294f6d;">
                  Bitte öffnen Sie für die Bearbeitung möglichst immer diese heruntergeladene Datei. Wenn Sie die Datenerhebung unterbrechen, öffnen Sie später dieselbe Datei erneut aus Ihrem Download-Ordner.
                </p>

                <p style="margin:0 0 14px;font-size:15.5px;line-height:1.55;color:#294f6d;">
                  Die Datenerhebung umfasst Fragebögen, biografische Angaben und kurze Testaufgaben. Bitte bearbeiten Sie die Module möglichst in einer ruhigen Umgebung und nehmen Sie sich ausreichend Zeit.
                </p>

                <p style="margin:0 0 14px;font-size:15.5px;line-height:1.55;color:#294f6d;">
                  Am Ende der Datenerhebung wird die Ergebnisdatei automatisch verschlüsselt an die Praxis übermittelt. Im Diagnostiktool erhalten Sie anschließend eine Eingangsbestätigung.
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:8px 28px 12px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="padding:14px 16px;background:#fffaf2;border:1px solid #f2d9b4;border-radius:16px;">
                      <div style="font-size:15px;line-height:1.5;color:#67420d;">
                        Nach Eingang der Ergebnisdatei beginnt die fachliche Auswertung. Psynovia meldet sich innerhalb von <strong>1 bis 2 Werktagen</strong> mit Terminvorschlägen für das klinische Interview sowie mit Informationen zum weiteren Vorgehen.
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:12px 28px 26px;">
                <p style="margin:0 0 14px;font-size:15.5px;line-height:1.55;color:#294f6d;">
                  Bei technischen Problemen können Sie direkt auf diese E-Mail antworten.
                </p>

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
