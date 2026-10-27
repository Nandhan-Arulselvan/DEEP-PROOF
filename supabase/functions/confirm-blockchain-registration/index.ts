import { addEvent, adminClient, authenticatedUser, corsHeaders, json } from "../_shared/core.ts";

type RpcResult<T> = { result?: T; error?: { message?: string } };

async function rpc<T>(rpcUrl: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`Sepolia RPC returned HTTP ${response.status}.`);
  const body = await response.json() as RpcResult<T>;
  if (body.error) throw new Error(body.error.message || "Sepolia RPC request failed.");
  if (body.result === undefined) throw new Error("Sepolia RPC returned no result.");
  return body.result;
}

function rpcQuantity(value: string): bigint {
  if (!/^0x[0-9a-f]+$/i.test(value)) throw new Error("Sepolia RPC returned an invalid quantity.");
  return BigInt(value);
}

function parseEvidence(result: string) {
  const value = result.replace(/^0x/i, "");
  if (!/^[0-9a-f]{192,}$/i.test(value)) throw new Error("The EvidenceRegistry returned an invalid response.");
  return {
    registeredBy: `0x${value.slice(24, 64)}`,
    registeredAt: BigInt(`0x${value.slice(64, 128)}`),
    exists: BigInt(`0x${value.slice(128, 192)}`) !== 0n,
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "POST") return json(request, { error: "Method not allowed." }, 405);
  let documentId = "";
  let userId = "";
  try {
    const user = await authenticatedUser(request); userId = user.id;
    const body = await request.json(); documentId = String(body.documentId ?? "");
    const txHash = String(body.transactionHash ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(documentId) || !/^0x[0-9a-f]{64}$/i.test(txHash)) return json(request, { error: "A document ID and transaction hash are required." }, 400);
    const rpcUrl = Deno.env.get("SEPOLIA_RPC_URL");
    const contractAddress = Deno.env.get("BLOCKCHAIN_CONTRACT_ADDRESS");
    const networkName = Deno.env.get("BLOCKCHAIN_NETWORK") ?? "ethereum-sepolia";
    if (!rpcUrl || !contractAddress) return json(request, { error: "Blockchain confirmation is not configured." }, 503);
    const db = adminClient();
    const { data: document, error: documentError } = await db.from("documents").select("*").eq("id", documentId).eq("owner_id", user.id).maybeSingle();
    if (documentError) throw documentError;
    if (!document) return json(request, { error: "Document not found." }, 404);
    if (!/^0x[0-9a-f]{40}$/i.test(contractAddress)) return json(request, { error: "The configured contract address is invalid." }, 503);
    const [receipt, chainId] = await Promise.all([
      rpc<Record<string, string> | null>(rpcUrl, "eth_getTransactionReceipt", [txHash]),
      rpc<string>(rpcUrl, "eth_chainId"),
    ]);
    if (!receipt) return json(request, { error: "The transaction is still pending or unavailable to the configured RPC provider." }, 202);
    if (receipt.status !== "0x1" || !receipt.to || receipt.to.toLowerCase() !== contractAddress.toLowerCase()) throw new Error("The transaction was not a successful call to the configured EvidenceRegistry contract.");
    const expectedChainId = Deno.env.get("BLOCKCHAIN_CHAIN_ID");
    if (expectedChainId && rpcQuantity(chainId).toString() !== expectedChainId) throw new Error("The transaction was found on an unexpected blockchain network.");
    const evidenceResult = await rpc<string>(rpcUrl, "eth_call", [{ to: contractAddress, data: `0x4a7221a0${document.sha256_hash}` }, "latest"]);
    const evidence = parseEvidence(evidenceResult);
    if (!evidence.exists) throw new Error("The contract has no registered evidence for this document hash.");
    const registeredAt = new Date(Number(evidence.registeredAt) * 1000).toISOString();
    const blockNumber = Number(rpcQuantity(receipt.blockNumber));
    const { data: updated, error: updateError } = await db.from("documents").update({
      blockchain_status: "registered", blockchain_network: networkName, contract_address: contractAddress,
      transaction_hash: txHash, block_number: blockNumber, on_chain_registered_at: registeredAt,
    }).eq("id", document.id).eq("owner_id", user.id).select().single();
    if (updateError) throw updateError;
    await addEvent(document.id, user.id, "blockchain_registration", "succeeded", { transactionHash: txHash, blockNumber, network: networkName });
    return json(request, { document: updated, onChain: { registeredBy: evidence.registeredBy, registeredAt, blockNumber } });
  } catch (error) {
    console.error(error);
    if (documentId && userId) {
      const db = adminClient();
      await db.from("documents").update({ blockchain_status: "failed" }).eq("id", documentId).eq("owner_id", userId);
      await addEvent(documentId, userId, "blockchain_registration", "failed", { reason: error instanceof Error ? error.message : "Unknown error" });
    }
    return json(request, { error: error instanceof Error ? error.message : "Blockchain confirmation failed." }, 400);
  }
});
