// qbo-connect: GET ?store_id=... -> redirects the browser to Intuit's consent screen.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { authorizeUrl } from "./qbo.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const app = {
  clientId: Deno.env.get("QBO_CLIENT_ID")!, clientSecret: Deno.env.get("QBO_CLIENT_SECRET")!,
  redirectUri: `${Deno.env.get("SUPABASE_URL")}/functions/v1/qbo-callback`,
  env: (Deno.env.get("QBO_ENV") || "production") as "sandbox" | "production",
};

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const storeId = u.searchParams.get("store_id") || Deno.env.get("DESK_DEFAULT_STORE") || "5d148dc0-bf36-4301-a4c2-3d5fbef12458";
  if (!storeId) return new Response("store_id required", { status: 400 });
  if (!app.clientId) return new Response("QBO_CLIENT_ID not set", { status: 500 });
  const nonce = crypto.randomUUID();
  const state = btoa(JSON.stringify({ s: storeId, n: nonce })).replace(/=+$/, "");
  const { data: row } = await db.from("integrations").select("config, cursor").eq("store_id", storeId).eq("provider", "qbo").maybeSingle();
  const cursor = { ...(row?.cursor || {}), oauth_nonce: nonce, oauth_at: new Date().toISOString() };
  if (row) await db.from("integrations").update({ cursor, config: { ...(row.config || {}), env: app.env } }).eq("store_id", storeId).eq("provider", "qbo");
  else await db.from("integrations").insert({ store_id: storeId, provider: "qbo", config: { country: "CA", env: app.env }, cursor });
  return Response.redirect(authorizeUrl(app, state), 302);
});
