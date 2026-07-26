// netlify/functions/start-diagnostik.js

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Supabase Storage Bucket
const SHELL_BUCKET = "shell";

// Aktuelle Shell-Vorlage im Bucket "shell"
const SHELL_TEMPLATE_FILE = "PsynoviaADHSDiagnostiktool.html";

exports.handler = async (event) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return htmlError(500, "Server-Konfiguration fehlt.");
    }

    const token = event.queryStringParameters?.token;

    if (!token) {
      return htmlError(400, "Der Zugangslink ist unvollständig.");
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // 1. Fall anhand Token suchen
    const { data: caseRow, error: caseError } = await supabase
      .from("cases")
      .select("*")
      .eq("download_token", token)
      .single();

    if (caseError || !caseRow) {
      return htmlError(404, "Dieser Zugangslink wurde nicht gefunden.");
    }

    // 2. Zugang prüfen
    if (caseRow.download_locked === true) {
      return htmlError(403, "Dieser Zugang ist gesperrt.");
    }

    if (caseRow.download_expires_at) {
      const expiresAt = new Date(caseRow.download_expires_at).getTime();

      if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
        return htmlError(403, "Dieser Zugang ist abgelaufen.");
      }
    }

    const allowedPaymentStatus = [
      "paid",
      "clinic_paid",
      "clinic_access_granted",
      "clinic_pending_manual_access"
    ];

    const allowedStatus = [
      "paid",
      "active",
      "clinic_paid",
      "clinic_access_granted",
      "clinic_pending_manual_access",
      "assessment_pending",
      "download_ready"
    ];

    const paymentOk = allowedPaymentStatus.includes(caseRow.payment_status);
    const statusOk = !caseRow.status || allowedStatus.includes(caseRow.status);

    if (!paymentOk && !statusOk) {
      return htmlError(403, "Dieser Zugang ist aktuell nicht freigeschaltet.");
    }

    // 3. Shell-Vorlage aus Supabase Storage laden
    const { data: shellFile, error: shellError } = await supabase
      .storage
      .from(SHELL_BUCKET)
      .download(SHELL_TEMPLATE_FILE);

    if (shellError || !shellFile) {
      console.error("Shell download error:", shellError);
      return htmlError(500, "Die Diagnostik-Shell konnte nicht geladen werden.");
    }

    let html = await shellFile.text();

    // 4. Fall-ID und Token einsetzen
    html = html
      .replaceAll("__PSYNOVIA_CASE_ID__", String(caseRow.case_id || ""))
      .replaceAll("__PSYNOVIA_DOWNLOAD_TOKEN__", String(token || ""));

    // 5. Optionaler Kontext: Klinik oder Standard
    const context =
      String(caseRow.case_id || "").startsWith("CHIEM-")
        ? "clinic_chiemseewinkel"
        : "standard";

    html = html.replace(
      "</head>",
      `<script>
window.PSYNOVIA_CONTEXT = ${JSON.stringify(context)};
window.PSYNOVIA_ONLINE_MODE = true;
</script>
</head>`
    );

    // 6. Zugriffszähler erhöhen
    await supabase
      .from("cases")
      .update({
        download_count: (caseRow.download_count || 0) + 1,
        last_download_at: new Date().toISOString()
      })
      .eq("id", caseRow.id);

    // 7. Shell direkt im Browser ausliefern
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0",
        "X-Robots-Tag": "noindex, nofollow, noarchive"
      },
      body: html
    };

  } catch (err) {
    console.error("start-diagnostik error:", err);
    return htmlError(500, "Die Diagnostik konnte nicht gestartet werden.");
  }
};

function htmlError(statusCode, message) {
  const safeMessage = String(message || "Es ist ein Fehler aufgetreten.");

  return {
    statusCode,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "X-Robots-Tag": "noindex, nofollow, noarchive"
    },
    body: `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Psynovia – Zugang nicht verfügbar</title>
<style>
body{
  margin:0;
  min-height:100vh;
  display:grid;
  place-items:center;
  font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  background:#f2f9fd;
  color:#07335f;
}
.card{
  width:min(92vw,560px);
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
    <p class="contact">Bitte wenden Sie sich bei Fragen an Psynovia.</p>
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
