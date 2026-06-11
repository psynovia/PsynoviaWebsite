exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing Supabase environment variables" })
      };
    }

    const payload = JSON.parse(event.body || "{}");

    const now = new Date();
    const year = now.getFullYear();
    const random = Math.random().toString(36).slice(2, 8).toUpperCase();
    const caseId = `PSY-${year}-${random}`;

    const row = {
      case_id: caseId,
      first_name: payload.first_name || null,
      last_name: payload.last_name || null,
      email: payload.email || null,
      payment_status: "pending",
      intake_completed: true,
      assessment_completed: false,
      report_available: false,
      status: "intake_completed",
      intake_json: payload.intake_json || payload
    };

    const response = await fetch(`${SUPABASE_URL}/rest/v1/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Prefer": "return=representation"
      },
      body: JSON.stringify(row)
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Supabase insert failed", details: data })
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        case_id: caseId,
        data
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Function failed",
        details: error.message
      })
    };
  }
};
