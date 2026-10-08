import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { BrowserProvider, Contract } from "https://esm.sh/ethers@6.13.5";

const $ = (id) => document.getElementById(id);
const state = { client: null, config: null, documents: [], logs: [], events: [], signup: false };

function when(value) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—"; }
function short(value) { return value && value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value || "—"; }
function setNetwork(text, muted = false) { const node = $("networkState"); node.textContent = text; node.classList.toggle("muted", muted); }
function message(id, text, kind = "muted") { const node = $(id); node.className = `result ${kind}`; node.textContent = text; }
function addLine(node, label, value, mono = false) { const line = document.createElement("div"); const strong = document.createElement("strong"); strong.textContent = `${label}: `; line.append(strong); const text = document.createElement("span"); text.textContent = value ?? "—"; if (mono) text.className = "mono"; line.append(text); node.append(line); }
function copy(value) { navigator.clipboard?.writeText(value).then(() => setNetwork("Copied", false)).catch(() => window.prompt("Copy this value", value)); }
function makeButton(label, callback) { const button = document.createElement("button"); button.className = "copy-button"; button.type = "button"; button.textContent = label; button.addEventListener("click", callback); return button; }
function setBusy(button, busy, label) { button.disabled = busy; if (busy) { button.dataset.label = button.textContent; button.textContent = label; } else button.textContent = button.dataset.label || button.textContent; }
function getError(error) { return error?.message || error?.context?.error || error?.context?.message || "The request could not be completed."; }
async function getFunctionError(error) {
  const response = error?.context;
  if (response && typeof response.clone === "function") {
    try {
      const body = await response.clone().json();
      if (body?.error || body?.message) return body.error || body.message;
    } catch { /* the gateway did not return JSON */ }
  }
  return getError(error);
}

function renderStats() {
  $("documentCount").textContent = state.documents.length;
  $("matchCount").textContent = state.logs.filter((entry) => entry.result === "match").length;
  $("chainCount").textContent = state.documents.filter((entry) => entry.blockchain_status === "registered").length;
  $("activityCount").textContent = state.events.length;
}

function renderReferenceOptions() {
  const select = $("referenceSelect"); const current = select.value; select.replaceChildren();
  const placeholder = new Option(state.documents.length ? "Select a trusted reference" : "Upload a trusted PDF first", ""); placeholder.disabled = true; placeholder.selected = !current; select.add(placeholder);
  state.documents.forEach((document) => select.add(new Option(`${document.original_filename} · ${short(document.sha256_hash)}`, document.id)));
  if (state.documents.some((document) => document.id === current)) select.value = current;
}

function renderLibrary() {
  const target = $("libraryList"); target.replaceChildren();
  const query = $("librarySearch").value.trim().toLowerCase(); const filter = $("libraryFilter").value;
  const records = state.documents.filter((document) => {
    const haystack = `${document.original_filename} ${document.sha256_hash} ${document.ipfs_cid}`.toLowerCase();
    return (!query || haystack.includes(query)) && (filter === "all" || document.blockchain_status === filter);
  });
  if (!records.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = state.documents.length ? "No records match this filter." : "No authorized documents yet. Upload your first trusted PDF above."; target.append(empty); return; }
  records.forEach((document) => {
    const row = document.createElement("article"); row.className = "document-row";
    const name = document.createElement("div"); const title = document.createElement("div"); title.className = "filename"; title.textContent = document.original_filename; const meta = document.createElement("div"); meta.className = "filemeta"; meta.textContent = `${Number(document.file_size_bytes).toLocaleString()} bytes · ${when(document.created_at)}`; name.append(title, meta);
    const ids = document.createElement("div"); const hash = document.createElement("div"); hash.className = "hash-text"; hash.textContent = document.sha256_hash; const cid = document.createElement("div"); cid.className = "hash-text"; cid.textContent = `CID ${document.ipfs_cid}`; ids.append(hash, cid);
    const actions = document.createElement("div"); actions.className = "row-actions"; const badge = document.createElement("span"); badge.className = `chain-badge ${document.blockchain_status}`; badge.textContent = document.blockchain_status.replaceAll("_", " "); actions.append(badge, makeButton("Copy hash", () => copy(document.sha256_hash)), makeButton("Copy CID", () => copy(document.ipfs_cid)));
    if (state.config?.blockchain && document.blockchain_status !== "registered") actions.append(makeButton("Register on chain", () => registerOnChain(document)));
    row.append(name, ids, actions); target.append(row);
  });
}

