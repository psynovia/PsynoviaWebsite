const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BUCKET_NAME = "shell";
const SHELL_FILE_PATH = "PsynoviaADHSDiagnostiktool.html";
const SIGNED_URL_SECONDS = 15 * 60;

exports.handler = async function(event) {
  function json(statusCode, body) {
    return {
      statusCode,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      },
      body: JSON.stringify(body)
    };
  }

  try {
    if (event.httpMethod !== "GET") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json(500, { ok: false, error: "Missing Supabase environment variables" });
    }

    const token = event.queryStringParameters?.token;

    if (!token) {
      return json(400, { ok: false, error: "Missing token" });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: caseRow, error: caseError } = await supabase
      .from("cases")
      .select("*")
      .eq("download_token", token)
      .single();

    if (caseError || !caseRow) {
      return json(404, { ok: false, error: "Invalid token", details: caseError?.message });
    }

    if (caseRow.payment_status !== "paid") {
      return json(403, { ok: false, error: "Payment required" });
    }

    if (caseRow.download_locked === true) {
      return json(403, { ok: false, error: "Download locked" });
    }

    if (caseRow.download_expires_at && new Date(caseRow.download_expires_at) < new Date()) {
      return json(410, { ok: false, error: "Token expired" });
    }

    const currentCount = Number(caseRow.download_count || 0);
    const maxDownloads = Number(caseRow.max_downloads || 3);

    if (currentCount >= maxDownloads) {
      return json(403, { ok: false, error: "Download limit reached" });
    }

    const { data: shellData, error: shellError } = await supabase
      .storage
      .from(BUCKET_NAME)
      .download(SHELL_FILE_PATH);

    if (shellError || !shellData) {
      return json(500, { ok: false, error: "Could not load shell file", details: shellError?.message });
    }

    let shellHtml = await shellData.text();

    shellHtml = shellHtml
      .split("__PSYNOVIA_CASE_ID__").join(caseRow.case_id)
      .split("__PSYNOVIA_DOWNLOAD_TOKEN__").join(token);

    shellHtml = `<!-- Psynovia personalized shell: ${caseRow.case_id} -->\n` + shellHtml;

    const now = new Date();
    const nowIso = now.toISOString();
    const safeCaseId = String(caseRow.case_id || "Psynovia").replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeTimestamp = nowIso.replace(/[:.]/g, "-");

    const personalizedPath =
      `personalized/${safeCaseId}/Psynovia_Diagnostiktool_${safeCaseId}_${safeTimestamp}.html`;

    const blob = new Blob([shellHtml], { type: "text/html;charset=utf-8" });

    const { error: uploadError } = await supabase
      .storage
      .from(BUCKET_NAME)
      .upload(personalizedPath, blob, {
        contentType: "text/html;charset=utf-8",
        upsert: true
      });

    if (uploadError) {
      return json(500, { ok: false, error: "Could not store personalized shell", details: uploadError.message });
    }

    const { data: signedData, error: signedError } = await supabase
      .storage
      .from(BUCKET_NAME)
      .createSignedUrl(personalizedPath, SIGNED_URL_SECONDS, {
        download: `Psynovia_Diagnostiktool_${safeCaseId}.html`
      });

    if (signedError || !signedData?.signedUrl) {
      return json(500, { ok: false, error: "Could not create signed URL", details: signedError?.message });
    }

    const updatePayload = {
      download_count: currentCount + 1,
      last_downloaded_at: nowIso
    };

    if (currentCount === 0) {
      updatePayload.first_downloaded_at = nowIso;
    }

    await supabase
      .from("cases")
      .update(updatePayload)
      .eq("id", caseRow.id);

    return {
      statusCode: 302,
      headers: {
        Location: signedData.signedUrl,
        "Cache-Control": "no-store"
      },
      body: ""
    };
  } catch (error) {
    return json(500, {
      ok: false,
      error: "Server error",
      details: error.message
    });
  }
};
