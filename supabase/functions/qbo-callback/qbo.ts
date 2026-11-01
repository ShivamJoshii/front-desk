// QuickBooks Online (Intuit) OAuth2 + query helpers. Pure fetch; no Deno-specific APIs.
export const QBO_AUTH = "https://appcenter.intuit.com/connect/oauth2";
export const QBO_TOKEN = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const QBO_REVOKE = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
export const MINOR = "75";

export type QboApp = { clientId: string; clientSecret: string; redirectUri: string; env: "sandbox" | "production" };
export type QboTokens = { access_token: string; refresh_token: string; access_expires_at: string; refresh_expires_at: string };

export function apiBase(env: string) { return env === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com"; }

export function authorizeUrl(app: QboApp, state: string) {
  const q = new URLSearchParams({ client_id: app.clientId, response_type: "code", scope: "com.intuit.quickbooks.accounting", redirect_uri: app.redirectUri, state });
  return `${QBO_AUTH}?${q}`;
}

export class QboAuthError extends Error { code: string; constructor(msg: string, code: string) { super(msg); this.code = code; } }

async function tokenRequest(app: QboApp, body: Record<string, string>, attempt = 0): Promise<QboTokens> {
  let res: Response;
  try {
    res = await fetch(QBO_TOKEN, {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(`${app.clientId}:${app.clientSecret}`), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(body),
    });
  } catch (e) { if (attempt < 2) { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); return tokenRequest(app, body, attempt + 1); } throw e; }
  if (res.status >= 500 && attempt < 2) { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); return tokenRequest(app, body, attempt + 1); }
  if (!res.ok) {
    const txt = await res.text();
    const tid = res.headers.get("intuit_tid") || "";
    console.error(JSON.stringify({ at: "qbo_token", status: res.status, intuit_tid: tid, body: txt.slice(0, 300) }));
    // invalid_grant = refresh token expired/revoked (or code reused): the customer must reconnect. Never retried.
    if (res.status === 400 && /invalid_grant/.test(txt)) throw new QboAuthError("QuickBooks authorization expired — reconnect needed", "invalid_grant");
    throw new Error(`QBO token ${res.status} [intuit_tid ${tid}]: ${txt.slice(0, 300)}`);
  }
  const j = await res.json();
  const now = Date.now();
  return {
    access_token: j.access_token, refresh_token: j.refresh_token,
    access_expires_at: new Date(now + (Number(j.expires_in) - 60) * 1000).toISOString(),
    refresh_expires_at: new Date(now + Number(j.x_refresh_token_expires_in) * 1000).toISOString(),
  };
}
export const exchangeCode = (app: QboApp, code: string) => tokenRequest(app, { grant_type: "authorization_code", code, redirect_uri: app.redirectUri });
export const refreshTokens = (app: QboApp, refresh_token: string) => tokenRequest(app, { grant_type: "refresh_token", refresh_token });

