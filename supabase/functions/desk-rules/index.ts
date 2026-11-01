// desk-rules: turns lead state into tasks. Runs every minute (cron) or on demand. POST { store_id? }.
// Rules decide the step; no model here. Idempotent via tasks.rule_key.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

type Settings = { timezone: string; hours: { weekday: [string, string]; weekend: [string, string] }; sla_first_call_min: number; cadence: { calls_per_day: number; days: number; text_after_miss: boolean }; estimate_chase_days: number[]; untouched_hours: number; focus_time: string; eod_time: string; nurture_days?: number };
const DEFAULTS: Settings = { timezone: "America/Edmonton", hours: { weekday: ["08:30", "16:30"], weekend: ["10:00", "16:30"] }, sla_first_call_min: 5, cadence: { calls_per_day: 2, days: 3, text_after_miss: true }, estimate_chase_days: [1, 3, 7, 14], untouched_hours: 48, focus_time: "08:30", eod_time: "16:15", nurture_days: 30 };

const SCRIPT_FIRST = [
  "“Tell me a bit more about what you need, so I can see if we can help.”",
  "“What’s got you doing this now?” — that’s the intent.",
  "“How long have you been thinking about it — and how soon do you want it done?”",
  "“Have you talked to anyone else yet?” If yes: “How did that go?”",
  "“Do you know exactly which product you want, so I can price it?” (they won’t)",
  "“Let me book you a consult with our advisor to speed this up — {slot1} or {slot2}?”",
];
const SCRIPT_LAST = "Before you hang up: sqft, address, ask for 5–10 photos, get the “100% I’ll be there.”";
const scriptFirst = (T: { twoSlots: () => string }) => { const [a, b] = T.twoSlots().split(" or "); return SCRIPT_FIRST.map((l) => l.replace("{slot1}", a).replace("{slot2}", b)); };

Deno.serve(async (req) => {
  if (!(await authorized(req))) return new Response("unauthorized", { status: 401 });
  const body = await req.json().catch(() => ({}));
  const q = db.from("desk_settings").select("store_id, settings");
  const { data: stores } = body.store_id ? await q.eq("store_id", body.store_id) : await q;
  const out: any[] = [];
  for (const s of stores || []) out.push(await runStore(s.store_id, { ...DEFAULTS, ...(s.settings || {}) }));
  return new Response(JSON.stringify({ ok: true, stores: out }), { headers: { "Content-Type": "application/json" } });
});

