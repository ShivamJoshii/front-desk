// team-admin: owners manage who can sign in. Uses the Supabase Auth admin API (service role), never raw auth-table writes.
//   POST { action: "list", store_id }                                                   → members + people invited but not signed up
//   POST { action: "save", store_id, email, display_name, access, password? }           → create the login (or reset its password) + membership
//   POST { action: "remove", store_id, user_id }                                        → take someone off the store (their login stays, it just sees nothing)
// access: "owner" | "front_desk" | "team"
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const ACCESS: Record<string, { role: string; desk_role: string }> = {
  owner: { role: "owner", desk_role: "owner" },
  front_desk: { role: "staff", desk_role: "receptionist" },
  team: { role: "staff", desk_role: "operator" },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const user = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } }, auth: { persistSession: false } });
  const { data: u } = await user.auth.getUser();
  if (!u?.user) return json({ error: "not signed in" }, 401);
  const b = await req.json().catch(() => ({}));
  const store_id = String(b.store_id || "");
  const { data: owner } = await user.rpc("is_owner", { p_store: store_id });
  if (!owner) return json({ error: "only an owner can manage the team" }, 403);

  const allUsers = async () => {
    const out: any[] = [];
    for (let page = 1; page < 20; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw error;
      out.push(...data.users);
      if (data.users.length < 200) break;
    }
    return out;
  };

  try {
    if (b.action === "list") {
      const [{ data: members }, { data: invites }, users] = await Promise.all([
        admin.from("store_members").select("user_id, role, desk_role, display_name").eq("store_id", store_id),
        admin.from("store_invites").select("email, role, desk_role, display_name, accepted_at").eq("store_id", store_id),
        allUsers(),
      ]);
      const byId = new Map(users.map((x) => [x.id, x]));
      const byEmail = new Map(users.map((x) => [String(x.email || "").toLowerCase(), x]));
      const rows = (members || []).map((m) => {
        const au = byId.get(m.user_id);
        return { user_id: m.user_id, email: au?.email || null, display_name: m.display_name, access: accessOf(m), last_sign_in_at: au?.last_sign_in_at || null, me: m.user_id === u.user.id };
      });
      const memberEmails = new Set(rows.map((r) => String(r.email || "").toLowerCase()));
      const pending = (invites || []).filter((i) => !memberEmails.has(i.email.toLowerCase())).map((i) => ({ email: i.email, display_name: i.display_name, access: accessOf(i), has_login: byEmail.has(i.email.toLowerCase()) }));
      return json({ ok: true, members: rows, pending });
    }

    if (b.action === "save") {
      const email = String(b.email || "").trim().toLowerCase();
      const name = String(b.display_name || "").trim();
      const acc = ACCESS[b.access];
      const password = b.password == null ? "" : String(b.password);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "That email doesn't look right." }, 400);
      if (!name) return json({ error: "Add their name." }, 400);
      if (!acc) return json({ error: "Pick their access." }, 400);
      if (password && password.length < 8) return json({ error: "Password needs at least 8 characters." }, 400);
      let au = (await allUsers()).find((x) => String(x.email || "").toLowerCase() === email);
      let created = false;
      if (au && au.id === u.user.id && acc.role !== "owner") return json({ error: "You can't remove your own owner access." }, 400);
      if (!au) {
        if (!password) return json({ error: "Set a password for their first login." }, 400);
        const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: name } });
        if (error) return json({ error: error.message }, 400);
        au = data.user; created = true;
      } else if (password) {
        const { error } = await admin.auth.admin.updateUserById(au.id, { password, email_confirm: true });
        if (error) return json({ error: error.message }, 400);
      }
      const { error: mErr } = await admin.from("store_members").upsert({ store_id, user_id: au.id, role: acc.role, desk_role: acc.desk_role, display_name: name }, { onConflict: "store_id,user_id" });
      if (mErr) return json({ error: mErr.message }, 500);
      await admin.from("store_invites").upsert({ store_id, email, role: acc.role, desk_role: acc.desk_role, display_name: name, accepted_at: new Date().toISOString() }, { onConflict: "store_id,email" });
      return json({ ok: true, created, password_set: !!password });
    }

    if (b.action === "remove") {
      if (b.user_id === u.user.id) return json({ error: "You can't remove yourself." }, 400);
      const au = (await admin.auth.admin.getUserById(String(b.user_id))).data?.user;
      await admin.from("store_members").delete().eq("store_id", store_id).eq("user_id", b.user_id);
      if (au?.email) await admin.from("store_invites").delete().eq("store_id", store_id).eq("email", au.email.toLowerCase());
      return json({ ok: true });
    }
  } catch (e) { return json({ error: String((e as Error).message || e) }, 500); }

  return json({ error: "unknown action" }, 400);
});

function accessOf(m: { role: string; desk_role: string | null }) { return m.role === "owner" ? "owner" : m.desk_role === "receptionist" ? "front_desk" : "team"; }
function json(b: unknown, status = 200) { return new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json", ...CORS } }); }