export async function revoke(app: QboApp, token: string) {
  await fetch(QBO_REVOKE, { method: "POST", headers: { Authorization: "Basic " + btoa(`${app.clientId}:${app.clientSecret}`), "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
}

// 401 = access token expired mid-run: caller refreshes (see withAuth) and retries once. 429/5xx retried with backoff.
export async function query(env: string, realmId: string, accessToken: string, q: string, attempt = 0): Promise<any> {
  const url = `${apiBase(env)}/v3/company/${realmId}/query?query=${encodeURIComponent(q)}&minorversion=${MINOR}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  if ((res.status === 429 || res.status >= 500) && attempt < 3) { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); return query(env, realmId, accessToken, q, attempt + 1); }
  const tid = res.headers.get("intuit_tid") || "";
  if (res.status === 401) { console.error(JSON.stringify({ at: "qbo_query", status: 401, intuit_tid: tid, q: q.slice(0, 80) })); throw new QboAuthError(`access token rejected [intuit_tid ${tid}]`, "unauthorized"); }
  if (!res.ok) { const body = (await res.text()).slice(0, 500); console.error(JSON.stringify({ at: "qbo_query", status: res.status, intuit_tid: tid, q: q.slice(0, 80), body })); throw new Error(`QBO ${res.status} [intuit_tid ${tid}] ${q.slice(0, 60)}: ${body.slice(0, 300)}`); }
  const j = await res.json();
  return j.QueryResponse || {};
}

// Runs fn with a valid access token: refreshes when within 2 min of expiry, and once more if the API still answers 401.
export async function withAuth<T>(app: QboApp, tokens: QboTokens, save: (t: QboTokens) => Promise<void>, fn: (accessToken: string) => Promise<T>): Promise<T> {
  let t = tokens;
  if (new Date(t.access_expires_at).getTime() < Date.now() + 120_000) { t = await refreshTokens(app, t.refresh_token); await save(t); }
  try { return await fn(t.access_token); }
  catch (e) {
    if (e instanceof QboAuthError && e.code === "unauthorized") { t = await refreshTokens(app, t.refresh_token); await save(t); return await fn(t.access_token); }
    throw e;
  }
}

// Page through an entity changed after `since` (ISO) — or everything when since is null.
export async function* iterEntity(env: string, realmId: string, token: string, entity: string, since: string | null) {
  const where = since ? ` WHERE MetaData.LastUpdatedTime > '${since}'` : "";
  for (let start = 1; ; start += 1000) {
    const r = await query(env, realmId, token, `SELECT * FROM ${entity}${where} ORDERBY MetaData.LastUpdatedTime STARTPOSITION ${start} MAXRESULTS 1000`);
    const list: any[] = r[entity] || [];
    for (const x of list) yield x;
    if (list.length < 1000) return;
  }
}

export const digits10 = (p?: string | null) => { const d = String(p || "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : d || null; };

export function customerPhones(c: any): string[] {
  return [c.PrimaryPhone?.FreeFormNumber, c.Mobile?.FreeFormNumber, c.AlternatePhone?.FreeFormNumber].map(digits10).filter(Boolean) as string[];
}
export function customerEmail(c: any): string | null { return (c.PrimaryEmailAddr?.Address || "").toLowerCase() || null; }

export function mapEstimate(x: any, storeId: string) {
  return {
    store_id: storeId, qb_estimate_id: String(x.Id), doc_number: x.DocNumber || null,
    qb_customer_id: x.CustomerRef?.value ? String(x.CustomerRef.value) : null, customer_name: x.CustomerRef?.name || null,
    total: Number(x.TotalAmt ?? 0), status: x.TxnStatus || null, txn_date: x.TxnDate || null, expiry_date: x.ExpirationDate || null,
    accepted_at: x.AcceptedDate ? new Date(x.AcceptedDate).toISOString() : null,
    raw: { lines: (x.Line || []).filter((l: any) => l.DetailType === "SalesItemLineDetail").map((l: any) => ({ d: l.Description, a: l.Amount })), email: x.EmailStatus, last: x.MetaData?.LastUpdatedTime },
  };
}
export function mapInvoice(x: any, storeId: string) {
  return {
    store_id: storeId, qb_invoice_id: String(x.Id), doc_number: x.DocNumber || null,
    qb_customer_id: x.CustomerRef?.value ? String(x.CustomerRef.value) : null, customer_name: x.CustomerRef?.name || null,
    total: Number(x.TotalAmt ?? 0), balance: Number(x.Balance ?? 0), txn_date: x.TxnDate || null, due_date: x.DueDate || null,
    raw: { last: x.MetaData?.LastUpdatedTime, email: x.EmailStatus },
  };
}
export function mapPayment(x: any, storeId: string) {
  return {
    store_id: storeId, qb_payment_id: String(x.Id),
    qb_customer_id: x.CustomerRef?.value ? String(x.CustomerRef.value) : null, customer_name: x.CustomerRef?.name || null,
    amount: Number(x.TotalAmt ?? 0), txn_date: x.TxnDate || null, method: x.PaymentMethodRef?.name || null,
    raw: { last: x.MetaData?.LastUpdatedTime, applied: (x.Line || []).map((l: any) => (l.LinkedTxn || []).map((t: any) => `${t.TxnType}:${t.TxnId}`)).flat() },
  };
}
