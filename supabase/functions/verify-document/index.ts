import { addEvent, adminClient, authenticatedUser, corsHeaders, json, readPdf, safeFilename, sha256 } from "../_shared/core.ts";
import { Contract, JsonRpcProvider } from "https://esm.sh/ethers@6.13.5";

const registryAbi = ["function getEvidence(bytes32 documentHash) view returns (address registeredBy, uint256 registeredAt, bool exists)"];

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "POST") return json(request, { error: "Method not allowed." }, 405);
  try {
    const user = await authenticatedUser(request);
    const documentId = new URL(request.url).searchParams.get("documentId");
    if (!documentId) return json(request, { error: "Select a trusted document reference." }, 400);
    const db = adminClient();
    const { data: document, error: documentError } = await db.from("documents").select("*")
      .eq("id", documentId).eq("owner_id", user.id).maybeSingle();
    if (documentError) throw documentError;
    if (!document) return json(request, { error: "Trusted document reference was not found." }, 404);
    const bytes = await readPdf(request);
    const computed = await sha256(bytes);
    let result = computed === document.sha256_hash ? "match" : "mismatch";
    let verificationSource = "supabase_reference";
    let chainDiagnostic: Record<string, unknown> = {};
    // A document marked registered is additionally checked against the live contract
    // when server-side RPC configuration is available. We never infer chain success
    // merely from the database field.
    if (document.blockchain_status === "registered" && document.contract_address && Deno.env.get("POLYGON_RPC_URL")) {
      try {
        const registry = new Contract(document.contract_address, registryAbi, new JsonRpcProvider(Deno.env.get("POLYGON_RPC_URL")));
        const evidence = await registry.getEvidence(`0x${document.sha256_hash}`);
        verificationSource = "blockchain_reference";
        chainDiagnostic = { blockchain_checked: true, on_chain_exists: evidence.exists };
        if (!evidence.exists) result = "inconclusive";
      } catch (chainError) {
        verificationSource = "blockchain_reference";
        result = "inconclusive";
        chainDiagnostic = { blockchain_checked: false, reason: chainError instanceof Error ? chainError.message : "RPC verification failed" };
      }
    }
    const filename = safeFilename(request.headers.get("x-file-name"));
    const { error: logError } = await db.from("verification_logs").insert({
      document_id: document.id, user_id: user.id, submitted_filename: filename,
      expected_sha256_hash: document.sha256_hash, computed_sha256_hash: computed, result,
      verification_source: verificationSource, diagnostics: { submitted_bytes: bytes.byteLength, ...chainDiagnostic },
    });
    if (logError) throw logError;
    await addEvent(document.id, user.id, "verification", "succeeded", { result, submittedFilename: filename });
    return json(request, {
      result, verificationSource, expectedHash: document.sha256_hash, computedHash: computed,
      document: { id: document.id, filename: document.original_filename, createdAt: document.created_at, ipfsCid: document.ipfs_cid },
      blockchain: { status: document.blockchain_status, network: document.blockchain_network, transactionHash: document.transaction_hash, blockNumber: document.block_number, contractAddress: document.contract_address },
    });
  } catch (error) {
    console.error(error);
    return json(request, { error: error instanceof Error ? error.message : "Verification failed." }, 400);
  }
});
