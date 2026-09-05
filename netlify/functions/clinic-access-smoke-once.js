const crypto = require("crypto");
const { handler: activateClinicAccess } = require("./activate-clinic-access");

const CASE_ID = "CHIEM-2026-BBNQSJ9S";

async function supabasePatch({ base, key, path, body }) {
  const response = await fetch(`${base}${path}`, {
    method: "PATCH",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`supabase_patch_failed_${response.status}`);
}

exports.handler = async function(event) {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const sender = String(process.env.MS_GRAPH_SENDER || "").trim();

  if (!supabaseUrl || !serviceRoleKey || !sender) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: "missing_configuration" }) };
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token, "utf8").digest("hex");

  await supabasePatch({
    base: supabaseUrl,
    key: serviceRoleKey,
    path: `/rest/v1/clinic_intake_submissions?case_id=eq.${encodeURIComponent(CASE_ID)}`,
    body: {
      access_activation_token_hash: tokenHash,
      access_activation_consumed_at: null
    }
  });

  process.env.CLINIC_ACCESS_TEST_ENABLED = "true";
  process.env.CLINIC_ACCESS_TEST_RECIPIENT = sender;
  process.env.CLINIC_AUTO_ACCESS_ENABLED = "false";

  const result = await activateClinicAccess({
    httpMethod: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      case_id: CASE_ID,
      activation_token: token,
      email: sender
    })
  });

  return {
    statusCode: result.statusCode || 500,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    body: result.body || JSON.stringify({ ok: false, error: "empty_result" })
  };
};
