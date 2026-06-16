exports.handler = async function(event) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const BUCKET_NAME = "shell";
  const SHELL_FILE_PATH = "PsynoviaADHSDiagnostiktool.html";
  const SIGNED_URL_SECONDS = 15 * 60;

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

    const caseResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/cases?download_token=eq.${encodeURIComponent(token)}&select=*&limit=1`,
      {
        method: "GET",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );

    const cases = await caseResponse.json();

    if (!caseResponse.ok || !Array.isArray(cases) || cases.length === 0) {
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
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );

    if (!shellResponse.ok) {
      return json(shellResponse.status, {
        ok: false,
        error: "Could not load shell file",
        details: await shellResponse.text()
      });
    }

    let shellHtml = await shellResponse.text();

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

    const uploadResponse = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${BUCKET_NAME}/${encodeURIComponent(personalizedPath).replace(/%2F/g, "/")}`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "text/html; charset=utf-8",
          "x-upsert": "true"
        },
        body: shellHtml
      }
    );

    const uploadText = await uploadResponse.text();

    if (!uploadResponse.ok) {
      return json(uploadResponse.status, {
        ok: false,
        error: "Could not store personalized shell",
        details: uploadText
      });
    }

    const signedResponse = await fetch(
      `${SUPABASE_URL}/storage/v1/object/sign/${BUCKET_NAME}/${encodeURIComponent(personalizedPath).replace(/%2F/g, "/")}`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          expiresIn: SIGNED_URL_SECONDS,
          download: `Psynovia_Diagnostiktool_${safeCaseId}.html`
        })
      }
    );

    const signedData = await signedResponse.json();

    const signedUrl = signedData?.signedURL || signedData?.signedUrl;

    if (!signedResponse.ok || !signedUrl) {
      return json(signedResponse.status || 500, {
        ok: false,
        error: "Could not create signed URL for personalized shell",
        details: signedData
      });
    }

    const fullSignedUrl = signedUrl.startsWith("http")
      ? signedUrl
      : `${SUPABASE_URL}${signedUrl}`;

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
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(updatePayload)
      }
    );

    return {
      statusCode: 302,
      headers: {
        Location: fullSignedUrl,
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
