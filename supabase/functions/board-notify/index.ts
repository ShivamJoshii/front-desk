// board-notify: Slack for the team board.
//   POST { action: "task", task_id, event: "created" | "assigned" }  → posts the task to the store's Slack channel
//   POST { action: "connect", store_id, webhook_url }                 → owner saves a Slack incoming-webhook URL (sends a test message)
//   POST { action: "disconnect", store_id }                           → owner removes it
// The webhook URL lives in integrations (provider 'slack', service role only). Optional desk_settings.settings.slack_ids
// maps team names to Slack member IDs ({"Davin":"U0123ABC"}) so the owner gets @mentioned.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const APP_URL = "https://frontdesk-app.netlify.app/#board";
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const AREA: Record<string, string> = { sales: "Sales", ops: "Ops", marketing: "Marketing" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const user = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } }, auth: { persistSession: false } });
  const { data: u } = await user.auth.getUser();
  if (!u?.user) return json({ error: "not signed in" }, 401);
  const b = await req.json().catch(() => ({}));

  if (b.action === "connect" || b.action === "disconnect") {
    const store_id = String(b.store_id || "");
    const { data: owner } = await user.rpc("is_owner", { p_store: store_id });
    if (!owner) return json({ error: "only an owner can change Slack" }, 403);
    if (b.action === "disconnect") {
      await admin.from("integrations").upsert({ store_id, provider: "slack", secrets: {}, config: {}, status: "disconnected", last_error: null, updated_at: new Date().toISOString() });
      return json({ ok: true });
    }
    const url = String(b.webhook_url || "").trim();
    if (!/^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/.test(url)) return json({ error: "That isn't a Slack webhook link. It starts with https://hooks.slack.com/services/" }, 400);
    const test = await post(url, { text: "Front Desk is connected. New tasks on the team board will show up here." });
    if (!test.ok) return json({ error: "Slack didn't accept it: " + test.error }, 400);
    const { error } = await admin.from("integrations").upsert({ store_id, provider: "slack", secrets: { webhook_url: url }, config: { channel_hint: b.channel || null }, status: "connected", last_error: null, last_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (b.action === "task") {
    const { data: t } = await admin.from("team_tasks").select("*").eq("id", b.task_id).maybeSingle();
    if (!t) return json({ error: "task not found" }, 404);
    const { data: member } = await user.rpc("is_member", { p_store: t.store_id });
    if (!member) return json({ error: "not a member of this store" }, 403);
    const { data: integ } = await admin.from("integrations").select("secrets, status").eq("store_id", t.store_id).eq("provider", "slack").maybeSingle();
    const url = integ?.secrets?.webhook_url;
    if (!url || integ?.status !== "connected") return json({ ok: false, skipped: "slack not connected" });
    const [{ data: me }, { data: st }] = await Promise.all([
      admin.from("store_members").select("display_name").eq("store_id", t.store_id).eq("user_id", u.user.id).maybeSingle(),
      admin.from("desk_settings").select("settings").eq("store_id", t.store_id).maybeSingle(),
    ]);
    const by = me?.display_name || (u.user.email || "").split("@")[0] || "someone";
    const ids: Record<string, string> = st?.settings?.slack_ids || {};
    const idFor = (n: string) => { const k = Object.keys(ids).find((x) => x.toLowerCase() === n.toLowerCase()); return k ? ids[k] : null; };
    const who = t.owner_name ? (idFor(t.owner_name) ? `<@${idFor(t.owner_name)}>` : t.owner_name) : null;
    const head = b.event === "assigned"
      ? (who ? `*${who}* now owns this` : `This task has no owner now`)
      : (who ? `*New task for ${who}*` : `*New task* (no owner yet)`);
    const due = t.due_on ? "due " + new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(t.due_on + "T12:00:00Z")) : "no due date";
    const lines = [`${head}: ${esc(t.title)}`, `${AREA[t.area] || t.area} · ${due} · from ${esc(by)}`];
    if (t.note) lines.push(`> ${esc(t.note).replace(/\n/g, "\n> ")}`);
    lines.push(`<${APP_URL}|Open the board>`);
    const r = await post(url, { text: lines.join("\n") });
    await admin.from("integrations").update(r.ok ? { last_sync_at: new Date().toISOString(), last_error: null } : { last_error: r.error }).eq("store_id", t.store_id).eq("provider", "slack");
    return json({ ok: r.ok, error: r.error });
  }

  return json({ error: "unknown action" }, 400);
});

async function post(url: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) return { ok: true };
    return { ok: false, error: `${res.status} ${(await res.text()).slice(0, 120)}` };
  } catch (e) { return { ok: false, error: String(e) }; }
}
function esc(s: string) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function json(b: unknown, status = 200) { return new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json", ...CORS } }); }