async function runStore(storeId: string, S: Settings) {
  const now = new Date();
  const T = tz(S.timezone);
  const made: Record<string, number> = {};
  const add = async (t: any) => {
    if (t.rule_key) {
      const q = db.from("tasks").select("id").eq("store_id", storeId).eq("rule_key", t.rule_key);
      const { data } = await (t.lead_id ? q.eq("lead_id", t.lead_id) : q.is("lead_id", null)).limit(1);
      if (data && data.length) return;
    }
    // anything more than a day overdue is due now: the queue orders by due time and old backlog should not bury today's leads
    if (new Date(t.due_at).getTime() < now.getTime() - 86400_000) t.due_at = now.toISOString();
    const { error } = await db.from("tasks").insert({ store_id: storeId, created_by: "rule", ...t });
    if (error) { if (!String(error.message).includes("duplicate")) console.error(error.message); return; }
    made[t.kind] = (made[t.kind] || 0) + 1;
    if (t.lead_id) openByLead.set(t.lead_id, [...(openByLead.get(t.lead_id) || []), { kind: t.kind, due_at: t.due_at, rule_key: t.rule_key }]);
  };
  const { data: leads } = await db.from("leads").select("*").eq("store_id", storeId).in("stage", ["new", "working", "reached", "consult_booked", "consult_done", "home_booked", "home_done", "estimate_sent", "nurture"]);
  const { data: openTasks } = await db.from("tasks").select("id, lead_id, kind, rule_key, due_at").eq("store_id", storeId).eq("status", "open");
  const openByLead = new Map<string, any[]>();
  for (const t of openTasks || []) if (t.lead_id) openByLead.set(t.lead_id, [...(openByLead.get(t.lead_id) || []), t]);

  for (const L of leads || []) {
    const first = L.first_name || "them";
    const hasOpen = (k: string) => (openByLead.get(L.id) || []).some((t) => t.kind === k);
    const anyOpenDue = () => (openByLead.get(L.id) || []).some((t) => new Date(t.due_at) <= now);
    const created = new Date(L.created_at); const lastTouch = L.last_touch_at ? new Date(L.last_touch_at) : null;

    // 1. first call, inside the SLA (or at opening if it came in after hours)
    if (L.stage === "new" && !L.last_touch_at && !hasOpen("call")) {
      const due = T.isOpen(created) ? new Date(created.getTime() + S.sla_first_call_min * 60_000) : T.nextOpen(created);
      await add({ lead_id: L.id, kind: "call", rule_key: "first_call", title: `Call ${first}.`, say: saySummary(L, "new"), script: { lines: scriptFirst(T), last: SCRIPT_LAST }, due_at: due.toISOString() });
      continue;
    }
    // 2. cadence while Working
    if (L.stage === "working") {
      const maxTries = S.cadence.calls_per_day * S.cadence.days;
      if (L.attempts >= maxTries) {
        const until = new Date(now.getTime() + (S.nurture_days || 30) * 86400_000);
        await db.from("leads").update({ stage: "nurture", stage_changed_at: now.toISOString(), nurture_until: until.toISOString().slice(0, 10) }).eq("id", L.id);
        await db.from("lead_events").insert({ store_id: storeId, lead_id: L.id, kind: "stage", body: `working → nurture (${maxTries} tries, no answer)`, meta: { from: "working", to: "nurture", by: "rule" } });
        made["to_nurture"] = (made["to_nurture"] || 0) + 1;
        continue;
      }
      // text after a missed call, once per miss
      if (S.cadence.text_after_miss) {
        const { data: ev } = await db.from("lead_events").select("id, kind, direction, at, meta").eq("lead_id", L.id).order("at", { ascending: false }).limit(1);
        const last = ev?.[0];
        if (last && last.kind === "call" && last.direction === "out" && !last.meta?.connected && !hasOpen("text")) {
          await add({ lead_id: L.id, kind: "text", rule_key: `text_after_miss_${last.id}`, title: `Text ${first}.`, say: `No answer just now (try ${L.attempts} of ${maxTries}). Send this, or change it first.`, draft: draftNoAnswer(L), due_at: now.toISOString() });
        }
      }
      if (!hasOpen("call")) {
        const gapH = Math.max(2, Math.floor(T.openHours() / S.cadence.calls_per_day));
        const base = lastTouch || created;
        let due = new Date(base.getTime() + gapH * 3600_000);
        if (!T.isOpen(due)) due = T.nextOpen(due);
        await add({ lead_id: L.id, kind: "call", rule_key: `cadence_${L.attempts + 1}`, title: `Call ${first}.`, say: saySummary(L, "working", `Try ${L.attempts + 1} of ${maxTries}.`), script: { lines: scriptFirst(T), last: SCRIPT_LAST }, due_at: due.toISOString() });
      }
    }
    // 3. reached but nothing booked → offer two slots by text within the hour
    if (L.stage === "reached" && !hasOpen("text") && !hasOpen("call")) {
      const base = lastTouch || created;
      if (now.getTime() - base.getTime() > 60 * 60_000) await add({ lead_id: L.id, kind: "text", rule_key: `two_slots_${dayKey(base, S.timezone)}`, title: `Text ${first} two consult times.`, say: "You reached them but nothing got booked. Two choices, not one.", draft: `Hi ${first}, it’s Floor & More. Want me to hold a 45-minute spot so you can see the options in person? ${T.twoSlots()} both work.`, due_at: now.toISOString() });
    }
    // 4. nurture wake-up
    if (L.stage === "nurture" && L.nurture_until && new Date(L.nurture_until + "T12:00:00Z") <= now) {
      await db.from("leads").update({ stage: "working", stage_changed_at: now.toISOString(), attempts: 0, nurture_until: null }).eq("id", L.id);
      await db.from("lead_events").insert({ store_id: storeId, lead_id: L.id, kind: "stage", body: "nurture → working (date reached)", meta: { from: "nurture", to: "working", by: "rule" } });
      await add({ lead_id: L.id, kind: "call", rule_key: `nurture_wake_${dayKey(now, S.timezone)}`, title: `Call ${first} — they’re back.`, say: saySummary(L, "nurture"), script: { lines: scriptFirst(T), last: SCRIPT_LAST }, due_at: T.isOpen(now) ? now.toISOString() : T.nextOpen(now).toISOString() });
    }
    // 5. untouched for 48 h (anything still in play)
    if (["new", "working", "reached", "consult_done", "home_done"].includes(L.stage)) {
      const ref = lastTouch || created;
      if (now.getTime() - ref.getTime() > S.untouched_hours * 3600_000 && !hasOpen("untouched") && !hasOpen("call") && !hasOpen("text") && !anyOpenDue()) {
        await add({ lead_id: L.id, kind: "untouched", rule_key: `untouched_${dayKey(now, S.timezone)}`, title: `Call ${first} — nobody has touched this in ${Math.floor((now.getTime() - ref.getTime()) / 3600_000)} hours.`, say: saySummary(L, "untouched"), script: { lines: scriptFirst(T), last: SCRIPT_LAST }, due_at: now.toISOString() });
      }
    }
    // 6. estimate chase on days 1/3/7/14 after it went out; the latest due step wins
    if (L.stage === "estimate_sent" && !hasOpen("chase")) {
      const { data: est } = await db.from("estimates").select("id, doc_number, total, txn_date, created_at").eq("lead_id", L.id).order("txn_date", { ascending: false }).limit(1);
      const e = est?.[0];
      const sent = e ? new Date((e.txn_date || String(e.created_at).slice(0, 10)) + "T17:00:00Z") : new Date(L.stage_changed_at);
      const days = Math.floor((now.getTime() - sent.getTime()) / 86400_000);
      const step = Math.max(-1, ...S.estimate_chase_days.filter((d) => d <= days));
      if (step >= 0) {
        const due = T.at(new Date(sent.getTime() + step * 86400_000), "10:00");
        await add({ lead_id: L.id, kind: "chase", rule_key: `chase_${e?.id || "x"}_${step}`, title: `Call ${first} about the estimate.`, say: `Estimate${e ? ` ${e.doc_number || ""} for $${Number(e.total).toLocaleString()}` : ""} went out ${days} day${days === 1 ? "" : "s"} ago. Ask for the deposit date, not for a yes or no.`, script: { lines: ["“Did you get a chance to go over the estimate?”", "“What would it take to get this on the calendar?”", "“The 50% deposit holds your dates — e-transfer today, or come by the store?”"] }, due_at: (due < now ? now : due).toISOString() });
      }
    }
  }

  // 7. appointments: confirm consults, brief home visits, mockup after consult, rebook no-shows
  const soon = new Date(now.getTime() + 48 * 3600_000);
  const { data: appts } = await db.from("appointments").select("*, leads!inner(first_name, last_name, service, sqft, address, est_value, notes)").eq("store_id", storeId).in("status", ["booked", "confirmed", "showed", "no_show"]).gte("starts_at", new Date(now.getTime() - 7 * 86400_000).toISOString()).lte("starts_at", soon.toISOString());
  for (const a of appts || []) {
    const first = a.leads?.first_name || "them"; const start = new Date(a.starts_at);
    const dayBefore = new Date(start.getTime() - 86400_000);
    if (a.status === "booked" && start > now) {
      if (a.kind === "consult") await add({ lead_id: a.lead_id, kind: "confirm", rule_key: `confirm_${a.id}`, title: `Call ${first} to confirm ${T.when(start)}.`, say: `Consult ${T.when(start)}. Confirm they’re coming and ask if they took the photos.`, script: { lines: [`“Hi ${first}, Floor & More — still good for ${T.when(start)}?”`, "“Did you get a chance to take those photos? Even five helps.”", "“Bring the room sizes if you have them.”"] }, due_at: T.at(dayBefore, "16:00").toISOString() });
      else await add({ lead_id: a.lead_id, kind: "brief", rule_key: `brief_${a.id}`, title: `Call ${first}, then brief ${a.assignee_name || "the visit team"}.`, say: `Home visit ${T.when(start)} with ${a.assignee_name || "the visit team"}. Confirm ${first}, then send the brief: ${[a.leads?.service, a.leads?.sqft ? `${a.leads.sqft} sqft` : null, a.leads?.address].filter(Boolean).join(", ")}.`, due_at: T.at(dayBefore, "15:00").toISOString() });
    }
    if (a.kind === "consult" && a.status === "showed") {
      const { data: mock } = await db.from("lead_events").select("id").eq("lead_id", a.lead_id).eq("kind", "mockup").gte("at", a.starts_at).limit(1);
      if (!mock?.length) await add({ lead_id: a.lead_id, kind: "mockup", rule_key: `mockup_${a.id}`, title: `Send ${first} the mockup.`, say: "They picked options in the store. Make the mockup, text it, and book the home visit while they’re excited.", due_at: new Date(start.getTime() + 60 * 60_000).toISOString() });
    }
    if (a.status === "no_show") await add({ lead_id: a.lead_id, kind: "rebook", rule_key: `rebook_${a.id}`, title: `Call ${first} — missed ${T.when(start)}.`, say: "No judgement on the phone. Offer two new times.", script: { lines: [`“Hi ${first}, we had you down for ${T.when(start)} — everything OK?”`, `“Let’s grab another time: ${T.twoSlots()}?”`] }, due_at: new Date(start.getTime() + 30 * 60_000).toISOString() });
  }

  // 8. daily focus / EOD
  if (T.isBusinessDay(now)) {
    const dk = dayKey(now, S.timezone);
    await add({ kind: "focus", rule_key: `focus_${dk}`, title: "Morning focus.", say: "Pick your top three for today. Five minutes. It goes to Slack so the owners see it.", due_at: T.at(now, S.focus_time).toISOString() });
    await add({ kind: "eod", rule_key: `eod_${dk}`, title: "End of day.", say: "Numbers are pre-filled. Two lines: what worked, what got stuck.", due_at: T.at(now, S.eod_time).toISOString() });
  }
  return { store_id: storeId, made };
}

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

