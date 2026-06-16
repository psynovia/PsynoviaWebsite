exports.handler = async function(event) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const RESULT_BUCKET = "results";

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
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

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

    if (!caseResponse.ok || !Array.isArray(cases) || cases.length === 0) {
      return json(404, { ok: false, error: "Case not found" });
    }

    const row = cases[0];

    if (row.payment_status !== "paid") {
      return json(403, { ok: false, error: "Case is not paid" });
    }

    if (String(row.download_token) !== downloadToken) {
      return json(403, { ok: false, error: "Invalid token" });
    }

    let parsed = null;
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
          assessment_json: {
            uploaded: true,
            uploaded_at: nowIso,
            bucket: RESULT_BUCKET,
            path: objectPath,
            filename: safeFilename,
            format: "psynovia_encrypted_v1"
          },
          status: "assessment_uploaded"
        })
      }
    );

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
