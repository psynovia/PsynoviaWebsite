async function getGraphToken() {
  const tenantId = String(process.env.MS_GRAPH_TENANT_ID || "").trim();
  const clientId = String(process.env.MS_GRAPH_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.MS_GRAPH_CLIENT_SECRET || "").trim();

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("graph_configuration_missing");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    scope: "https://graph.microsoft.com/.default",
    client_secret: clientSecret,
    grant_type: "client_credentials"
  });

  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    }
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(`graph_token_failed_${response.status}`);
  }

  return data.access_token;
}

async function sendGraphMail({ to, subject, html }) {
  const sender = String(process.env.MS_GRAPH_SENDER || "").trim();
  if (!sender) throw new Error("graph_sender_missing");
  if (!to) throw new Error("recipient_missing");

  const token = await getGraphToken();
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: {
          subject,
          body: {
            contentType: "HTML",
            content: html
          },
          toRecipients: [
            { emailAddress: { address: to } }
          ],
          replyTo: [
            { emailAddress: { address: sender } }
          ],
          internetMessageHeaders: [
            { name: "X-Psynovia-Protect", value: "clinic-access" }
          ]
        },
        saveToSentItems: true
      })
    }
  );

  if (response.status !== 202) {
    throw new Error(`graph_send_failed_${response.status}`);
  }

  return { accepted: true };
}

module.exports = { sendGraphMail };
