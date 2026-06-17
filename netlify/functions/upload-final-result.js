exports.handler = async function(event) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  };

  function json(statusCode, body) {
    return {
      statusCode,
      headers: corsHeaders,
      body: JSON.stringify(body)
    };
  }

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const RESULT_BUCKET = "results";

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json(500, { ok: false, error: "Missing Supabase environment variables" });
    }

    const payload = JSON.parse(event.body || "{}");
    const caseId = String(payload.case_id || "").trim();
    const downloadToken = String(payload.download_token || "").trim();
    const resultContent = payload.result_content;
    const filename = String(payload.filename || "result.psynovia").trim();

    if (!caseId || caseId.startsWith("__PSYNOVIA_")) {
      return json(400, { ok: false, error: "Missing or invalid case_id" });
    }

    if (!downloadToken || downloadToken.startsWith("__PSYNOVIA_")) {
      return json(400, { ok: false, error: "Missing or invalid download_token" });
    }

    if (!resultContent || typeof resultContent !== "string") {
      return json(400, { ok: false, error: "Missing result_content" });
    }

    let parsed;
    try {
      parsed = JSON.parse(resultContent);
    } catch (_) {
      return json(400, { ok: false, error: "Result file is not valid JSON" });
    }

    if (
      parsed.v !== 1 ||
      parsed.alg !== "AES-256-GCM" ||
      parsed.kdf !== "MASTERKEY" ||
      !parsed.iv_b64 ||
      !parsed.ct_b64
    ) {
      return json(400, { ok: false, error: "Invalid .psynovia result format" });
    }

    const caseResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/cases?case_id=eq.${encodeURIComponent(caseId)}&select=*&limit=1`,
      {
        method: "GET",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
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
      return json(404, { ok: false, error: "Case not found" });
    }

    const row = cases[0];

    if (row.payment_status !== "paid") {
      return json(403, { ok: false, error: "Case is not paid" });
    }

    const expectedToken =
      row.download_token ||
      row.shell_download_token ||
      row.access_token ||
      null;

    if (!expectedToken) {
      return json(409, { ok: false, error: "No token stored for this case yet" });
    }

    if (String(expectedToken) !== downloadToken) {
      return json(403, { ok: false, error: "Invalid token" });
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const safeCaseId = caseId.replace(/[^a-zA-Z0-9_-]/g, "_");

    const safeFilename = filename.endsWith(".psynovia")
      ? filename.replace(/[^a-zA-Z0-9_.-]/g, "_")
      : "result.psynovia";

    const objectPath = `${safeCaseId}/${safeFilename}`;

    const uploadResponse = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${RESULT_BUCKET}/${encodeURIComponent(objectPath).replace(/%2F/g, "/")}`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/octet-stream",
          "x-upsert": "true"
        },
        body: resultContent
      }
    );

    const uploadText = await uploadResponse.text();

    if (!uploadResponse.ok) {
      return json(uploadResponse.status, {
        ok: false,
        error: "Result upload failed",
        details: uploadText
      });
    }

    try {
      await fetch(
        `${SUPABASE_URL}/rest/v1/cases?id=eq.${encodeURIComponent(row.id)}`,
        {
          method: "PATCH",
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            assessment_completed: true,
            result_uploaded_at: nowIso,
            status: "assessment_uploaded",
            assessment_json: {
              uploaded: true,
              uploaded_at: nowIso,
              bucket: RESULT_BUCKET,
              path: objectPath,
              filename: safeFilename,
              format: "psynovia_encrypted_v1"
            }
          })
        }
      );
    } catch (_) {}

    return json(200, {
      ok: true,
      case_id: caseId,
      bucket: RESULT_BUCKET,
      path: objectPath
    });
  } catch (error) {
    return json(500, {
      ok: false,
      error: "Function failed",
      details: error.message
    });
  }
};
