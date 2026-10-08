import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const MAX_PDF_BYTES = 25 * 1024 * 1024;

export function corsHeaders(request: Request) {
  const origin = request.headers.get("origin") ?? "";
  const allowed = (Deno.env.get("APP_ORIGIN") ?? "http://localhost:3000")
    .split(",").map((value) => value.trim());
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), "Content-Type": "application/json" },
  });
}

export function adminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase server credentials are unavailable.");
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function authenticatedUser(request: Request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("Authentication is required.");
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!url || !key) throw new Error("Supabase public configuration is unavailable.");
  const client = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new Error("Your session is invalid or has expired.");
  return data.user;
}

export function safeFilename(value: string | null) {
  let decoded = value ?? "document.pdf";
  try { decoded = decodeURIComponent(decoded); } catch { /* use the original header value */ }
  const cleaned = decoded.replace(/[\\/\u0000-\u001f]/g, "_").trim();
  return cleaned.slice(0, 512) || "document.pdf";
}

export async function readPdf(request: Request) {
  const declaredSize = Number(request.headers.get("content-length") ?? 0);
  if (declaredSize > MAX_PDF_BYTES) throw new Error("PDF exceeds the 25 MB limit.");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) throw new Error("Choose a non-empty PDF file.");
  if (bytes.byteLength > MAX_PDF_BYTES) throw new Error("PDF exceeds the 25 MB limit.");
  const signature = new TextDecoder().decode(bytes.slice(0, 5));
  if (signature !== "%PDF-") throw new Error("The submitted file is not a valid PDF byte stream.");
  return bytes;
}

export async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function addEvent(documentId: string, userId: string, eventType: string, eventStatus: string, metadata: Record<string, unknown> = {}) {
  const { error } = await adminClient().from("document_events").insert({
    document_id: documentId, user_id: userId, event_type: eventType, event_status: eventStatus, metadata,
  });
  if (error) console.error("Unable to write audit event", error.message);
}
