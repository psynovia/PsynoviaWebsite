exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: "Method not allowed" })
    };
  }

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: "Missing Supabase environment variables" })
      };
    }

    const payload = JSON.parse(event.body || "{}");
    const caseId = String(payload.case_id || "").trim();
    const downloadToken = String(payload.download_token || "").trim();

    if (!caseId || caseId.startsWith("__PSYNOVIA_")) {
      return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: false, error: "Missing or invalid case_id" }) };
    }

    if (!downloadToken || downloadToken.startsWith("__PSYNOVIA_")) {
      return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: false, error: "Missing or invalid download_token" }) };
    }

    const caseResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/cases?case_id=eq.${encodeURIComponent(caseId)}&select=*&limit=1`,
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
      return { statusCode: caseResponse.status, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: false, error: "Case lookup failed", details: cases }) };
    }

    if (!Array.isArray(cases) || cases.length === 0) {
      return { statusCode: 404, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: false, error: "Case not found" }) };
    }

    const row = cases[0];

    if (row.payment_status !== "paid") {
      return { statusCode: 403, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: false, error: "Case is not paid" }) };
    }

    const expectedToken = row.shell_download_token || row.download_token || row.access_token || null;

    if (!expectedToken) {
      return {
        statusCode: 409,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: "No token stored for this case yet" })
      };
    }

    if (String(expectedToken) !== downloadToken) {
      return { statusCode: 403, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: false, error: "Invalid token" }) };
    }

    const now = new Date();
    const safeTimestamp = now.toISOString().replace(/[:.]/g, "-");
    const safeCaseId = caseId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const objectPath = `${safeCaseId}/${safeTimestamp}_support_snapshot.json`;

    const snapshot = {
      ...payload,
      server_received_iso: now.toISOString(),
      storage_path: objectPath
    };

    const uploadResponse = await fetch(
      `${SUPABASE_URL}/storage/v1/object/support/${encodeURIComponent(objectPath).replace(/%2F/g, "/")}`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Content-Type": "application/json",
          "x-upsert": "false"
        },
        body: JSON.stringify(snapshot, null, 2)
      }
    );

    const uploadText = await uploadResponse.text();

    if (!uploadResponse.ok) {
      return {
        statusCode: uploadResponse.status,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: "Storage upload failed", details: uploadText })
      };
    }

    try {
      await fetch(
        `${SUPABASE_URL}/rest/v1/cases?case_id=eq.${encodeURIComponent(caseId)}`,
        {
          method: "PATCH",
          headers: {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ last_support_snapshot_at: now.toISOString() })
        }
      );
    } catch (_) {}

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, case_id: caseId, bucket: "support", path: objectPath })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: "Function failed", details: error.message })
    };
  }
};
