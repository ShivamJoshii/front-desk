// GHL (LeadConnector) API v2 client + mappers. Pure: no Deno/Supabase imports so it can be unit-tested in Node.
export const GHL_BASE = "https://services.leadconnectorhq.com";
export const GHL_VERSION = "2021-07-28";

export type GhlClient = { token: string; locationId: string; fetchImpl?: typeof fetch };

async function req(c: GhlClient, path: string, init: RequestInit = {}, attempt = 0): Promise<any> {
  const f = c.fetchImpl ?? fetch;
  const res = await f(GHL_BASE + path, {
    ...init,
    headers: { Authorization: `Bearer ${c.token}`, Version: GHL_VERSION, Accept: "application/json", ...(init.headers || {}) },
  });
  if (res.status === 429 && attempt < 4) { await sleep(1200 * (attempt + 1)); return req(c, path, init, attempt + 1); }
  if (!res.ok) throw new Error(`GHL ${res.status} ${path}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- contacts ----------
export async function* iterContacts(c: GhlClient, opts: { pageSize?: number; updatedAfter?: string } = {}) {
  // Contacts list is ordered by dateAdded desc with startAfter/startAfterId cursors. For incremental runs we use search sorted by dateUpdated.
  if (opts.updatedAfter) {
    let page = 1;
    for (;;) {
      const body = {
        locationId: c.locationId, page, pageLimit: opts.pageSize ?? 100,
        sort: [{ field: "dateUpdated", direction: "desc" }],
        filters: [{ field: "dateUpdated", operator: "range", value: { gt: opts.updatedAfter } }],
      };
      const d = await req(c, `/contacts/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const list: any[] = d.contacts ?? [];
      for (const x of list) yield x;
      if (list.length < (opts.pageSize ?? 100)) return;
      page++;
      await sleep(150);
    }
  }
  let url = `/contacts/?locationId=${c.locationId}&limit=${opts.pageSize ?? 100}`;
  for (;;) {
    const d = await req(c, url);
    const list: any[] = d.contacts ?? [];
    for (const x of list) yield x;
    const m = d.meta || {};
    if (!m.startAfterId || list.length === 0) return;
    url = `/contacts/?locationId=${c.locationId}&limit=${opts.pageSize ?? 100}&startAfter=${m.startAfter}&startAfterId=${m.startAfterId}`;
    await sleep(150);
  }
}

export async function getCustomFieldDefs(c: GhlClient): Promise<Record<string, string>> {
  const d = await req(c, `/locations/${c.locationId}/customFields`);
  const out: Record<string, string> = {};
  for (const f of d.customFields ?? []) out[f.id] = String(f.name || "").toLowerCase();
  return out;
}

const TAG_STAGE: [string, string][] = [
  ["deal won", "won"], ["job-started", "won"], ["paid", "won"], ["invoice-open", "won"], ["collect-payment", "won"],
  ["deal lost", "lost"], ["estimate-accepted", "estimate_sent"], ["estimate-sent", "estimate_sent"],
  ["visited-store", "consult_done"], ["store-visit-booked", "consult_booked"],
];

export function mapContact(x: any, storeId: string, fieldNames: Record<string, string>) {
  const tags: string[] = (x.tags || []).map((t: string) => String(t).toLowerCase());
  const cf: Record<string, string> = {};
  for (const f of x.customFields || []) { const n = fieldNames[f.id] || f.id; cf[n] = typeof f.value === "string" ? f.value : JSON.stringify(f.value); }
  const src = sourceOf(x, tags);
  let stage = "new";
  for (const [t, s] of TAG_STAGE) if (tags.includes(t)) { stage = s; break; }
  if (stage === "new" && (x.type === "customer" || src.source === "quickbooks")) stage = "customer";
  if (stage === "won") stage = "customer"; // historical wins are customers now
  const sqft = cf["sqft"] ?? cf["sqft2"];
  return {
    store_id: storeId,
    ghl_contact_id: x.id,
    first_name: x.firstName || x.firstNameRaw || null,
    last_name: x.lastName || x.lastNameRaw || null,
    phone: x.phone || null,
    email: x.email || null,
    source: src.source,
    source_detail: src.detail,
    stage,
    service: cf["job-type"] || null,
    timeline: cf["timeline"] || null,
    sqft: sqft && /^[0-9.,]+$/.test(sqft.replace(/,/g, "")) ? Number(sqft.replace(/,/g, "")) : null,
    notes: [cf["message"], sqft && !/^[0-9.,]+$/.test(sqft.replace(/,/g, "")) ? `sqft: ${sqft}` : null, cf["owner?"] ? `owner: ${cf["owner?"]}` : null].filter(Boolean).join("\n") || null,
    ghl_raw: { tags: x.tags || [], type: x.type, assignedTo: x.assignedTo, dateUpdated: x.dateUpdated, customFields: cf, attributions: (x.attributions || []).slice(0, 2) },
    created_at: x.dateAdded || new Date().toISOString(),
  };
}

