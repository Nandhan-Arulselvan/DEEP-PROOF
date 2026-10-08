import { Contract, JsonRpcProvider, getAddress } from "https://esm.sh/ethers@6.13.5";
import { addEvent, adminClient, authenticatedUser, corsHeaders, json } from "../_shared/core.ts";

const registryAbi = ["function getEvidence(bytes32 documentHash) view returns (address registeredBy, uint256 registeredAt, bool exists)"];

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
    const rpcUrl = Deno.env.get("POLYGON_RPC_URL");
    const contractAddress = Deno.env.get("BLOCKCHAIN_CONTRACT_ADDRESS");
    const networkName = Deno.env.get("BLOCKCHAIN_NETWORK") ?? "polygon-amoy";
    if (!rpcUrl || !contractAddress) return json(request, { error: "Blockchain confirmation is not configured." }, 503);
    const db = adminClient();
    const { data: document, error: documentError } = await db.from("documents").select("*").eq("id", documentId).eq("owner_id", user.id).maybeSingle();
    if (documentError) throw documentError;
    if (!document) return json(request, { error: "Document not found." }, 404);
    const provider = new JsonRpcProvider(rpcUrl);
    const [receipt, network] = await Promise.all([provider.getTransactionReceipt(txHash), provider.getNetwork()]);
    if (!receipt) return json(request, { error: "The transaction is still pending or unavailable to the configured RPC provider." }, 202);
    if (receipt.status !== 1 || !receipt.to || getAddress(receipt.to) !== getAddress(contractAddress)) throw new Error("The transaction was not a successful call to the configured EvidenceRegistry contract.");
    const expectedChainId = Deno.env.get("BLOCKCHAIN_CHAIN_ID");
    if (expectedChainId && network.chainId.toString() !== expectedChainId) throw new Error("The transaction was found on an unexpected blockchain network.");
    const registry = new Contract(contractAddress, registryAbi, provider);
    const evidence = await registry.getEvidence(`0x${document.sha256_hash}`);
    if (!evidence.exists) throw new Error("The contract has no registered evidence for this document hash.");
    const registeredAt = new Date(Number(evidence.registeredAt) * 1000).toISOString();
    const { data: updated, error: updateError } = await db.from("documents").update({
      blockchain_status: "registered", blockchain_network: networkName, contract_address: contractAddress,
      transaction_hash: txHash, block_number: Number(receipt.blockNumber), on_chain_registered_at: registeredAt,
    }).eq("id", document.id).eq("owner_id", user.id).select().single();
    if (updateError) throw updateError;
    await addEvent(document.id, user.id, "blockchain_registration", "succeeded", { transactionHash: txHash, blockNumber: Number(receipt.blockNumber), network: networkName });
    return json(request, { document: updated, onChain: { registeredBy: evidence.registeredBy, registeredAt, blockNumber: Number(receipt.blockNumber) } });
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
