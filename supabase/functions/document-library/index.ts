import { adminClient, authenticatedUser, corsHeaders, json } from "../_shared/core.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "GET") return json(request, { error: "Method not allowed." }, 405);
  try {
    const user = await authenticatedUser(request);
    const db = adminClient();
    const { data: documentData, error } = await db.from("documents").select("*")
      .eq("owner_id", user.id).order("created_at", { ascending: false });
    if (error) throw error;
    const documents = documentData ?? [];
    const ids = documents.map((document) => document.id);
    const [{ data: logs, error: logsError }, { data: events, error: eventsError }] = await Promise.all([
      ids.length ? db.from("verification_logs").select("*").in("document_id", ids).order("created_at", { ascending: false }).limit(100) : Promise.resolve({ data: [], error: null }),
      ids.length ? db.from("document_events").select("*").in("document_id", ids).order("created_at", { ascending: false }).limit(100) : Promise.resolve({ data: [], error: null }),
    ]);
    if (logsError) throw logsError;
    if (eventsError) throw eventsError;
    return json(request, { documents, logs, events });
  } catch (error) {
    console.error(error);
    return json(request, { error: error instanceof Error ? error.message : "Unable to load your library." }, 400);
  }
});
