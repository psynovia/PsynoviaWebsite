const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BUCKET_NAME = "secret";
const SHELL_FILE_PATH = "shell/PsynoviaADHSDiagnostiktool.html";
const SIGNED_URL_SECONDS = 15 * 60;

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return {
        statusCode: 405,
        body: "Method Not Allowed",
      };
    }

    const token = event.queryStringParameters?.token;

    if (!token) {
      return {
        statusCode: 400,
        body: "Missing token",
      };
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: caseRow, error: selectError } = await supabase
      .from("cases")
      .select("id, payment_status, download_token, download_count, download_expires_at, download_locked, max_downloads")
      .eq("download_token", token)
      .single();

    if (selectError || !caseRow) {
      return {
        statusCode: 404,
        body: "Invalid token",
      };
    }

    if (caseRow.payment_status !== "paid") {
      return {
        statusCode: 403,
        body: "Payment required",
      };
    }

    if (caseRow.download_locked === true) {
      return {
        statusCode: 403,
        body: "Download locked",
      };
    }

    if (caseRow.download_expires_at && new Date(caseRow.download_expires_at) < new Date()) {
      return {
        statusCode: 410,
        body: "Token expired",
      };
    }

    const currentCount = caseRow.download_count || 0;
    const maxDownloads = caseRow.max_downloads || 3;

    if (currentCount >= maxDownloads) {
      return {
        statusCode: 403,
        body: "Download limit reached",
      };
    }

    const { data: signedData, error: signedError } = await supabase
      .storage
      .from(BUCKET_NAME)
      .createSignedUrl(SHELL_FILE_PATH, SIGNED_URL_SECONDS);

    if (signedError || !signedData?.signedUrl) {
      return {
        statusCode: 500,
        body: "Could not create signed URL",
      };
    }

    const nowIso = new Date().toISOString();

    await supabase
      .from("cases")
      .update({
        download_count: currentCount + 1,
        last_downloaded_at: nowIso,
        first_downloaded_at: currentCount === 0 ? nowIso : undefined,
      })
      .eq("id", caseRow.id);

    return {
      statusCode: 302,
      headers: {
        Location: signedData.signedUrl,
        "Cache-Control": "no-store",
      },
      body: "",
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: "Server error",
    };
  }
};
