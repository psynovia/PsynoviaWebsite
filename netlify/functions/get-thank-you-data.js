exports.handler = async function(event) {
  try {
    const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!STRIPE_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing environment variables" })
      };
    }

    const sessionId = event.queryStringParameters?.session_id;

    if (!sessionId) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing session_id" })
      };
    }

    const stripeResponse = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      {
        headers: {
          Authorization: `Bearer ${STRIPE_SECRET_KEY}`
        }
      }
    );

    const stripeSession = await stripeResponse.json();

    if (!stripeResponse.ok) {
      return {
        statusCode: stripeResponse.status,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Stripe lookup failed", details: stripeSession })
      };
    }

    const caseId = stripeSession.client_reference_id;

    if (!caseId) {
      return {
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing client_reference_id" })
      };
    }

    const supabaseResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/cases?case_id=eq.${encodeURIComponent(caseId)}&select=email`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const rows = await supabaseResponse.json();

    if (!supabaseResponse.ok || !Array.isArray(rows) || rows.length === 0) {
      return {
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Case not found" })
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        email: rows[0].email || null
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
