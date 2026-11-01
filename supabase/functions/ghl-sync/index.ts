// ghl-sync: pulls contacts, conversations and messages from GHL into leads / lead_events.
// Invoke with POST { store_id, mode?: "full" | "incremental", max_conversations?: number }.
// Auth: service role key in Authorization header (verify_jwt off; we check the key ourselves).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { iterContacts, getCustomFieldDefs, mapContact, iterConversations, fetchMessages, mapMessage, deriveFromEvents } from "./ghl.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (!(await authorized(req))) return new Response("unauthorized", { status: 401 });

  const body = await req.json().catch(() => ({}));
  const storeId: string = body.store_id;
  if (!storeId) return json({ error: "store_id required" }, 400);
  const mode: "full" | "incremental" | "backfill" = body.mode || "incremental";
  const maxConv = Number(body.max_conversations || 40);

  const { data: integ, error: ie } = await db.from("integrations").select("*").eq("store_id", storeId).eq("provider", "ghl").single();
  if (ie || !integ) return json({ error: "ghl integration missing" }, 404);
  const token = integ.secrets?.token; const locationId = integ.config?.location_id;
  if (!token || !locationId) return json({ error: "ghl token/location not set" }, 400);
  const c = { token, locationId };
  const cursor = integ.cursor || {};
  const started = Date.now();
  const stats = { contacts: 0, conversations: 0, events: 0, leads_touched: 0, mode };

  try {
    // ---- contacts
    const defs = await getCustomFieldDefs(c);
    let maxUpdated = cursor.contacts_updated_after || null;
    const contactOpts = mode === "full" || !cursor.contacts_updated_after ? {} : { updatedAfter: cursor.contacts_updated_after };
    const batch: any[] = [];
    for await (const x of (mode === "backfill" ? [] : iterContacts(c, contactOpts))) {
      batch.push(mapContact(x, storeId, defs));
      if (x.dateUpdated && (!maxUpdated || x.dateUpdated > maxUpdated)) maxUpdated = x.dateUpdated;
      if (batch.length >= 200) { await upsertLeads(batch); stats.contacts += batch.length; batch.length = 0; }
    }
    if (batch.length) { await upsertLeads(batch); stats.contacts += batch.length; }
    cursor.contacts_updated_after = maxUpdated;

    // ---- conversations (newest first; stop at cursor or at maxConv)
    // modes: full = newest-first from the top; backfill = continue an interrupted full pass from cursor.backfill_before_ms; incremental = only newer than cursor
    const backfill = mode === "backfill" || (mode === "full" && cursor.backfill_before_ms);
    const afterMs = (mode === "full" || backfill) ? undefined : Number(cursor.conversations_after_ms || 0) || undefined;
    const startAfterMs = backfill ? Number(cursor.backfill_before_ms) : undefined;
    let newestMs = Number(cursor.conversations_after_ms || 0);
    let n = 0, lastSeenMs = 0;
    const touched = new Set<string>();
    for await (const cv of iterConversations(c, { afterMs, startAfterMs, pageSize: 20 })) {
      if (n >= maxConv || Date.now() - started > 110_000) { cursor.conversations_backlog = true; cursor.backfill_before_ms = lastSeenMs; break; }
      n++; lastSeenMs = Number(cv.lastMessageDate || 0);
      const { data: lead } = await db.from("leads").select("id, stage").eq("store_id", storeId).eq("ghl_contact_id", cv.contactId).maybeSingle();
      const msgs = await fetchMessages(c, cv.id, { afterMs: mode === "full" ? undefined : afterMs, max: 300 });
      const rows = msgs.map((m) => mapMessage(m, storeId, lead?.id ?? null, cv)).filter((r) => !r.meta?.mirror);
      if (rows.length) {
        const { error } = await db.from("lead_events").upsert(rows, { onConflict: "ghl_message_id", ignoreDuplicates: true });
        if (error) throw error;
        stats.events += rows.length;
      }
      if (lead) touched.add(lead.id);
      newestMs = Math.max(newestMs, Number(cv.lastMessageDate || 0));
      stats.conversations++;
    }
    if (n < maxConv) { cursor.conversations_backlog = false; delete cursor.backfill_before_ms; }
    cursor.conversations_after_ms = newestMs;

    // ---- derive attempts / last touch / early stages for touched leads
    for (const leadId of touched) {
      const { data: lead } = await db.from("leads").select("id, stage").eq("id", leadId).single();
      const { data: evs } = await db.from("lead_events").select("kind, direction, at, meta").eq("lead_id", leadId).order("at");
      if (!lead || !evs) continue;
      const d = deriveFromEvents(lead, evs as any);
      const patch: any = { attempts: d.attempts, last_touch_at: d.last_touch_at };
      if (d.stage !== lead.stage) { patch.stage = d.stage; patch.stage_changed_at = new Date().toISOString(); }
      await db.from("leads").update(patch).eq("id", leadId);
      stats.leads_touched++;
    }

    await db.from("integrations").update({ cursor, status: "connected", last_sync_at: new Date().toISOString(), last_error: null }).eq("store_id", storeId).eq("provider", "ghl");
    return json({ ok: true, ...stats, cursor, ms: Date.now() - started });
  } catch (e) {
    const msg = String((e as Error).message || e);
    await db.from("integrations").update({ status: "error", last_error: msg.slice(0, 500) }).eq("store_id", storeId).eq("provider", "ghl");
    return json({ ok: false, error: msg, ...stats }, 500);
  }

  async function upsertLeads(rows: any[]) {
    // Keep stage edits made in the app: only set stage on insert. Done by upserting without stage for existing rows.
    const ids = rows.map((r) => r.ghl_contact_id);
    const { data: existing } = await db.from("leads").select("ghl_contact_id").eq("store_id", storeId).in("ghl_contact_id", ids);
    const have = new Set((existing || []).map((r: any) => r.ghl_contact_id));
    const inserts = rows.filter((r) => !have.has(r.ghl_contact_id));
    const updates = rows.filter((r) => have.has(r.ghl_contact_id)).map(({ stage, created_at, ...rest }) => rest);
    if (inserts.length) { const { error } = await db.from("leads").insert(inserts); if (error) throw error; }
    for (const u of updates) { const { error } = await db.from("leads").update(u).eq("store_id", storeId).eq("ghl_contact_id", u.ghl_contact_id); if (error) throw error; }
  }
});

// Accepts: the service-role key as Bearer, or x-desk-key matching DESK_CRON_KEY env or the cron_key stored on a GHL integration row.
async function authorized(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") || "";
  if (auth.includes(SERVICE_KEY)) return true;
  const k = req.headers.get("x-desk-key") || "";
  if (!k) return false;
  if (Deno.env.get("DESK_CRON_KEY") && k === Deno.env.get("DESK_CRON_KEY")) return true;
  const { data } = await db.from("integrations").select("secrets").eq("provider", "ghl").limit(5);
  return (data || []).some((r: any) => r.secrets?.cron_key && r.secrets.cron_key === k);
}

function json(b: unknown, status = 200) { return new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } }); }
