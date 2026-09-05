import { createHash } from "node:crypto";

export default async (req) => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), { status: 405, headers: { "Content-Type": "application/json" } });
  }

  const supabaseUrl = String(Netlify.env.get("SUPABASE_URL") || "").trim();
  const key = String(Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
  if (!supabaseUrl || !key) {
    return new Response(JSON.stringify({ ok: false, error: "missing_config" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  const objectPath = "305bd920-0135-4b9c-b7a0-b49027507d7b.enc";
  const expectedHash = "21e0df3c3d954fdebf5e80869e547a465b2fe76bf5dc361ebfae9fe9235374f4";
  const expectedSize = 139863;

  const response = await fetch(`${supabaseUrl}/storage/v1/object/authenticated/clinic-documents-encrypted/${objectPath}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`
    }
  });

  if (!response.ok) {
    return new Response(JSON.stringify({ ok: false, error: `storage_fetch_${response.status}` }), { status: 502, headers: { "Content-Type": "application/json" } });
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const hash = createHash("sha256").update(bytes).digest("hex");
  const magic = new TextDecoder().decode(bytes.slice(0, 8));
  const wrappedKeyLength = bytes.length >= 10 ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(8, false) : null;
  const ivLengthAvailable = bytes.length >= 22;

  return new Response(JSON.stringify({
    ok: true,
    size: bytes.byteLength,
    size_matches: bytes.byteLength === expectedSize,
    sha256_matches: hash === expectedHash,
    magic,
    magic_matches: magic === "PSYDOC01",
    wrapped_key_length: wrappedKeyLength,
    iv_present: ivLengthAvailable,
    content_type: response.headers.get("content-type") || null
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
};