// ---------- helpers ----------
function saySummary(L: any, ctx: string, extra?: string) {
  const ago = agoText(L.created_at);
  const src: Record<string, string> = { meta: "the Meta ad", google: "Google", web: "the website", walkin: "a walk-in", phone: "a phone call", quickbooks: "QuickBooks", unknown: "an unknown source" };
  const bits = [L.service, L.sqft ? `${L.sqft} sqft` : null, L.timeline ? `timeline: ${L.timeline}` : null, L.address].filter(Boolean).join(", ");
  const lead = ctx === "new" ? `New lead, ${ago}, from ${src[L.source] || L.source}.` : ctx === "nurture" ? `Parked a month ago, came in from ${src[L.source] || L.source}.` : ctx === "untouched" ? `Came in ${ago} from ${src[L.source] || L.source}. Open with the apology.` : `From ${src[L.source] || L.source}, ${ago}.`;
  return [lead, bits ? bits + "." : null, L.notes ? L.notes.split("\n")[0] : null, extra].filter(Boolean).join(" ");
}
function draftNoAnswer(L: any) { return `Hi ${L.first_name || "there"}, it’s Floor & More — tried calling about the ${(L.service || "flooring").toLowerCase()}. Want me to hold a 45-minute spot this week so you can see the options in person? Reply with a day that works.`; }
function agoText(iso: string) { const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000); if (m < 60) return `${m} min ago`; const h = Math.floor(m / 60); if (h < 36) return `${h} h ago`; return `${Math.floor(h / 24)} days ago`; }
function dayKey(d: Date, tzName: string) { return new Intl.DateTimeFormat("en-CA", { timeZone: tzName, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }

function tz(name: string) {
  const parts = (d: Date) => { const f = new Intl.DateTimeFormat("en-CA", { timeZone: name, hour12: false, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d); const g = (t: string) => f.find((p) => p.type === t)?.value || ""; return { wd: g("weekday"), y: g("year"), m: g("month"), d: g("day"), h: Number(g("hour")) % 24, mi: Number(g("minute")) }; };
  const offsetMs = (d: Date) => { const p = parts(d); const asUtc = Date.UTC(Number(p.y), Number(p.m) - 1, Number(p.d), p.h, p.mi); return asUtc - Math.floor(d.getTime() / 60_000) * 60_000; };
  const hoursFor = (wd: string) => (wd === "Sat" || wd === "Sun") ? ["10:00", "16:30"] : ["08:30", "16:30"];
  const hm = (s: string) => s.split(":").map(Number);
  const at = (d: Date, hhmm: string) => { const p = parts(d); const [h, m] = hm(hhmm); const local = Date.UTC(Number(p.y), Number(p.m) - 1, Number(p.d), h, m); return new Date(local - offsetMs(d)); };
  const isOpen = (d: Date) => { const p = parts(d); const [o, c] = hoursFor(p.wd); const cur = p.h * 60 + p.mi; const [oh, om] = hm(o); const [ch, cm] = hm(c); return cur >= oh * 60 + om && cur < ch * 60 + cm; };
  const nextOpen = (d: Date) => { for (let i = 0; i < 8; i++) { const day = new Date(d.getTime() + i * 86400_000); const p = parts(day); const [o] = hoursFor(p.wd); const openAt = at(day, o); if (openAt > d) return openAt; } return d; };
  const when = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: name, weekday: "short", hour: "numeric", minute: "2-digit" }).format(d).replace(",", "");
  const twoSlots = () => { const d1 = new Date(Date.now() + 2 * 86400_000), d2 = new Date(Date.now() + 3 * 86400_000); return `${new Intl.DateTimeFormat("en-CA", { timeZone: name, weekday: "short" }).format(d1)} 10:30 or ${new Intl.DateTimeFormat("en-CA", { timeZone: name, weekday: "short" }).format(d2)} 1:00`; };
  const openHours = () => 8;
  const isBusinessDay = (_d: Date) => true;
  return { at, isOpen, nextOpen, when, twoSlots, openHours, isBusinessDay };
}
