// desk-note: a signed-in store member leaves a note on a lead. Saved in Front Desk, mirrored to the GHL contact as a note,
// and if it carries a promise ("I'll send the PDF by 3pm") it becomes a card on the receptionist's stack.
// POST { lead_id, body, promise?: { label: string, due_at: ISO } }
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
  const b = await req.json().catch(() => ({}));
  const lead_id = b.lead_id; const text = String(b.body || "").trim();
  const promise = b.promise && b.promise.label && b.promise.due_at ? { label: String(b.promise.label).slice(0, 120), due_at: new Date(b.promise.due_at).toISOString() } : null;
  if (!lead_id || (!text && !promise)) return json({ error: "lead_id and a note or a promise required" }, 400);

  const { data: lead } = await admin.from("leads").select("id, store_id, ghl_contact_id, first_name, last_name").eq("id", lead_id).maybeSingle();
  if (!lead) return json({ error: "lead not found" }, 404);
  const { data: member } = await user.rpc("is_member", { p_store: lead.store_id });
  if (!member) return json({ error: "not a member of this store" }, 403);
  const { data: me } = await admin.from("store_members").select("display_name").eq("store_id", lead.store_id).eq("user_id", u.user.id).maybeSingle();
  const author = me?.display_name || (u.user.email || "").split("@")[0] || "staff";
  const first = lead.first_name || "them";
  const now = new Date().toISOString();

  const full = text + (promise ? (text ? "\n" : "") + `Promised ${first}: ${promise.label} — by ${fmt(promise.due_at)}` : "");

  // 1) Front Desk timeline
  const { data: ev, error: evErr } = await admin.from("lead_events").insert({
    store_id: lead.store_id, lead_id: lead.id, kind: "note", at: now, direction: "out", body: full, by_user_id: u.user.id,
    meta: { via: "front-desk", author, promise },
  }).select("id").single();
  if (evErr) return json({ error: evErr.message }, 500);

  // 2) Promise → card
  let task_id: string | null = null;
  if (promise) {
    const { data: t } = await admin.from("tasks").insert({
      store_id: lead.store_id, lead_id: lead.id, kind: "custom", title: `${promise.label} for ${first}`,
      say: `You told ${first} you'd ${lower(promise.label)}. Do it now, then mark it done — they're waiting on you.`,
      due_at: promise.due_at, assigned_user_id: u.user.id, status: "open", rule_key: `promise:${ev.id}`, created_by: "note",
    }).select("id").single();
    task_id = t?.id ?? null;
    await admin.from("leads").update({ next_action_at: promise.due_at }).eq("id", lead.id);
  }

  // 3) Mirror to GHL as a contact note (best effort — the note is already saved here)
  let ghl: { ok: boolean; id?: string; error?: string } = { ok: false };
  if (lead.ghl_contact_id) {
    const { data: integ } = await admin.from("integrations").select("secrets").eq("store_id", lead.store_id).eq("provider", "ghl").maybeSingle();
    const token = integ?.secrets?.token;
    if (token) {
      try {
        const res = await fetch(`https://services.leadconnectorhq.com/contacts/${lead.ghl_contact_id}/notes`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28", "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ body: `Front Desk · ${author}: ${full}` }),
        });
        const txt = await res.text();
        if (res.ok) { let j: any = {}; try { j = JSON.parse(txt); } catch { /* ignore */ } ghl = { ok: true, id: j?.note?.id || j?.id }; }
        else ghl = { ok: false, error: `GHL ${res.status}: ${txt.slice(0, 160)}` };
      } catch (e) { ghl = { ok: false, error: String(e) }; }
      await admin.from("lead_events").update({ meta: { via: "front-desk", author, promise, ghl_note_id: ghl.id ?? null, ghl_error: ghl.error ?? null } }).eq("id", ev.id);
    } else ghl = { ok: false, error: "GHL not connected" };
  } else ghl = { ok: false, error: "lead has no GHL contact" };

  return json({ ok: true, event_id: ev.id, task_id, ghl });
});

function fmt(iso: string) { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Edmonton", weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso)); }
function lower(s: string) { return s.charAt(0).toLowerCase() + s.slice(1); }
function json(b: unknown, status = 200) { return new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json", ...CORS } }); }