function timeline(targetId, items, type) {
  const target = $(targetId); target.replaceChildren();
  if (!items.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = type === "event" ? "No audit events yet." : "No verification checks yet."; target.append(empty); return; }
  items.slice(0, 10).forEach((item) => {
    const node = document.createElement("div"); const value = type === "event" ? item.event_status : item.result; node.className = `timeline-item ${value}`;
    const title = document.createElement("div"); title.className = "timeline-title"; title.textContent = type === "event" ? `${item.event_type.replaceAll("_", " ")} · ${item.event_status}` : `${item.result} · ${item.submitted_filename || "unnamed PDF"}`;
    const meta = document.createElement("div"); meta.className = "timeline-meta"; meta.textContent = `${when(item.created_at)} · ${type === "event" ? "Document audit" : item.verification_source.replaceAll("_", " ")}`; node.append(title, meta); target.append(node);
  });
}

function renderAll() { renderStats(); renderReferenceOptions(); renderLibrary(); timeline("eventList", state.events, "event"); timeline("verificationList", state.logs, "log"); $("historyCount").textContent = `${state.logs.length} record${state.logs.length === 1 ? "" : "s"}`; }

async function loadLibrary() {
  const { data, error } = await state.client.functions.invoke("document-library", { method: "GET" });
  if (error) throw error;
  state.documents = data.documents || []; state.logs = data.logs || []; state.events = data.events || []; renderAll();
}

function showApp(session) {
  const active = Boolean(session); $("authView").classList.toggle("hidden", active); $("appView").classList.toggle("hidden", !active); $("signOutButton").classList.toggle("hidden", !active);
  if (!active) { setNetwork("Sign in required", true); return; }
  setNetwork(session.user.email || "Signed in");
  loadLibrary().catch((error) => { setNetwork("Library unavailable", true); message("uploadResult", getError(error), "error"); });
}

async function authenticate(event) {
  event.preventDefault(); const email = $("email").value.trim(); const password = $("password").value;
  if (!email || !password) { $("authMessage").textContent = "Enter your email and password."; $("authMessage").className = "form-message error"; return; }
  const button = $("authSubmit"); setBusy(button, true, "Working…"); $("authMessage").textContent = "";
  const action = state.signup ? state.client.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } }) : state.client.auth.signInWithPassword({ email, password });
  const { data, error } = await action; setBusy(button, false);
  if (error) { $("authMessage").textContent = error.message; $("authMessage").className = "form-message error"; return; }
  if (state.signup && !data.session) { $("authMessage").textContent = "Check your email to confirm the account, then sign in."; $("authMessage").className = "form-message"; }
}

function validClientFile(file) { if (!file) return "Choose a PDF file."; if (file.size > 25 * 1024 * 1024) return "PDF exceeds the 25 MB limit."; if (!file.name.toLowerCase().endsWith(".pdf")) return "Choose a PDF file."; return null; }

async function upload() {
  const file = $("uploadFile").files[0]; const issue = validClientFile(file); if (issue) return message("uploadResult", issue, "error");
  const button = $("uploadButton"); setBusy(button, true, "Uploading…"); message("uploadResult", "Uploading original bytes. The server validates the PDF, calculates SHA-256, then requests Pinata storage…", "pending");
  const { data, error } = await state.client.functions.invoke("upload-document", { body: file, headers: { "x-file-name": encodeURIComponent(file.name), "content-type": "application/pdf" } }); setBusy(button, false);
  if (error || data?.error) { message("uploadResult", data?.error || await getFunctionError(error), "error"); return; }
  const document = data.document; const target = $("uploadResult"); target.className = "result success"; target.replaceChildren(); addLine(target, data.duplicate ? "Existing document" : "Document ID", document.id, true); addLine(target, "SHA-256", document.sha256_hash, true); addLine(target, "IPFS CID", document.ipfs_cid, true); addLine(target, "Recorded", when(document.created_at));
  await loadLibrary();
}

async function registerOnChain(document) {
  if (!window.ethereum) { message("uploadResult", "A browser wallet is required for blockchain registration.", "error"); return; }
  const chain = state.config.blockchain;
  try {
    message("uploadResult", "Requesting wallet approval. Registration is not recorded until the transaction is confirmed and independently checked.", "pending");
    const provider = new BrowserProvider(window.ethereum); await provider.send("eth_requestAccounts", []);
    const network = await provider.getNetwork();
    if (network.chainId.toString() !== String(chain.chainId)) throw new Error(`Switch your wallet to ${chain.network} (chain ID ${chain.chainId}) and try again.`);
    const signer = await provider.getSigner();
    const registry = new Contract(chain.contractAddress, ["function registerEvidence(bytes32 documentHash)"], signer);
    const transaction = await registry.registerEvidence(`0x${document.sha256_hash}`);
    const receipt = await transaction.wait();
    if (!receipt || receipt.status !== 1) throw new Error("The blockchain transaction did not succeed.");
    const { data, error } = await state.client.functions.invoke("confirm-blockchain-registration", { body: { documentId: document.id, transactionHash: transaction.hash } });
    if (error || data?.error) throw new Error(data?.error || getError(error));
    message("uploadResult", `Blockchain registration confirmed in block ${data.onChain.blockNumber}.`, "success");
    await loadLibrary();
  } catch (error) { message("uploadResult", getError(error), "error"); }
}

