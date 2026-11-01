// ghl-send: a signed-in store member sends one SMS to a lead through GHL. POST { lead_id, message, task_id? }.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const authHeader = req.headers.get("Authorization") || "";
  const user = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
  const { data: u } = await user.auth.getUser();
  if (!u?.user) return json({ error: "not signed in" }, 401);
  const body = await req.json().catch(() => ({}));
  const { lead_id, message, task_id } = body;
  if (!lead_id || !message || String(message).trim().length < 2) return json({ error: "lead_id and message required" }, 400);

  const { data: lead } = await admin.from("leads").select("id, store_id, ghl_contact_id, first_name, phone, consent_source").eq("id", lead_id).maybeSingle();
  if (!lead) return json({ error: "lead not found" }, 404);
  const { data: member } = await user.rpc("is_member", { p_store: lead.store_id });
  if (!member) return json({ error: "not a member of this store" }, 403);
  if (!lead.ghl_contact_id) return json({ error: "lead has no GHL contact" }, 400);

  const { data: integ } = await admin.from("integrations").select("secrets, config").eq("store_id", lead.store_id).eq("provider", "ghl").maybeSingle();
  const token = integ?.secrets?.token;
  if (!token) return json({ error: "GHL not connected" }, 400);

  const res = await fetch("https://services.leadconnectorhq.com/conversations/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Version: "2021-04-15", "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ type: "SMS", contactId: lead.ghl_contact_id, message: String(message).trim() }),
  });
  const txt = await res.text();
  if (!res.ok) return json({ error: `GHL ${res.status}: ${txt.slice(0, 200)}` }, 502);
  let j: any = {}; try { j = JSON.parse(txt); } catch { /* ignore */ }
  const now = new Date().toISOString();
  await admin.from("lead_events").insert({ store_id: lead.store_id, lead_id: lead.id, kind: "sms_out", at: now, direction: "out", body: String(message).trim(), ghl_message_id: j.messageId || null, by_user_id: u.user.id, meta: { via: "front-desk", conversationId: j.conversationId || null, task_id: task_id || null } });
  await admin.from("leads").update({ last_touch_at: now }).eq("id", lead.id);
  if (task_id) await admin.from("tasks").update({ status: "done", outcome: "sent", done_at: now, done_by: u.user.id }).eq("id", task_id).eq("store_id", lead.store_id);
  return json({ ok: true, message_id: j.messageId || null });
});

function json(b: unknown, status = 200) { return new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json", ...CORS } }); }
