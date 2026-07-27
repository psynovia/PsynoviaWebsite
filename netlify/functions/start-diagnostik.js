// netlify/functions/start-diagnostik.js

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SHELL_BUCKET = "shell";
const SHELL_TEMPLATE_FILE = "PsynoviaADHSDiagnostiktool.html";

// Sicherheitsreserve unterhalb der Netlify-Grenze für gepufferte Antworten.
// Die aktuelle Shell liegt bei ca. 5,4 MB.
const MAX_BUFFERED_HTML_BYTES = 5_900_000;

const ALLOWED_PAYMENT_STATUS = new Set([
  "paid",
  "clinic_paid",
  "clinic_access_granted",
  "clinic_pending_manual_access"
]);

const ALLOWED_CASE_STATUS = new Set([
  "paid",
  "active",
  "clinic_paid",
  "clinic_access_granted",
  "clinic_pending_manual_access",
  "assessment_pending",
  "download_ready",
  "assessment_uploaded",
  "assessment_completed",
  "result_uploaded",
  "completed"
]);

exports.handler = async (event) => {
  try {
    // Die Diagnostik wird ausschließlich per normalem Browseraufruf geöffnet.
    if (event.httpMethod !== "GET") {
      return htmlError(
        405,
        "Diese Adresse kann nur direkt im Browser geöffnet werden.",
        {
          Allow: "GET"
        }
      );
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.error("Missing Supabase environment variables");
      return htmlError(500, "Server-Konfiguration fehlt.");
    }

    const token = String(
      event.queryStringParameters?.token || ""
    ).trim();

    if (!token) {
      return htmlError(400, "Der Zugangslink ist unvollständig.");
    }

    const supabase = createClient(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY
    );

    // 1. Fall anhand des Tokens laden.
    const { data: caseRow, error: caseError } = await supabase
      .from("cases")
      .select("*")
      .eq("download_token", token)
      .single();

    if (caseError || !caseRow) {
      console.warn(
        "Case lookup failed:",
        caseError?.message || "not found"
      );

      return htmlError(
        404,
        "Dieser Zugangslink wurde nicht gefunden."
      );
    }

    const caseId = String(caseRow.case_id || "").trim();

    if (!caseId) {
      console.error("Case has no case_id:", caseRow.id);

      return htmlError(
        409,
        "Der Zugang ist unvollständig eingerichtet."
      );
    }

    // 2. Zugang prüfen.
    if (caseRow.download_locked === true) {
      return htmlError(403, "Dieser Zugang ist gesperrt.");
    }

    if (caseRow.download_expires_at) {
      const expiresAt = new Date(
        caseRow.download_expires_at
      ).getTime();

      if (
        Number.isFinite(expiresAt) &&
        Date.now() > expiresAt
      ) {
        return htmlError(403, "Dieser Zugang ist abgelaufen.");
      }
    }

    const paymentStatus = String(
      caseRow.payment_status || ""
    ).trim();

    const caseStatus = String(
      caseRow.status || ""
    ).trim();

    const paymentOk =
      ALLOWED_PAYMENT_STATUS.has(paymentStatus);

    const statusOk =
      !caseStatus || ALLOWED_CASE_STATUS.has(caseStatus);

    // Beide Ebenen müssen zulässig sein.
    if (!paymentOk || !statusOk) {
      console.warn("Access denied by status", {
        caseId,
        paymentStatus,
        caseStatus
      });

      return htmlError(
        403,
        "Dieser Zugang ist aktuell nicht freigeschaltet."
      );
    }

    // 3. Aktuelle Shell-Vorlage aus Supabase Storage laden.
    const { data: shellFile, error: shellError } =
      await supabase.storage
        .from(SHELL_BUCKET)
        .download(SHELL_TEMPLATE_FILE);

    if (shellError || !shellFile) {
      console.error("Shell download error:", shellError);

      return htmlError(
        500,
        "Die Diagnostik-Shell konnte nicht geladen werden."
      );
    }

    let html = await shellFile.text();

    if (
      !html.includes("__PSYNOVIA_CASE_ID__") ||
      !html.includes("__PSYNOVIA_DOWNLOAD_TOKEN__")
    ) {
      console.error(
        "Shell template is missing required personalization placeholders"
      );

      return htmlError(
        500,
        "Die Diagnostik-Vorlage ist nicht korrekt eingerichtet."
      );
    }

    const hasShellIdPlaceholder =
      html.includes("__PSYNOVIA_SHELL_INSTANCE_ID__");

    const hasShellIdConstant =
      /const\s+SHELL_INSTANCE_ID\s*=\s*["'][^"']*["']\s*;/.test(
        html
      );

    if (!hasShellIdPlaceholder && !hasShellIdConstant) {
      console.error(
        "Shell template has no replaceable SHELL_INSTANCE_ID"
      );

      return htmlError(
        500,
        "Die lokale Speicherung ist nicht korrekt eingerichtet."
      );
    }

    // Stabil pro Fall:
    // Derselbe Fall behält denselben Speicherraum.
    // Unterschiedliche Fälle bleiben getrennt.
    const shellInstanceId =
      createStableShellInstanceId(caseId);

    // 4. Fall-ID, Token und Speicher-ID einsetzen.
    html = html
      .replaceAll("__PSYNOVIA_CASE_ID__", caseId)
      .replaceAll("__PSYNOVIA_DOWNLOAD_TOKEN__", token)
      .replaceAll(
        "__PSYNOVIA_SHELL_INSTANCE_ID__",
        shellInstanceId
      );

    // Rückwärtskompatibilität für ältere Vorlagen
    // mit einer bereits konkreten Speicher-ID.
    html = html.replace(
      /const\s+SHELL_INSTANCE_ID\s*=\s*["'][^"']*["']\s*;/g,
      `const SHELL_INSTANCE_ID = ${JSON.stringify(
        shellInstanceId
      )};`
    );

    if (
      html.includes("__PSYNOVIA_CASE_ID__") ||
      html.includes("__PSYNOVIA_DOWNLOAD_TOKEN__") ||
      html.includes("__PSYNOVIA_SHELL_INSTANCE_ID__")
    ) {
      console.error(
        "Unresolved personalization placeholder remains in shell"
      );

      return htmlError(
        500,
        "Die Diagnostik konnte nicht vollständig vorbereitet werden."
      );
    }

    // 5. Onlinekontext direkt vor </head> einsetzen.
    const context = caseId.startsWith("CHIEM-")
      ? "clinic_chiemseewinkel"
      : "standard";

    const onlineContextScript = `<script>
window.PSYNOVIA_CONTEXT = ${JSON.stringify(context)};
window.PSYNOVIA_ONLINE_MODE = true;
window.PSYNOVIA_SHELL_INSTANCE_ID = ${JSON.stringify(
      shellInstanceId
    )};
</script>`;

    if (!/<\/head>/i.test(html)) {
      console.error("Shell template has no closing head tag");

      return htmlError(
        500,
        "Die Diagnostik-Vorlage ist unvollständig."
      );
    }

    html = html.replace(
      /<\/head>/i,
      `${onlineContextScript}\n</head>`
    );

    const htmlBytes = Buffer.byteLength(html, "utf8");

    if (htmlBytes > MAX_BUFFERED_HTML_BYTES) {
      console.error(
        "Personalized shell exceeds buffered response limit",
        {
          caseId,
          htmlBytes,
          limit: MAX_BUFFERED_HTML_BYTES
        }
      );

      return htmlError(
        500,
        "Die Diagnostik-Datei ist derzeit zu groß für die sichere Onlineauslieferung."
      );
    }

    // 6. Zugriff protokollieren.
    // Ein Fehler hierbei darf den Zugang nicht blockieren.
    const { error: accessUpdateError } = await supabase
      .from("cases")
      .update({
        download_count:
          Number(caseRow.download_count || 0) + 1,
        last_downloaded_at: new Date().toISOString()
      })
      .eq("id", caseRow.id);

    if (accessUpdateError) {
      console.error(
        "Access counter update error:",
        accessUpdateError
      );
    }

    // 7. Shell direkt und nicht cachebar ausliefern.
    return {
      statusCode: 200,
      headers: responseHeaders({
        "Content-Disposition":
          'inline; filename="Psynovia-Diagnostik.html"'
      }),
      body: html
    };
  } catch (err) {
    console.error("start-diagnostik error:", err);

    return htmlError(
      500,
      "Die Diagnostik konnte nicht gestartet werden."
    );
  }
};

