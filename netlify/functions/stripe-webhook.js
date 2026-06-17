const crypto = require("crypto");

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
  const timestampPart = parts.find((p) => p.startsWith("t="));
  const signatureParts = parts.filter((p) => p.startsWith("v1="));

  if (!timestampPart || signatureParts.length === 0) {
    throw new Error("Invalid Stripe signature header");
  }

  const timestamp = timestampPart.slice(2);
  const signedPayload = `${timestamp}.${rawBody}`;

  const expectedSignature = crypto
    .createHmac("sha256", endpointSecret)
    .update(signedPayload, "utf8")
    .digest("hex");

  const isValid = signatureParts.some((part) => {
    const receivedSignature = part.slice(3);
    return timingSafeEqualString(receivedSignature, expectedSignature);
  });

  if (!isValid) {
    throw new Error("Invalid Stripe signature");
  }

  return true;
}

async function sendAccessMail({ to, caseId, accessLink }) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "Psynovia <info@psynovia.de>";

  if (!RESEND_API_KEY) {
    console.error("RESEND_API_KEY missing");
    return { ok: false, error: "RESEND_API_KEY missing" };
  }

  if (!to) {
    console.error("Recipient email missing");
    return { ok: false, error: "Recipient email missing" };
  }

  const subject = "Ihr Zugang zur Psynovia Datenerhebung";

  const text = `Vielen Dank für Ihre Buchung.

Ihre Fall-ID lautet: ${caseId}

Über den folgenden Link können Sie das Diagnostiktool herunterladen:

${accessLink}

Bitte bewahren Sie Ihre Fall-ID gut auf.

Die Bearbeitung erfolgt lokal auf Ihrem Gerät. Nach Abschluss laden Sie die erzeugte Ergebnisdatei wie beschrieben hoch.

Bei Fragen erreichen Sie uns unter:
info@psynovia.de

Freundliche Grüße
Psynovia`;

  const html = `
    <p>Vielen Dank für Ihre Buchung.</p>

    <p><strong>Ihre Fall-ID lautet:</strong><br>${caseId}</p>

    <p>Über den folgenden Link können Sie das Diagnostiktool herunterladen:</p>

    <p>
      <a href="${accessLink}" target="_blank" rel="noopener noreferrer">
        Diagnostiktool herunterladen
      </a>
    </p>

    <p>Bitte bewahren Sie Ihre Fall-ID gut auf.</p>

    <p>Die Bearbeitung erfolgt lokal auf Ihrem Gerät. Nach Abschluss laden Sie die erzeugte Ergebnisdatei wie beschrieben hoch.</p>

    <p>Bei Fragen erreichen Sie uns unter:<br>info@psynovia.de</p>

    <p>Freundliche Grüße<br>Psynovia</p>
  `;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to,
      subject,
      text,
      html
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error("Resend failed", data);
    return { ok: false, error: data };
  }

  return { ok: true, data };
}

exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  try {
    const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!STRIPE_WEBHOOK_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing required environment variables" })
      };
    }

    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : (event.body || "");

    const stripeSignature =
      event.headers["stripe-signature"] ||
      event.headers["Stripe-Signature"];

    verifyStripeSignature(rawBody, stripeSignature, STRIPE_WEBHOOK_SECRET);

    const stripeEvent = JSON.parse(rawBody);

    if (stripeEvent.type !== "checkout.session.completed") {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ received: true, ignored: true, type: stripeEvent.type })
      };
    }

    const session = stripeEvent.data && stripeEvent.data.object;
    const caseId = session && session.client_reference_id;

    if (!caseId) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing client_reference_id" })
      };
    }

    const downloadToken = crypto.randomBytes(32).toString("hex");
    const downloadExpiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

    const updatePayload = {
      payment_status: "paid",
      status: "paid",
      stripe_session_id: session.id || null,
      report_available: false,
      download_token: downloadToken,
      download_count: 0,
      first_downloaded_at: null,
      last_downloaded_at: null,
      download_expires_at: downloadExpiresAt,
      download_locked: false,
      max_downloads: 3
    };

    const updateUrl = `${SUPABASE_URL}/rest/v1/cases?case_id=eq.${encodeURIComponent(caseId)}`;

    const response = await fetch(updateUrl, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Prefer": "return=representation"
      },
      body: JSON.stringify(updatePayload)
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Supabase update failed",
          case_id: caseId,
          details: data
        })
      };
    }

    if (!Array.isArray(data) || data.length === 0) {
      return {
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "No matching case found",
          case_id: caseId
        })
      };
    }

    const caseRow = data[0];
    const recipientEmail = caseRow.email;

    const accessLink = `https://www.psynovia.de/.netlify/functions/get-shell-link?token=${encodeURIComponent(downloadToken)}`;

    const mailResult = await sendAccessMail({
      to: recipientEmail,
      caseId,
      accessLink
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        case_id: caseId,
        updated: data.length,
        mail_sent: mailResult.ok
      })
    };
  } catch (error) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Webhook failed",
        details: error.message
      })
    };
  }
};