function sourceOf(x: any, tags: string[]) {
  const s = String(x.source || "").toLowerCase();
  const a = (x.attributions || [])[0] || {};
  if (tags.includes("src-meta") || /facebook|instagram|meta/.test(s) || /facebook|instagram/.test(String(a.utmSessionSource || "").toLowerCase())) return { source: "meta", detail: x.source || a.utmSessionSource || null };
  if (tags.includes("src-web") || s === "external_form" || s.includes("form") || s.includes("website")) {
    const paid = /paid search|google/.test(String(a.utmSessionSource || "").toLowerCase()) || !!a.utmGclid;
    return { source: paid ? "google" : "web", detail: a.pageUrl ? String(a.pageUrl).split("?")[0] : x.source || null };
  }
  if (tags.includes("src-walkin") || s.includes("walk")) return { source: "walkin", detail: null };
  if (tags.includes("src-phone") || s.includes("call") || s.includes("phone")) return { source: "phone", detail: null };
  if (s.includes("quickbooks") || s.includes("qb") || tags.includes("quickbooks")) return { source: "quickbooks", detail: null };
  if (s) return { source: s.slice(0, 40), detail: null };
  return { source: "unknown", detail: null };
}

// ---------- conversations / messages ----------
export async function* iterConversations(c: GhlClient, opts: { afterMs?: number; pageSize?: number; startAfterMs?: number } = {}) {
  let startAfterDate: number | undefined = opts.startAfterMs;
  for (;;) {
    const qs = new URLSearchParams({ locationId: c.locationId, limit: String(opts.pageSize ?? 20), sortBy: "last_message_date", sort: "desc" });
    if (startAfterDate) qs.set("startAfterDate", String(startAfterDate));
    const d = await req(c, `/conversations/search?${qs}`);
    const list: any[] = d.conversations ?? [];
    if (!list.length) return;
    for (const cv of list) {
      if (opts.afterMs && Number(cv.lastMessageDate || 0) <= opts.afterMs) return;
      yield cv;
    }
    startAfterDate = Number(list[list.length - 1].lastMessageDate);
    if (list.length < (opts.pageSize ?? 20)) return;
    await sleep(150);
  }
}

export async function fetchMessages(c: GhlClient, conversationId: string, opts: { afterMs?: number; max?: number } = {}) {
  const out: any[] = [];
  let lastMessageId: string | undefined;
  for (;;) {
    const qs = new URLSearchParams({ limit: "100" });
    if (lastMessageId) qs.set("lastMessageId", lastMessageId);
    const d = await req(c, `/conversations/${conversationId}/messages?${qs}`);
    const m = d.messages || {};
    const list: any[] = m.messages ?? [];
    for (const x of list) {
      if (opts.afterMs && Date.parse(x.dateAdded) <= opts.afterMs) return out;
      out.push(x);
      if (opts.max && out.length >= opts.max) return out;
    }
    if (!m.nextPage || !list.length) return out;
    lastMessageId = m.lastMessageId || list[list.length - 1].id;
    await sleep(120);
  }
}

