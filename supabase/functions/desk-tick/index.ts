// desk-tick: a signed-in member nudges the machine: incremental GHL sync + rules for their store, and (optionally) pushes a new walk-in lead to GHL as a contact.
// POST { store_id, push_contact?: lead_id }
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
  const storeId = body.store_id;
  if (!storeId) return json({ error: "store_id required" }, 400);
  const { data: member } = await user.rpc("is_member", { p_store: storeId });
  const { data: adminFlag } = await user.rpc("is_platform_admin");
  if (!member && !adminFlag) return json({ error: "not a member" }, 403);

  const out: any = { ok: true };
  if (body.push_contact) {
    const { data: lead } = await admin.from("leads").select("*").eq("id", body.push_contact).eq("store_id", storeId).maybeSingle();
    const { data: integ } = await admin.from("integrations").select("secrets, config").eq("store_id", storeId).eq("provider", "ghl").maybeSingle();
    if (lead && !lead.ghl_contact_id && integ?.secrets?.token && integ.config?.location_id) {
      const res = await fetch("https://services.leadconnectorhq.com/contacts/", {
        method: "POST", headers: { Authorization: `Bearer ${integ.secrets.token}`, Version: "2021-07-28", "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ locationId: integ.config.location_id, firstName: lead.first_name, lastName: lead.last_name, phone: lead.phone, email: lead.email || undefined, source: "walk-in", tags: ["src-walkin"] }),
      });
      const txt = await res.text(); let j: any = {}; try { j = JSON.parse(txt); } catch { /* ignore */ }
      const id = j.contact?.id || j.meta?.contactId || null;
      if (id) { await admin.from("leads").update({ ghl_contact_id: id }).eq("id", lead.id); out.pushed_contact = id; }
      else out.push_error = txt.slice(0, 200);
    }
  }
  const h = { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
  const [s, r] = await Promise.all([
    fetch(`${SUPABASE_URL}/functions/v1/ghl-sync`, { method: "POST", headers: h, body: JSON.stringify({ store_id: storeId, mode: "incremental", max_conversations: 15 }) }).then((x) => x.json()).catch((e) => ({ error: String(e) })),
    fetch(`${SUPABASE_URL}/functions/v1/desk-rules`, { method: "POST", headers: h, body: JSON.stringify({ store_id: storeId }) }).then((x) => x.json()).catch((e) => ({ error: String(e) })),
  ]);
  out.sync = { contacts: s.contacts, conversations: s.conversations, events: s.events, error: s.error };
  out.rules = r.stores?.[0]?.made || r.error;
  return json(out);
});
function json(b: unknown, status = 200) { return new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json", ...CORS } }); }
