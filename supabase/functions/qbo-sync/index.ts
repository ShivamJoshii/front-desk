// qbo-sync: pulls Customers, Estimates, Invoices, Payments changed since the cursor; links them to leads; moves stages.
// POST { store_id, mode?: "full" | "incremental" }. Service-role or x-desk-key auth.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withAuth, QboAuthError, iterEntity, mapEstimate, mapInvoice, mapPayment, customerPhones, customerEmail, digits10 } from "./qbo.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const app = {
  clientId: Deno.env.get("QBO_CLIENT_ID")!, clientSecret: Deno.env.get("QBO_CLIENT_SECRET")!,
  redirectUri: `${SUPABASE_URL}/functions/v1/qbo-callback`,
  env: (Deno.env.get("QBO_ENV") || "production") as "sandbox" | "production",
};

Deno.serve(async (req) => {
  if (!(await authorized(req))) return new Response("unauthorized", { status: 401 });
  const body = await req.json().catch(() => ({}));
  const storeId: string = body.store_id; const mode = body.mode || "incremental";
  if (!storeId) return json({ error: "store_id required" }, 400);

  const { data: integ } = await db.from("integrations").select("*").eq("store_id", storeId).eq("provider", "qbo").maybeSingle();
  if (!integ?.secrets?.refresh_token || !integ.config?.realm_id) return json({ error: "quickbooks not connected" }, 400);
  const env = integ.config.env || app.env; const realm = integ.config.realm_id;
  const stats = { customers: 0, estimates: 0, invoices: 0, payments: 0, linked: 0, stage_changes: 0, mode };
  try {
    // ---- token: refreshed only when within 2 min of expiry (hourly at most); 401 mid-run → refresh once and retry
    const save = async (t: any) => { await db.from("integrations").update({ secrets: t }).eq("store_id", storeId).eq("provider", "qbo"); };
    const tokens = { access_token: "", ...integ.secrets };
    const run = <T,>(fn: (tok: string) => Promise<T>) => withAuth(app, tokens, async (t) => { Object.assign(tokens, t); await save(t); }, fn);
    const since = mode === "full" ? null : (integ.cursor?.qbo_since || null);
    const runStarted = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

    // ---- settings
    const { data: st } = await db.from("desk_settings").select("settings").eq("store_id", storeId).maybeSingle();
    const depositPct = Number(st?.settings?.deposit_pct ?? 50);

    // ---- leads index for matching (phone digits, email, name)
    const { data: leads } = await db.from("leads").select("id, phone, email, first_name, last_name, qb_customer_id, stage, est_value").eq("store_id", storeId);
    const byPhone = new Map<string, any>(), byEmail = new Map<string, any>(), byName = new Map<string, any>(), byQb = new Map<string, any>();
    for (const l of leads || []) {
      const p = digits10(l.phone); if (p && !byPhone.has(p)) byPhone.set(p, l);
      if (l.email) byEmail.set(String(l.email).toLowerCase(), l);
      const n = `${l.first_name || ""} ${l.last_name || ""}`.trim().toLowerCase(); if (n.length > 3 && !byName.has(n)) byName.set(n, l);
      if (l.qb_customer_id) byQb.set(String(l.qb_customer_id), l);
    }
    const customerLead = new Map<string, any>(); // qb customer id -> lead

    // ---- customers: link to leads
    for await (const c of await run(async (tok) => collect(iterEntity(env, realm, tok, "Customer", since)))) {
      stats.customers++;
      const id = String(c.Id);
      let lead = byQb.get(id) || null;
      if (!lead) for (const p of customerPhones(c)) { if (byPhone.has(p)) { lead = byPhone.get(p); break; } }
      if (!lead) { const e = customerEmail(c); if (e && byEmail.has(e)) lead = byEmail.get(e); }
      if (!lead) { const n = `${c.GivenName || ""} ${c.FamilyName || ""}`.trim().toLowerCase() || String(c.DisplayName || "").toLowerCase(); if (n && byName.has(n)) lead = byName.get(n); }
      if (lead) {
        customerLead.set(id, lead);
        if (lead.qb_customer_id !== id) { await db.from("leads").update({ qb_customer_id: id }).eq("id", lead.id); lead.qb_customer_id = id; byQb.set(id, lead); stats.linked++; }
      }
    }
    const leadFor = (qbCustomerId: string | null) => (qbCustomerId ? customerLead.get(qbCustomerId) || byQb.get(qbCustomerId) || null : null);

    // ---- estimates
    for await (const x of await run(async (tok) => collect(iterEntity(env, realm, tok, "Estimate", since)))) {
      const row: any = mapEstimate(x, storeId); const lead = leadFor(row.qb_customer_id); row.lead_id = lead?.id ?? null;
      const { error } = await db.from("estimates").upsert(row, { onConflict: "store_id,qb_estimate_id" }); if (error) throw error;
      stats.estimates++;
      if (lead) {
        await db.from("lead_events").upsert({ store_id: storeId, lead_id: lead.id, kind: "estimate", at: x.MetaData?.CreateTime || new Date().toISOString(), body: `Estimate ${row.doc_number || row.qb_estimate_id} · $${row.total.toLocaleString()}`, qb_txn_id: row.qb_estimate_id, meta: { total: row.total, status: row.status } }, { onConflict: "kind,qb_txn_id", ignoreDuplicates: true });
        if (!["estimate_sent", "won", "customer", "lost"].includes(lead.stage)) { await setStage(lead, "estimate_sent", `estimate ${row.doc_number || ""}`.trim()); }
        if (!lead.est_value || Number(lead.est_value) < row.total) await db.from("leads").update({ est_value: row.total }).eq("id", lead.id);
      }
    }
    // ---- invoices
    for await (const x of await run(async (tok) => collect(iterEntity(env, realm, tok, "Invoice", since)))) {
      const row: any = mapInvoice(x, storeId); const lead = leadFor(row.qb_customer_id); row.lead_id = lead?.id ?? null;
      const { error } = await db.from("invoices").upsert(row, { onConflict: "store_id,qb_invoice_id" }); if (error) throw error;
      stats.invoices++;
      if (lead) await db.from("lead_events").upsert({ store_id: storeId, lead_id: lead.id, kind: "invoice", at: x.MetaData?.CreateTime || new Date().toISOString(), body: `Invoice ${row.doc_number || row.qb_invoice_id} · $${row.total.toLocaleString()} · balance $${row.balance.toLocaleString()}`, qb_txn_id: row.qb_invoice_id, meta: { total: row.total, balance: row.balance } }, { onConflict: "kind,qb_txn_id", ignoreDuplicates: true });
    }
    // ---- payments: first payment on a lead = the deposit = Won
    for await (const x of await run(async (tok) => collect(iterEntity(env, realm, tok, "Payment", since)))) {
      const row: any = mapPayment(x, storeId); const lead = leadFor(row.qb_customer_id); row.lead_id = lead?.id ?? null;
      if (lead) {
        const { count } = await db.from("payments").select("id", { count: "exact", head: true }).eq("lead_id", lead.id).neq("qb_payment_id", row.qb_payment_id);
        row.is_deposit = (count || 0) === 0;
      }
      const { error } = await db.from("payments").upsert(row, { onConflict: "store_id,qb_payment_id" }); if (error) throw error;
      stats.payments++;
      if (lead) {
        await db.from("lead_events").upsert({ store_id: storeId, lead_id: lead.id, kind: "payment", at: x.MetaData?.CreateTime || new Date().toISOString(), body: `${row.is_deposit ? "Deposit" : "Payment"} · $${row.amount.toLocaleString()}${row.method ? " · " + row.method : ""}`, qb_txn_id: row.qb_payment_id, meta: { amount: row.amount, is_deposit: row.is_deposit, deposit_pct: depositPct } }, { onConflict: "kind,qb_txn_id", ignoreDuplicates: true });
        if (row.is_deposit && !["won", "customer"].includes(lead.stage)) await setStage(lead, "won", `deposit $${row.amount}`);
      }
    }

    await db.from("integrations").update({ cursor: { ...(integ.cursor || {}), qbo_since: runStarted }, status: "connected", last_sync_at: new Date().toISOString(), last_error: null }).eq("store_id", storeId).eq("provider", "qbo");
    return json({ ok: true, ...stats });
  } catch (e) {
    const msg = String((e as Error).message || e);
    if (e instanceof QboAuthError && e.code === "invalid_grant") {
      // refresh token expired (100 days) or revoked: drop the tokens and ask the customer to reconnect
      await db.from("integrations").update({ status: "disconnected", secrets: {}, last_error: "QuickBooks needs to be reconnected" }).eq("store_id", storeId).eq("provider", "qbo");
      return json({ ok: false, error: "reconnect_required", ...stats }, 409);
    }
    await db.from("integrations").update({ status: "error", last_error: msg.slice(0, 500) }).eq("store_id", storeId).eq("provider", "qbo");
    return json({ ok: false, error: msg, ...stats }, 500);
  }

  async function setStage(lead: any, stage: string, why: string) {
    await db.from("leads").update({ stage, stage_changed_at: new Date().toISOString() }).eq("id", lead.id);
    await db.from("lead_events").insert({ store_id: storeId, lead_id: lead.id, kind: "stage", body: `${lead.stage} → ${stage} (${why})`, meta: { from: lead.stage, to: stage, by: "quickbooks" } });
    lead.stage = stage; stats.stage_changes++;
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

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> { const out: T[] = []; for await (const x of it) out.push(x); return out; }
function json(b: unknown, status = 200) { return new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } }); }
