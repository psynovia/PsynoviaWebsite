const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const HOGREFE_TEST_TYPE = "HASE-KOMBI";
const ACCESS_VALID_DAYS = 14;

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload)
  };
}

function timingSafeEqualString(a, b) {
  const aBuf = Buffer.from(a || "", "utf8");
  const bBuf = Buffer.from(b || "", "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function verifyStripeSignature(rawBody, signatureHeader, endpointSecret) {
  if (!signatureHeader || !endpointSecret) {
    throw new Error("Missing Stripe signature or webhook secret");
  }

  const parts = signatureHeader.split(",");
  const timestampPart = parts.find((part) => part.startsWith("t="));
  const signatureParts = parts.filter((part) => part.startsWith("v1="));

  if (!timestampPart || signatureParts.length === 0) {
    throw new Error("Invalid Stripe signature header");
  }

  const timestamp = timestampPart.slice(2);
  const signedPayload = `${timestamp}.${rawBody}`;

  const expectedSignature = crypto
    .createHmac("sha256", endpointSecret)
    .update(signedPayload, "utf8")
    .digest("hex");

  const isValid = signatureParts.some((part) =>
    timingSafeEqualString(part.slice(3), expectedSignature)
  );

  if (!isValid) throw new Error("Invalid Stripe signature");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function createStableAccessToken(caseId, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(`psynovia-access-v2|${caseId}`, "utf8")
    .digest("hex");
}

function validExistingToken(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value.trim());
}

function futureIsoDate(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function loadAccessMailTemplate({
  fullName,
  caseId,
  hogrefeId,
  hogrefeLink,
  psynoviaLink
}) {
  const templatePath = path.join(__dirname, "access-mail-template-v2.html");
  let html = fs.readFileSync(templatePath, "utf8");

  const replacements = {
    "{{FULL_NAME}}": fullName,
    "{{CASE_ID}}": caseId,
    "{{HOGREFE_ID}}": hogrefeId,
    "{{HOGREFE_LINK}}": hogrefeLink,
    "{{PSYNOVIA_LINK}}": psynoviaLink
  };

  for (const [placeholder, value] of Object.entries(replacements)) {
    html = html.replaceAll(placeholder, escapeHtml(value));
  }

  const unresolved = html.match(/\{\{[A-Z0-9_]+\}\}/g);
  if (unresolved) {
    throw new Error(`Unresolved mail placeholders: ${unresolved.join(", ")}`);
  }

  return html;
}

function buildPlainTextMail({
  fullName,
  caseId,
  hogrefeId,
  hogrefeLink,
  psynoviaLink
}) {
  return `Guten Tag, ${fullName},

herzlich willkommen zu Ihrer ADHS-Diagnostik bei Psynovia und vielen Dank für Ihr Vertrauen.

Ihre Fall-ID: ${caseId}

1. Erster Teil über das Hogrefe Testsystem
Ihre persönliche Hogrefe-ID: ${hogrefeId}
${hogrefeLink}

Nach dem Öffnen werden Ihnen zunächst Seriennummer und TAN angezeigt. Auf der darauffolgenden Seite erscheint Ihre persönliche Hogrefe-ID. Bitte prüfen Sie kurz, ob dort ${hogrefeId} angezeigt wird.

Planen Sie für diesen Abschnitt bitte ungefähr 30 Minuten ungestörte Zeit ein. Die Bearbeitung sollte möglichst vollständig in einem Durchgang erfolgen.

2. Psynovia-Datenerhebung
${psynoviaLink}

Dieser Abschnitt kann bei Bedarf unterbrochen und später über denselben persönlichen Link fortgesetzt werden. Nutzen Sie nach Möglichkeit dasselbe Gerät und denselben Browser und bearbeiten Sie die Leistungstests in einer ruhigen Umgebung.

3. Ergänzende Unterlagen
Schulzeugnisse, insbesondere aus der Grundschulzeit, sowie frühere Befunde, Arztbriefe, Entlassungsberichte oder andere möglicherweise relevante Unterlagen können Sie gerne als gut lesbare Scans oder Fotos per E-Mail zusenden.

4. Auswertung und weiterer Ablauf
Nach Abschluss beider Teile werden Ihre Ergebnisse fachlich ausgewertet. Nach einigen Werktagen erhalten Sie eine ausführliche Auswertung und verständliche Einordnung der bisherigen Ergebnisse. Wenn Sie die diagnostische Abklärung danach vollständig abschließen möchten, vereinbaren wir gemeinsam einen Termin für das diagnostische Abschlussinterview.

Bei Fragen oder technischen Schwierigkeiten können Sie jederzeit direkt auf diese E-Mail antworten.

Mit freundlichen Grüßen
Tobias Winner, M.Sc.
Psychologischer Psychotherapeut
Psynovia – Privatpraxis für Psychotherapie
info@psynovia.de`;
}

async function supabaseRequest({
  url,
  serviceRoleKey,
  method = "GET",
  body,
  prefer
}) {
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
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

async function fetchCase({ supabaseUrl, serviceRoleKey, caseId }) {
  const select = [
    "id",
    "case_id",
    "email",
    "first_name",
    "last_name",
    "download_token",
    "download_expires_at",
    "download_count",
    "payment_status",
    "status",
    "report_available",
    "download_locked",
    "first_downloaded_at",
    "last_downloaded_at"
  ].join(",");

  const url = `${supabaseUrl}/rest/v1/cases?case_id=eq.${encodeURIComponent(
    caseId
  )}&select=${encodeURIComponent(select)}&limit=1`;

  const { response, data } = await supabaseRequest({
    url,
    serviceRoleKey
  });

  if (!response.ok) {
    throw new Error(`Case lookup failed (${response.status})`);
  }

  if (!Array.isArray(data) || data.length === 0) return null;
  return data[0];
}

async function activatePaidCase({
  supabaseUrl,
  serviceRoleKey,
  caseRow,
  session,
  stripeWebhookSecret
}) {
  const hasToken = validExistingToken(caseRow.download_token);
  const downloadToken = hasToken
    ? caseRow.download_token.trim()
    : createStableAccessToken(caseRow.case_id, stripeWebhookSecret);

  const currentStatus = String(caseRow.status || "").trim();
  const currentPaymentStatus = String(caseRow.payment_status || "").trim();
  const initialActivation = currentPaymentStatus !== "paid" || !hasToken;

  const updatePayload = {
    payment_status: "paid",
    stripe_session_id: session.id || null,
    download_token: downloadToken,
    max_downloads: 0
  };

  if (
    !currentStatus ||
    currentStatus === "intake_completed" ||
    currentStatus === "pending" ||
    currentStatus === "payment_pending"
  ) {
    updatePayload.status = "paid";
  }

  if (initialActivation) {
    updatePayload.report_available = false;
    updatePayload.download_locked = false;
  }

  if (!hasToken) {
    updatePayload.download_count = 0;
    updatePayload.first_downloaded_at = null;
    updatePayload.last_downloaded_at = null;
  }

  const expiresAt = caseRow.download_expires_at
    ? new Date(caseRow.download_expires_at).getTime()
    : NaN;

  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    updatePayload.download_expires_at = futureIsoDate(ACCESS_VALID_DAYS);
  }

  const url = `${supabaseUrl}/rest/v1/cases?case_id=eq.${encodeURIComponent(
    caseRow.case_id
  )}`;

  const { response, data } = await supabaseRequest({
    url,
    serviceRoleKey,
    method: "PATCH",
    body: updatePayload,
    prefer: "return=representation"
  });

  if (!response.ok) {
    const error = new Error(`Supabase case update failed (${response.status})`);
    error.details = data;
    throw error;
  }

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("No matching case found during payment activation");
  }

  return data[0];
}

async function reserveHogrefeLink({
  supabaseUrl,
  serviceRoleKey,
  caseId
}) {
  const url = `${supabaseUrl}/rest/v1/rpc/reserve_hogrefe_link`;

  const { response, data } = await supabaseRequest({
    url,
    serviceRoleKey,
    method: "POST",
    body: {
      p_case_id: caseId,
      p_test_type: HOGREFE_TEST_TYPE
    }
  });

  if (!response.ok) {
    const message = String(data?.message || data?.details || "");
    const error = new Error(
      message.includes("HOGREFE_POOL_EMPTY")
        ? "HOGREFE_POOL_EMPTY"
        : `Hogrefe reservation failed (${response.status})`
    );
    error.details = data;
    throw error;
  }

  if (!Array.isArray(data) || data.length !== 1) {
    throw new Error("Hogrefe reservation returned an unexpected result");
  }

  const assignment = data[0];

  if (
    !assignment.assignment_id ||
    !assignment.hogrefe_id ||
    !assignment.access_url
  ) {
    throw new Error("Hogrefe reservation is incomplete");
  }

  if (!/^https:\/\//i.test(String(assignment.access_url))) {
    throw new Error("Hogrefe access URL is invalid");
  }

  return assignment;
}

async function markHogrefeMailSent({
  supabaseUrl,
  serviceRoleKey,
  caseId
}) {
  const url = `${supabaseUrl}/rest/v1/rpc/mark_hogrefe_mail_sent`;

  const { response, data } = await supabaseRequest({
    url,
    serviceRoleKey,
    method: "POST",
    body: {
      p_case_id: caseId,
      p_test_type: HOGREFE_TEST_TYPE
    }
  });

  if (!response.ok || data !== true) {
    const error = new Error("Could not mark Hogrefe access mail as sent");
    error.details = data;
    throw error;
  }
}

async function sendAccessMail({
  to,
  fullName,
  caseId,
  hogrefeId,
  hogrefeLink,
  psynoviaLink,
  assignmentId
}) {
  const resendApiKey = process.env.RESEND_API_KEY;
  const fromEmail =
    process.env.RESEND_FROM_EMAIL || "Psynovia <info@psynovia.de>";

  if (!resendApiKey) throw new Error("RESEND_API_KEY missing");
  if (!to) throw new Error("Recipient email missing");

  const subject = "Ihre Zugänge zur ADHS-Diagnostik bei Psynovia";
  const html = loadAccessMailTemplate({
    fullName,
    caseId,
    hogrefeId,
    hogrefeLink,
    psynoviaLink
  });
  const text = buildPlainTextMail({
    fullName,
    caseId,
    hogrefeId,
    hogrefeLink,
    psynoviaLink
  });

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `psynovia-access-v2/${assignmentId}`,
      "User-Agent": "Psynovia-Netlify/1.0"
    },
    body: JSON.stringify({
      from: fromEmail,
      to,
      reply_to: "info@psynovia.de",
      subject,
      text,
      html
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(`Resend failed (${response.status})`);
    error.details = data;
    throw error;
  }

  return data;
}

exports.handler = async function handler(event) {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  try {
    const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!stripeWebhookSecret || !supabaseUrl || !serviceRoleKey) {
      return jsonResponse(500, {
        error: "Missing required environment variables"
      });
    }

    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : event.body || "";

    const stripeSignature =
      event.headers["stripe-signature"] ||
      event.headers["Stripe-Signature"];

    verifyStripeSignature(rawBody, stripeSignature, stripeWebhookSecret);

    const stripeEvent = JSON.parse(rawBody);

    if (stripeEvent.type !== "checkout.session.completed") {
      return jsonResponse(200, {
        received: true,
        ignored: true,
        type: stripeEvent.type
      });
    }

    const session = stripeEvent.data?.object;
    const caseId = String(session?.client_reference_id || "").trim();
    const stripePaymentStatus = String(session?.payment_status || "").trim();

    if (
      stripePaymentStatus &&
      stripePaymentStatus !== "paid" &&
      stripePaymentStatus !== "no_payment_required"
    ) {
      return jsonResponse(200, {
        received: true,
        payment_pending: true,
        payment_status: stripePaymentStatus,
        case_id: caseId || null
      });
    }

    if (!caseId) {
      return jsonResponse(400, { error: "Missing client_reference_id" });
    }

    const existingCase = await fetchCase({
      supabaseUrl,
      serviceRoleKey,
      caseId
    });

    if (!existingCase) {
      return jsonResponse(404, {
        error: "No matching case found",
        case_id: caseId
      });
    }

    const caseRow = await activatePaidCase({
      supabaseUrl,
      serviceRoleKey,
      caseRow: existingCase,
      session,
      stripeWebhookSecret
    });

    const downloadToken = String(caseRow.download_token || "").trim();
    if (!validExistingToken(downloadToken)) {
      throw new Error("Activated case has no valid access token");
    }

    const recipientEmail = String(caseRow.email || "").trim();
    if (!recipientEmail) {
      throw new Error("Recipient email missing");
    }

    const assignment = await reserveHogrefeLink({
      supabaseUrl,
      serviceRoleKey,
      caseId
    });

    const psynoviaLink =
      `https://www.psynovia.de/.netlify/functions/start-diagnostik?token=` +
      encodeURIComponent(downloadToken);

    const fullName =
      [caseRow.first_name, caseRow.last_name]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .join(" ") || "und willkommen";

    if (assignment.email_sent_at || assignment.assignment_status === "email_sent") {
      return jsonResponse(200, {
        ok: true,
        case_id: caseId,
        hogrefe_id: assignment.hogrefe_id,
        mail_sent: true,
        already_sent: true
      });
    }

    await sendAccessMail({
      to: recipientEmail,
      fullName,
      caseId,
      hogrefeId: assignment.hogrefe_id,
      hogrefeLink: assignment.access_url,
      psynoviaLink,
      assignmentId: assignment.assignment_id
    });

    await markHogrefeMailSent({
      supabaseUrl,
      serviceRoleKey,
      caseId
    });

    return jsonResponse(200, {
      ok: true,
      case_id: caseId,
      hogrefe_id: assignment.hogrefe_id,
      mail_sent: true
    });
  } catch (error) {
    const message = String(error?.message || "Webhook failed");

    console.error("Webhook failed", {
      message,
      details: error?.details || null
    });

    if (message === "HOGREFE_POOL_EMPTY") {
      return jsonResponse(503, {
        error: "Hogrefe link pool is empty",
        retryable: true
      });
    }

    if (
      message.startsWith("Invalid Stripe") ||
      message.startsWith("Missing Stripe") ||
      message.includes("client_reference_id")
    ) {
      return jsonResponse(400, { error: "Webhook validation failed" });
    }

    return jsonResponse(500, {
      error: "Webhook processing failed",
      retryable: true
    });
  }
};