function showReport(data) {
  const panel = $("report"); panel.classList.remove("hidden"); $("reportTitle").textContent = data.result === "match" ? "Match confirmed" : data.result === "mismatch" ? "Bytes differ" : "On-chain check inconclusive";
  const body = $("reportBody"); body.replaceChildren(); const grid = document.createElement("div"); grid.className = "report-grid";
  [["Result", data.result], ["Source", data.verificationSource], ["Reference", data.document.filename], ["Reference hash", data.expectedHash], ["Computed hash", data.computedHash], ["Document ID", data.document.id], ["IPFS CID", data.document.ipfsCid], ["Blockchain status", data.blockchain.status]].forEach(([label, value]) => { const cell = document.createElement("div"); const name = document.createElement("span"); name.textContent = label; const text = document.createElement("strong"); text.textContent = value || "—"; cell.append(name, text); grid.append(cell); }); body.append(grid);
}

async function verify() {
  const file = $("verifyFile").files[0]; const documentId = $("referenceSelect").value; const issue = validClientFile(file); if (issue) return message("verifyResult", issue, "error"); if (!documentId) return message("verifyResult", "Select a trusted document reference.", "error");
  const button = $("verifyButton"); setBusy(button, true, "Verifying…"); message("verifyResult", "Calculating the submitted PDF’s SHA-256 hash on the server and comparing it to the trusted reference…", "pending");
  const { data, error } = await state.client.functions.invoke(`verify-document?documentId=${encodeURIComponent(documentId)}`, { body: file, headers: { "x-file-name": encodeURIComponent(file.name), "content-type": "application/pdf" } }); setBusy(button, false);
  if (error || data?.error) { message("verifyResult", data?.error || await getFunctionError(error), "error"); return; }
  const target = $("verifyResult"); target.className = `result ${data.result === "match" ? "success" : data.result === "mismatch" ? "danger" : "error"}`; target.replaceChildren(); const outcome = data.result === "match" ? ["MATCH", "The PDF bytes match the trusted reference."] : data.result === "mismatch" ? ["MISMATCH", "The PDF bytes differ from the trusted reference."] : ["INCONCLUSIVE", "The server could not confirm the trusted hash against the live blockchain record."]; addLine(target, outcome[0], outcome[1]); addLine(target, "Expected hash", data.expectedHash, true); addLine(target, "Computed hash", data.computedHash, true); addLine(target, "Source", data.verificationSource.replaceAll("_", " "));
  showReport(data); await loadLibrary(); $("report").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function initialise() {
  try {
    const response = await fetch("/api/config"); const config = await response.json(); if (!response.ok) throw new Error(config.message);
    state.config = config;
    state.client = createClient(config.supabaseUrl, config.supabasePublishableKey, { auth: { persistSession: true, autoRefreshToken: true } });
    const { data: { session } } = await state.client.auth.getSession(); showApp(session);
    state.client.auth.onAuthStateChange((_event, session) => showApp(session));
  } catch (error) { setNetwork("Configuration unavailable", true); $("authMessage").textContent = getError(error); $("authMessage").className = "form-message error"; }
}

$("authForm").addEventListener("submit", authenticate);
$("authMode").addEventListener("click", () => { state.signup = !state.signup; $("authSubmit").textContent = state.signup ? "Create account" : "Sign in"; $("authMode").textContent = state.signup ? "Already have an account? Sign in" : "Need an account? Create one"; $("authMessage").textContent = ""; });
$("signOutButton").addEventListener("click", () => state.client.auth.signOut());
$("uploadFile").addEventListener("change", (event) => { $("uploadFileName").textContent = event.target.files[0]?.name || "No file selected"; });
$("verifyFile").addEventListener("change", (event) => { $("verifyFileName").textContent = event.target.files[0]?.name || "No file selected"; });
$("uploadButton").addEventListener("click", upload); $("verifyButton").addEventListener("click", verify); $("refreshButton").addEventListener("click", () => loadLibrary().catch((error) => message("uploadResult", getError(error), "error"))); $("librarySearch").addEventListener("input", renderLibrary); $("libraryFilter").addEventListener("change", renderLibrary); $("printReport").addEventListener("click", () => window.print());
initialise();
