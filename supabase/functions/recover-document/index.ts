import { addEvent, adminClient, authenticatedUser, corsHeaders, json } from "../_shared/core.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "POST") return json(request, { error: "Method not allowed." }, 405);
  try {
    const user = await authenticatedUser(request);
    const recovery = await request.json();
    const cid = typeof recovery.cid === "string" ? recovery.cid : "";
    if (!cid || !/^[a-zA-Z0-9]+$/.test(cid)) return json(request, { error: "A valid recovery CID is required." }, 400);
    const jwt = Deno.env.get("PINATA_JWT");
    if (!jwt) return json(request, { error: "IPFS recovery is not configured on this server." }, 503);
    const pinata = await fetch(`https://api.pinata.cloud/data/pinList?hashContains=${encodeURIComponent(cid)}&status=pinned`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const body = await pinata.json().catch(() => ({}));
    const row = Array.isArray(body.rows) ? body.rows.find((item: Record<string, unknown>) => item.ipfs_pin_hash === cid) : null;
    const metadata = row?.metadata as { name?: string; keyvalues?: Record<string, string> } | undefined;
    const hash = metadata?.keyvalues?.sha256;
    if (!pinata.ok || !row || metadata?.keyvalues?.ownerId !== user.id || !hash || !/^[a-f0-9]{64}$/.test(hash)) {
      return json(request, { error: "This CID cannot be recovered for the current account." }, 404);
    }
    const db = adminClient();
    const { data: existing } = await db.from("documents").select("*").eq("owner_id", user.id).eq("sha256_hash", hash).maybeSingle();
    if (existing) return json(request, { document: existing, duplicate: true });
    const fileSize = Number(recovery.fileSizeBytes);
    if (!Number.isSafeInteger(fileSize) || fileSize < 1 || fileSize > 26214400) return json(request, { error: "Recovery needs the original file size from the upload response." }, 400);
    const { data: document, error } = await db.from("documents").insert({
      owner_id: user.id, original_filename: String(recovery.filename ?? metadata?.name ?? "recovered.pdf").slice(0, 512),
      mime_type: "application/pdf", file_size_bytes: fileSize, sha256_hash: hash, ipfs_cid: cid,
      storage_provider: "pinata", upload_status: "complete",
    }).select().single();
    if (error) throw error;
    await addEvent(document.id, user.id, "metadata_recovery", "succeeded", { cid });
    return json(request, { document, duplicate: false }, 201);
  } catch (error) {
    console.error(error);
    return json(request, { error: error instanceof Error ? error.message : "Recovery failed." }, 400);
  }
});
