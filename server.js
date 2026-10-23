require("dotenv").config({ path: require("path").join(__dirname, ".env.local") });
const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const { ethers } = require("ethers");
const pdfParse = require("pdf-parse");
const { MAX_PDF_BYTES, sha256Buffer, assertPdf } = require("./lib/documentIntegrity");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

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

function screenExtractedText(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  const indicators = [];
  const patterns = [
    { label: "AI assistant self-reference", re: /\b(as an ai language model|as an ai assistant|i am an ai|i’m an ai|i cannot browse the internet|my training data)\b/gi, weight: 3 },
    { label: "Common generated-response phrasing", re: /\b(here is a (comprehensive|detailed|concise) (overview|summary|analysis)|certainly[,!]|i hope this helps|let me know if you need|in conclusion, it is important to note)\b/gi, weight: 1 },
    { label: "Highly templated section transitions", re: /\b(firstly|secondly|thirdly|moreover|furthermore|in summary|to summarize)\b/gi, weight: 1 },
  ];
  let score = 0;
  for (const pattern of patterns) {
    const matches = [...clean.matchAll(pattern.re)];
    if (matches.length) {
      indicators.push({ name: pattern.label, occurrences: matches.length, detail: `Found ${matches.length} matching phrase(s).` });
      score += Math.min(matches.length, 3) * pattern.weight;
    }
  }
  const words = clean ? clean.split(/\s+/).length : 0;
  const sentences = clean.split(/[.!?]+/).filter((sentence) => sentence.trim());
  const averageSentence = sentences.length ? words / sentences.length : 0;
  if (words >= 120 && averageSentence >= 24) {
    indicators.push({ name: "Long, consistently structured sentences", occurrences: 1, detail: `Average sentence length is approximately ${averageSentence.toFixed(1)} words; this can occur in human writing too.` });
    score += 1;
  }
  if (words < 80) return { outcome: "INCONCLUSIVE", score: null, indicators, words, explanation: "The PDF contains too little extractable text for a useful text-pattern screen. Scanned PDFs may need OCR." };
  const boundedScore = Math.min(95, score * 15);
  const outcome = score >= 4 ? "AI-LIKE INDICATORS FOUND" : score >= 2 ? "POSSIBLE AI-LIKE INDICATORS" : "NO STRONG AI INDICATORS FOUND";
  return { outcome, score: boundedScore, indicators, words, explanation: outcome === "NO STRONG AI INDICATORS FOUND" ? "This limited text-pattern screen found no strong matches. That does not prove human authorship." : "Some patterns overlap with AI-generated writing, but they also occur in human-written text. Treat this as a screening signal, not proof." };
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
      network: process.env.BLOCKCHAIN_NETWORK || "ethereum-sepolia",
      chainId: process.env.BLOCKCHAIN_CHAIN_ID || "11155111"
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

// This screening is separate from blockchain integrity verification. It offers
// metadata and PDF-structure signals; a model verdict is returned only when a
// trusted local detector endpoint is configured through AI_DETECTOR_URL.
app.post("/api/ai-verify", upload.single("pdf"), async (req, res, next) => {
  try {
    if (!req.file) throw new Error("Choose a PDF first.");
    assertPdf(req.file.buffer);
    const bytes = req.file.buffer;
    const raw = bytes.toString("latin1");
    const signals = [];
    const metadata = {};

    for (const key of ["Producer", "Creator", "CreationDate", "ModDate", "Author"]) {
      const match = raw.match(new RegExp(`/${key}\\s*\\(([^)]{1,300})\\)`, "i"));
      if (match) metadata[key] = match[1];
    }

    const authoring = [metadata.Producer, metadata.Creator].filter(Boolean).join(" ").toLowerCase();
    const aiTools = ["midjourney", "stable diffusion", "dall-e", "openai", "firefly", "generative fill", "comfyui", "automatic1111", "imagen"];
    const matchedTools = aiTools.filter((tool) => authoring.includes(tool) || raw.toLowerCase().includes(tool));
    if (matchedTools.length) {
      signals.push({ layer: "metadata", status: "indicator_found", detail: `Possible AI-tool marker(s): ${matchedTools.join(", ")}`, strength: "weak" });
    } else {
      signals.push({ layer: "metadata", status: "no_indicator", detail: "No recognized AI-tool marker was found in readable PDF metadata/content.", strength: "weak" });
    }

    const imageObjects = (raw.match(/\/Subtype\s*\/Image\b/g) || []).length;
    const xobjects = (raw.match(/\/Type\s*\/XObject\b/g) || []).length;
    signals.push({ layer: "pdf_structure", status: "analyzed", detail: `PDF structure contains approximately ${imageObjects} image object(s) and ${xobjects} XObject marker(s). This provides context only; it cannot identify AI generation.`, strength: "context_only" });

    let parsed = null;
    try { parsed = await pdfParse(bytes); } catch (_) { /* encrypted, damaged, or image-only PDFs may not expose text */ }
    const heuristic = screenExtractedText(parsed?.text || "");
    signals.push({ layer: "text_pattern_screen", status: heuristic.score === null ? "inconclusive" : "analyzed", detail: `${heuristic.words.toLocaleString()} extractable words; ${heuristic.outcome}. ${heuristic.explanation}`, strength: "heuristic" });

    let model = { status: "not_configured", verdict: "inconclusive", confidence: null, detail: "No AI-detection model is configured. Metadata and structural signals are not a substitute for a trained detector." };
    const detectorUrl = process.env.AI_DETECTOR_URL;
    if (detectorUrl) {
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: "application/pdf" }), req.file.originalname || "evidence.pdf");
      const response = await fetch(detectorUrl, { method: "POST", body: form, signal: AbortSignal.timeout(60000) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`Configured AI detector returned HTTP ${response.status}`);
      const confidence = Number(body.confidence);
      const allowedVerdicts = ["ai_generated", "likely_original", "inconclusive"];
      model = {
        status: "model_result",
        verdict: allowedVerdicts.includes(body.verdict) ? body.verdict : "inconclusive",
        confidence: Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : null,
        detail: typeof body.detail === "string" ? body.detail : "Result returned by configured AI detector.",
      };
      signals.push({ layer: "ai_model", status: model.status, detail: model.detail, strength: "model_output" });
    }

    res.json({
      filename: req.file.originalname,
      sha256: sha256Buffer(bytes),
      fileBytes: bytes.length,
      verdict: model.verdict,
      confidence: model.confidence,
      model,
      metadata,
      signals,
      heuristic: { ...heuristic, pageCount: parsed?.numpages || null },
      limitations: ["AI detectors can produce false positives and false negatives.", "Metadata can be removed or forged.", "A hash proves byte identity against a trusted reference; it does not prove human authorship.", "No AI verdict is made unless a detector model is configured."],
      blockchain: "This screening does not register or change anything on-chain.",
    });
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => res.status(400).json({ message: error.message || "Request failed." }));
app.listen(PORT, () => console.log(`DeepProof interface: http://localhost:${PORT}`));