export function mapMessage(x: any, storeId: string, leadId: string | null, conversation: any) {
  const t = String(x.messageType || "");
  const dir = x.direction === "inbound" ? "in" : x.direction === "outbound" ? "out" : null;
  let kind: string | null = null;
  let body: string | null = x.body ?? null;
  const meta: any = { ghl_type: x.type, messageType: t, status: x.status, userId: x.userId, source: x.source, conversationId: conversation?.id };
  if (t === "TYPE_SMS" || t === "TYPE_CUSTOM_SMS" || t === "TYPE_CUSTOM_PROVIDER_SMS") kind = dir === "in" ? "sms_in" : "sms_out";
  else if (t === "TYPE_FACEBOOK" || t === "TYPE_INSTAGRAM" || t === "TYPE_WHATSAPP" || t === "TYPE_WEBCHAT" || t === "TYPE_LIVE_CHAT" || t === "TYPE_GMB") { kind = dir === "in" ? "sms_in" : "sms_out"; meta.channel = t.replace("TYPE_", "").toLowerCase(); }
  else if (t === "TYPE_EMAIL" || t === "TYPE_CUSTOM_EMAIL" || t === "TYPE_CUSTOM_PROVIDER_EMAIL") { kind = dir === "in" ? "email_in" : "email_out"; body = x.subject ? `${x.subject}\n${x.body ?? ""}`.trim() : body; }
  else if (t === "TYPE_CALL" || t === "TYPE_IVR_CALL" || t === "TYPE_CAMPAIGN_CALL" || t === "TYPE_CAMPAIGN_MANUAL_CALL") {
    const call = (x.meta && x.meta.call) || {};
    const dur = Number(call.duration ?? 0);
    const st = String(call.status || x.status || "");
    kind = st === "voicemail" || (dir === "in" && st === "no-answer") ? "voicemail" : "call";
    meta.call_status = st; meta.connected = st === "completed" && dur >= 60;
    body = `${dir === "out" ? "Outbound" : "Inbound"} call · ${st}${dur ? ` · ${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, "0")}` : ""}`;
    return { store_id: storeId, lead_id: leadId, kind, at: x.dateAdded, direction: dir, body, duration_s: dur || null, ghl_message_id: x.id, meta,
      recording_url: st === "completed" && dur > 0 ? `ghl://recording/${x.id}` : null }; // resolved by the recording proxy: /conversations/messages/{id}/locations/{loc}/recording
  }
  if (typeof body === "string" && body.startsWith("Front Desk ·")) { kind = "note"; meta.mirror = true; body = body.replace(/^Front Desk · [^:]+: /, ""); }
  else if (t.startsWith("TYPE_ACTIVITY")) { kind = "note"; body = body || t.replace("TYPE_ACTIVITY_", "activity: ").toLowerCase(); }
  else if (t === "TYPE_SMS_REVIEW_REQUEST" || t === "TYPE_REVIEW") { kind = "note"; body = body || t.toLowerCase(); }
  if (!kind) { kind = "note"; body = body || `(${t || x.type})`; }
  return { store_id: storeId, lead_id: leadId, kind, at: x.dateAdded, direction: dir, body, duration_s: null, ghl_message_id: x.id, meta, recording_url: null };
}

// ---------- calendar ----------
export async function fetchCalendarEvents(c: GhlClient, startMs: number, endMs: number) {
  const d = await req(c, `/calendars/events?locationId=${c.locationId}&startTime=${startMs}&endTime=${endMs}`);
  return (d.events ?? []) as any[];
}
export async function listCalendars(c: GhlClient) { const d = await req(c, `/calendars/?locationId=${c.locationId}`); return (d.calendars ?? []) as any[]; }
export async function listUsers(c: GhlClient) { const d = await req(c, `/users/?locationId=${c.locationId}`); return (d.users ?? []) as any[]; }

// ---------- derived lead state from events ----------
export function deriveFromEvents(lead: { stage: string }, events: { kind: string; direction: string | null; at: string; meta?: any }[]) {
  const outCalls = events.filter((e) => e.kind === "call" && e.direction === "out");
  const connected = events.some((e) => e.kind === "call" && e.meta?.connected);
  const inboundReply = events.some((e) => e.kind === "sms_in") && events.some((e) => e.kind === "sms_out");
  const touches = events.filter((e) => e.direction === "out");
  const last = touches.length ? touches.map((e) => e.at).sort().at(-1)! : null;
  let stage = lead.stage;
  if (stage === "new" && (outCalls.length || touches.length)) stage = "working";
  if ((stage === "new" || stage === "working") && (connected || inboundReply)) stage = "reached";
  return { attempts: outCalls.length, last_touch_at: last, stage };
}
