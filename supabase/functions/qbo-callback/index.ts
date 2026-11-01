// qbo-callback: Intuit redirects here with ?code&realmId&state. Exchanges the code, stores tokens, kicks off a sync, sends the browser back to the app.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { exchangeCode } from "./qbo.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const APP_URL = Deno.env.get("DESK_APP_URL") || "https://frontdesk-app.netlify.app";
const app = {
  clientId: Deno.env.get("QBO_CLIENT_ID")!, clientSecret: Deno.env.get("QBO_CLIENT_SECRET")!,
  redirectUri: `${SUPABASE_URL}/functions/v1/qbo-callback`,
  env: (Deno.env.get("QBO_ENV") || "production") as "sandbox" | "production",
};

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const code = u.searchParams.get("code"), realmId = u.searchParams.get("realmId"), state = u.searchParams.get("state");
  const back = (q: string) => Response.redirect(`${APP_URL}/settings/quickbooks?${q}`, 302);
  if (u.searchParams.get("error")) return back(`error=${encodeURIComponent(u.searchParams.get("error")!)}`);
  if (!code || !realmId || !state) return back("error=missing_params");
  let s: any; try { s = JSON.parse(atob(state)); } catch { return back("error=bad_state"); }
  const { data: row } = await db.from("integrations").select("config, cursor").eq("store_id", s.s).eq("provider", "qbo").maybeSingle();
  if (!row || row.cursor?.oauth_nonce !== s.n) return back("error=state_mismatch");
  try {
    const tokens = await exchangeCode(app, code);
    const cursor = { ...(row.cursor || {}) }; delete cursor.oauth_nonce; delete cursor.oauth_at;
    await db.from("integrations").update({
      secrets: tokens, config: { ...(row.config || {}), realm_id: realmId, env: app.env, connected_at: new Date().toISOString() },
      status: "connected", last_error: null, cursor,
    }).eq("store_id", s.s).eq("provider", "qbo");
    // first sync in the background
    fetch(`${SUPABASE_URL}/functions/v1/qbo-sync`, { method: "POST", headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ store_id: s.s, mode: "full" }) }).catch(() => {});
    return back("connected=1");
  } catch (e) {
    await db.from("integrations").update({ status: "error", last_error: String((e as Error).message).slice(0, 500) }).eq("store_id", s.s).eq("provider", "qbo");
    return back(`error=${encodeURIComponent(String((e as Error).message).slice(0, 120))}`);
  }
});
