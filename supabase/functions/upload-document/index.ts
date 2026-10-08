import { addEvent, adminClient, authenticatedUser, corsHeaders, json, readPdf, safeFilename, sha256 } from "../_shared/core.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "POST") return json(request, { error: "Method not allowed." }, 405);
  try {
    const user = await authenticatedUser(request);
    const filename = safeFilename(request.headers.get("x-file-name"));
    const bytes = await readPdf(request);
    const hash = await sha256(bytes);
    const db = adminClient();
    const { data: existing, error: existingError } = await db.from("documents")
      .select("*").eq("owner_id", user.id).eq("sha256_hash", hash).maybeSingle();
    if (existingError) throw existingError;
    if (existing) return json(request, { document: existing, duplicate: true, message: "This exact PDF is already recorded." });

    const jwt = Deno.env.get("PINATA_JWT");
    if (!jwt) return json(request, { error: "IPFS upload is not configured on this server." }, 503);
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "application/pdf" }), filename);
    form.append("pinataMetadata", JSON.stringify({ name: filename, keyvalues: { ownerId: user.id, sha256: hash } }));
    const pinataResponse = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST", headers: { Authorization: `Bearer ${jwt}` }, body: form,
    });
    const pinataBody = await pinataResponse.json().catch(() => ({}));
    const cid = typeof pinataBody.IpfsHash === "string" ? pinataBody.IpfsHash : null;
    if (!pinataResponse.ok || !cid) throw new Error(pinataBody.error?.reason ?? "Pinata did not return a usable CID.");

    const payload = {
      owner_id: user.id, original_filename: filename, mime_type: "application/pdf", file_size_bytes: bytes.byteLength,
      sha256_hash: hash, ipfs_cid: cid, storage_provider: "pinata", upload_status: "complete",
    };
    const { data: document, error: insertError } = await db.from("documents").insert(payload).select().single();
    if (insertError) {
      console.error("Pinata succeeded but document persistence failed", insertError.message);
      return json(request, {
        error: "The PDF was uploaded to IPFS, but its metadata could not be saved.",
        recovery: { cid, sha256Hash: hash, filename, fileSizeBytes: bytes.byteLength },
      }, 502);
    }
    await addEvent(document.id, user.id, "ipfs_upload", "succeeded", { cid, bytes: bytes.byteLength });
    await addEvent(document.id, user.id, "metadata_persistence", "succeeded", {});
    return json(request, { document, duplicate: false }, 201);
  } catch (error) {
    console.error(error);
    return json(request, { error: error instanceof Error ? error.message : "Upload failed." }, 400);
  }
});
