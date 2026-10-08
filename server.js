require("dotenv").config({ path: require("path").join(__dirname, ".env.local") });
const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const { ethers } = require("ethers");
const { MAX_PDF_BYTES, sha256Buffer, assertPdf } = require("./lib/documentIntegrity");

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const deploymentPath = path.join(ROOT, "deployments", "local.json");
const artifactPath = path.join(ROOT, "artifacts", "contracts", "EvidenceRegistry.sol", "EvidenceRegistry.json");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_BYTES },
  fileFilter: (_req, file, callback) => {
    const isPdf = file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf");
    callback(isPdf ? null : new Error("Only PDF files are allowed."), isPdf);
  }
});

function contractClient() {
  if (!fs.existsSync(deploymentPath) || !fs.existsSync(artifactPath)) {
    throw new Error("Contract is not ready. Start the local blockchain, then run npm run deploy:local.");
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
  // Hardhat's first deterministic local account; never use this approach on a real network.
  const signer = new ethers.Wallet(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    provider
  );
  return { contract: new ethers.Contract(deployment.contractAddress, artifact.abi, signer), deployment };
}

function fileResult(file) {
  if (!file) throw new Error("Choose a PDF first.");
  assertPdf(file.buffer);
  const hash = sha256Buffer(file.buffer);
  return { name: file.originalname, hash, bytes: file.size, hashBytes32: `0x${hash}` };
}

app.use(express.static(path.join(ROOT, "public")));

// Both values are publishable Supabase client settings. Pinata, service-role,
// RPC signing credentials, and other secrets are never returned here.
app.get("/api/config", (_req, res) => {
  const url = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) return res.status(503).json({ message: "Supabase public configuration is missing." });
  const contractAddress = process.env.BLOCKCHAIN_CONTRACT_ADDRESS;
  res.json({
    supabaseUrl: url,
    supabasePublishableKey: publishableKey,
    blockchain: contractAddress ? {
      contractAddress,
      network: process.env.BLOCKCHAIN_NETWORK || "polygon-amoy",
      chainId: process.env.BLOCKCHAIN_CHAIN_ID || "80002"
    } : null
  });
});

app.get("/api/status", async (_req, res) => {
  try {
    const { contract, deployment } = contractClient();
    const network = await contract.runner.provider.getNetwork();
    res.json({ ready: true, contractAddress: deployment.contractAddress, chainId: network.chainId.toString() });
  } catch (error) {
    res.json({ ready: false, message: error.message });
  }
});

app.post("/api/hash", upload.single("pdf"), (req, res, next) => {
  try { res.json(fileResult(req.file)); } catch (error) { next(error); }
});

app.post("/api/register", upload.single("pdf"), async (req, res, next) => {
  try {
    const result = fileResult(req.file);
    const { contract, deployment } = contractClient();
    const existing = await contract.getEvidence(result.hashBytes32);
    if (existing.exists) {
      return res.status(409).json({ ...result, registered: true, message: "This exact PDF fingerprint is already registered." });
    }
    const tx = await contract.registerEvidence(result.hashBytes32);
    const receipt = await tx.wait();
    res.json({ ...result, registered: true, transactionHash: receipt.hash, blockNumber: receipt.blockNumber, contractAddress: deployment.contractAddress });
  } catch (error) { next(error); }
});

app.post("/api/verify", upload.single("pdf"), async (req, res, next) => {
  try {
    const result = fileResult(req.file);
    const { contract } = contractClient();
    const evidence = await contract.getEvidence(result.hashBytes32);
    res.json({
      ...result,
      verified: evidence.exists,
      registeredBy: evidence.registeredBy,
      registeredAt: evidence.exists ? new Date(Number(evidence.registeredAt) * 1000).toLocaleString() : null
    });
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => res.status(400).json({ message: error.message || "Request failed." }));
app.listen(PORT, () => console.log(`DeepProof interface: http://localhost:${PORT}`));