function createStableShellInstanceId(value) {
  const digest = crypto
    .createHash("sha256")
    .update(
      `psynovia-shell-instance-v1|${String(value || "")}`,
      "utf8"
    )
    .digest();

  const bytes = Buffer.from(digest.subarray(0, 16));

  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString("hex");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");
}

function responseHeaders(extraHeaders = {}) {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control":
      "no-store, no-cache, must-revalidate, max-age=0",
    "CDN-Cache-Control": "no-store",
    "Netlify-CDN-Cache-Control": "no-store",
    "Pragma": "no-cache",
    "Expires": "0",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Permissions-Policy": "fullscreen=(self)",
    ...extraHeaders
  };
}

function htmlError(
  statusCode,
  message,
  extraHeaders = {}
) {
  const safeMessage = String(
    message || "Es ist ein Fehler aufgetreten."
  );

  return {
    statusCode,
    headers: responseHeaders(extraHeaders),
    body: `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta
  name="viewport"
  content="width=device-width, initial-scale=1"
>
<meta
  name="robots"
  content="noindex,nofollow,noarchive"
>
<title>Psynovia – Zugang nicht verfügbar</title>
<style>
body{
  margin:0;
  min-height:100vh;
  display:grid;
  place-items:center;
  font-family:
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  background:#f2f9fd;
  color:#07335f;
}
.card{
  width:min(92vw,560px);
  box-sizing:border-box;
  background:white;
  border:1px solid rgba(126,179,205,.32);
  border-radius:24px;
  padding:28px;
  box-shadow:0 18px 42px rgba(7,51,95,.095);
}
h1{
  margin:0 0 12px;
  font-size:26px;
  line-height:1.15;
}
p{
  margin:0;
  color:#365c78;
  line-height:1.5;
}
.contact{
  margin-top:16px;
  font-weight:700;
}
</style>
</head>
<body>
  <main class="card">
    <h1>Zugang nicht verfügbar</h1>
    <p>${escapeHtml(safeMessage)}</p>
    <p class="contact">
      Bitte wenden Sie sich bei Fragen an Psynovia.
    </p>
  </main>
</body>
</html>`
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
