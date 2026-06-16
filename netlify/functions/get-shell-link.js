       exports.handler = async function(event) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const BUCKET_NAME = "shell";
  const SHELL_FILE_PATH = "PsynoviaADHSDiagnostiktool.html";

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

    const token = event.queryStringParameters && event.queryStringParameters.token;

    if (!token) {
      return json(400, { ok: false, error: "Missing token" });
    }

    const caseResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/cases?download_token=eq.${encodeURIComponent(token)}&select=*&limit=1`,
      {
        method: "GET",
        headers: {
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const cases = await caseResponse.json();

    if (!caseResponse.ok) {
      return json(caseResponse.status, {
        ok: false,
        error: "Case lookup failed",
        details: cases
      });
    }

    if (!Array.isArray(cases) || cases.length === 0) {
      return json(404, { ok: false, error: "Invalid token" });
    }

    const caseRow = cases[0];

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

    const shellResponse = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${BUCKET_NAME}/${SHELL_FILE_PATH}`,
      {
        method: "GET",
        headers: {
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );

    if (!shellResponse.ok) {
      const details = await shellResponse.text();
      return json(shellResponse.status, {
        ok: false,
        error: "Could not load shell file",
        details
      });
    }

    let shellHtml = await shellResponse.text();

    shellHtml = shellHtml
      .replaceAll("__PSYNOVIA_CASE_ID__", caseRow.case_id)
      .replaceAll("__PSYNOVIA_DOWNLOAD_TOKEN__", token);

    const nowIso = new Date().toISOString();

    const updatePayload = {
      download_count: currentCount + 1,
      last_downloaded_at: nowIso
    };

    if (currentCount === 0) {
      updatePayload.first_downloaded_at = nowIso;
    }

    await fetch(
      `${SUPABASE_URL}/rest/v1/cases?id=eq.${encodeURIComponent(caseRow.id)}`,
      {
        method: "PATCH",
        headers: {
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(updatePayload)
      }
    );

    const safeCaseId = String(caseRow.case_id || "Psynovia")
      .replace(/[^a-zA-Z0-9_-]/g, "_");

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="Psynovia_Diagnostiktool_${safeCaseId}.html"`,
        "Cache-Control": "no-store"
      },
      body: shellHtml
    };
  } catch (error) {
    return json(500, {
      ok: false,
      error: "Server error",
      details: error.message
    });
  }
}; 
