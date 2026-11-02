(function () {
  // ---------- config ----------
  var SUPABASE_URL = "https://rzaptykiirntegysuulr.supabase.co";
  var ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ6YXB0eWtpaXJudGVneXN1dWxyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMzMDQ4NjcsImV4cCI6MjEwODg4MDg2N30.dI3ktu_eZa_35WvxKurbSl9l90u2NAI0_xxyhTqQY6c";
  var FN = SUPABASE_URL + "/functions/v1";
  var FLOOR_SWAP = "https://floor-swap-app.netlify.app";
  var RECOVERY = /type=recovery/.test(location.hash);
  var AUTH_ERR = (location.hash.match(/error_description=([^&]+)/) || [])[1];
  var sb = supabase.createClient(SUPABASE_URL, ANON_KEY);

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"); };
  var S = { user: null, store: null, storeName: "", role: "staff", deskRole: null, myName: "", members: [], settings: {}, tz: "America/Edmonton", ghlLocation: null, tasks: [], current: null, view: "today", leadsCache: null };
  var VIEWS = ["today", "leads", "board", "owners", "settings"];

  // ---------- small utils ----------
  var tt; function toast(m, intent) { var t = $("#toast"); t.className = "bp6-toast toast show bp6-intent-" + (intent || "success"); $("#toastMsg").textContent = m; clearTimeout(tt); tt = setTimeout(function () { t.classList.remove("show"); }, 3200); }
  function fmtTime(d) { return new Intl.DateTimeFormat("en-CA", { timeZone: S.tz, hour: "numeric", minute: "2-digit" }).format(new Date(d)); }
  function fmtWhen(d) { var x = new Date(d), now = new Date(); var sameDay = dayKey(x) === dayKey(now); return (sameDay ? "" : new Intl.DateTimeFormat("en-CA", { timeZone: S.tz, weekday: "short" }).format(x) + " ") + fmtTime(x); }
  function fmtDate(d) { return new Intl.DateTimeFormat("en-CA", { timeZone: S.tz, weekday: "short", month: "short", day: "numeric" }).format(new Date(d)); }
  function dayKey(d) { return new Intl.DateTimeFormat("en-CA", { timeZone: S.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d)); }
  function ago(iso) { var m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000); if (m < 1) return "just now"; if (m < 60) return m + " min ago"; var h = Math.floor(m / 60); if (h < 36) return h + " h ago"; return Math.floor(h / 24) + " days ago"; }
  function telHref(p) { var d = String(p || "").replace(/\D/g, ""); if (!d) return null; if (d.length === 10) d = "1" + d; return "tel:+" + d; }
  function fullName(l) { return [l.first_name, l.last_name].filter(Boolean).join(" ") || l.phone || "Lead"; }
  function first(l) { return l.first_name || "them"; }
  function startOfWeekISO() { var now = new Date(); var p = new Intl.DateTimeFormat("en-CA", { timeZone: S.tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now); var g = function (t) { return p.find(function (x) { return x.type === t; }).value; }; var map = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }; var back = map[g("weekday")] || 0; var d = new Date(Date.UTC(+g("year"), +g("month") - 1, +g("day") - back, 12)); return d.toISOString().slice(0, 10); }
  function todayISO() { return dayKey(new Date()); }
  function ghlLink(l) { return S.ghlLocation && l.ghl_contact_id ? "https://app.gohighlevel.com/v2/location/" + S.ghlLocation + "/contacts/detail/" + l.ghl_contact_id : null; }
  function srcLabel(s) { return ({ meta: "Meta ad", google: "Google", web: "website", walkin: "walk-in", phone: "phone call", quickbooks: "QuickBooks", unknown: "unknown source" })[s] || s || "unknown"; }
  async function authedFetch(path, body) {
    var sess = (await sb.auth.getSession()).data.session;
    var res = await fetch(FN + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + sess.access_token, apikey: ANON_KEY }, body: JSON.stringify(body || {}) });
    var j = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(j.error || ("HTTP " + res.status));
    return j;
  }

  // ---------- views ----------
  function show(v) {
    S.view = v;
    ["login"].concat(VIEWS).forEach(function (k) { $("#view-" + k).classList.toggle("hidden", k !== v); });
    $$("[data-nav]").forEach(function (b) { b.classList.toggle("bp6-intent-primary", b.dataset.nav === v && b.classList.contains("nav-center")); });
    if (v === "today") loadTasks();
    if (v === "leads") loadLeads();
    if (v === "board") loadBoard();
    if (v === "owners") loadOwners();
    if (v === "settings") loadSettings();
    window.scrollTo(0, 0);
    if (location.hash !== "#" + v) history.replaceState(null, "", "#" + v);
  }
  $$("[data-nav]").forEach(function (b) { b.addEventListener("click", function () { show(b.dataset.nav); }); });
  $("#darkBtn").onclick = function () { document.body.classList.toggle("bp6-dark"); try { localStorage.setItem("fd-dark", document.body.classList.contains("bp6-dark") ? "1" : "0"); } catch (e) {} };
  try { if (localStorage.getItem("fd-dark") === "1") document.body.classList.add("bp6-dark"); } catch (e) {}
  $("#userBtn").onclick = async function () { if (confirm("Sign out?")) { await sb.auth.signOut(); location.reload(); } };

  // ---------- auth ----------
  function loginMsg(m, err) { var el = $("#loginMsg"); el.textContent = m || ""; el.classList.toggle("err", !!err); }
  $("#loginForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var email = $("#loginEmail").value.trim(), pw = $("#loginPass").value;
    if (!email || !pw) { loginMsg("Enter your email and password.", true); return; }
    $("#loginBtn").disabled = true; loginMsg("Signing in…");
    var r = await sb.auth.signInWithPassword({ email: email, password: pw });
    $("#loginBtn").disabled = false;
    if (r.error) { loginMsg(/invalid/i.test(r.error.message) ? "That email and password don’t match." : "Couldn’t sign in: " + r.error.message, true); $("#loginPass").select(); return; }
    loginMsg(""); $("#loginPass").value = "";
    if (!S.user) boot();
  });
  $("#forgotBtn").onclick = async function () {
    var email = $("#loginEmail").value.trim();
    if (!email) { loginMsg("Type your email above, then tap Forgot password.", true); $("#loginEmail").focus(); return; }
    var r = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + "/" });
    loginMsg(r.error ? "Couldn’t send: " + r.error.message : "If that email has an account, a reset link is on its way. An owner can also reset it in Settings → Team.", !!r.error);
  };
  if (AUTH_ERR) loginMsg("That link didn’t work (" + decodeURIComponent(AUTH_ERR.replace(/\+/g, " ")) + "). Sign in with your password, or ask an owner to reset it.", true);

  async function boot() {
    if (booting || S.user) return; booting = true;
    try { await bootInner(); } finally { booting = false; }
  }
  async function bootInner() {
    var path = location.pathname;
    var sess = (await sb.auth.getSession()).data.session;
    if (!sess) { show("login"); return; }
    S.user = sess.user;
    var ok = await loadContext();
    if (!ok) { S.user = null; await sb.auth.signOut(); return; }
    if (RECOVERY) { $("#navRight").style.display = ""; $("#bottombar").style.display = ""; history.replaceState(null, "", "/#settings"); show("settings"); return; }
    $("#navRight").style.display = ""; $("#bottombar").style.display = "";
    if (path.indexOf("/connect/quickbooks") === 0) { location.href = FN + "/qbo-connect?store_id=" + S.store; return; }
    if (path.indexOf("/settings/quickbooks") === 0) { history.replaceState(null, "", "/#settings"); show("settings"); return; }
    var h = (location.hash || "#today").slice(1);
    show(VIEWS.indexOf(h) >= 0 ? h : "today");
    tick();
    setInterval(function () { if (S.view === "today" && !document.hidden) loadTasks(true); }, 60000);
    setInterval(function () { if (S.view === "board" && !document.hidden && !$("#taskDlg").classList.contains("open")) loadBoard(); }, 60000);
    setInterval(tick, 5 * 60000);
  }
  var booting = false;
  sb.auth.onAuthStateChange(function (ev) {
    if (ev === "PASSWORD_RECOVERY") { RECOVERY = true; if (S.user) show("settings"); }
    if (ev === "SIGNED_IN" && !S.user && !booting) setTimeout(boot, 0);
  });

  async function loadContext() {
    try { await sb.rpc("accept_invites"); } catch (e) {}
    var m = await sb.from("store_members").select("store_id, role, desk_role, display_name, stores(name)").eq("user_id", S.user.id);
    var rows = m.data || [];
    if (!rows.length) { show("login"); loginMsg(S.user.email + " isn’t on the team yet. Ask an owner to add you in Settings → Team.", true); return false; }
    var r = rows[0];
    S.store = r.store_id; S.storeName = r.stores ? r.stores.name : ""; S.role = r.role; S.deskRole = r.desk_role; S.myName = r.display_name || "";
    var mm = await sb.from("store_members").select("display_name").eq("store_id", S.store);
    S.members = (mm.data || []).map(function (x) { return x.display_name; }).filter(Boolean);
    $("#storeName").textContent = "· " + S.storeName; $("#userName").textContent = r.display_name || (S.user.email || "").split("@")[0];
    var st2 = await sb.from("desk_settings").select("settings").eq("store_id", S.store).maybeSingle();
    S.settings = (st2.data && st2.data.settings) || {}; S.tz = S.settings.timezone || S.tz;
    var integ = await sb.rpc("desk_integration_status", { p_store: S.store });
    (integ.data || []).forEach(function (i) { if (i.provider === "ghl") S.ghlLocation = i.config && i.config.location_id; });
    return true;
  }
  async function tick() { try { await authedFetch("/desk-tick", { store_id: S.store }); if (S.view === "today") loadTasks(true); } catch (e) { /* background */ } }

  // ---------- TODAY ----------
  var LEAD_COLS = "id, first_name, last_name, phone, email, source, source_detail, service, timeline, sqft, address, notes, stage, attempts, last_touch_at, ghl_contact_id, created_at, est_value, buyer_type, photos_received";
  async function loadTasks(silent) {
    var now = new Date();
    var r = await sb.from("tasks").select("*, leads(" + LEAD_COLS + ")").eq("store_id", S.store).eq("status", "open").order("due_at").limit(300);
    if (r.error) { if (!silent) $("#stage").innerHTML = '<div class="bp6-card card"><p class="say">Could not load tasks: ' + esc(r.error.message) + "</p></div>"; return; }
    S.tasks = r.data || [];
    var doneToday = await sb.from("tasks").select("id", { count: "exact", head: true }).eq("store_id", S.store).eq("status", "done").gte("done_at", new Date(now.getTime() - 24 * 3600000).toISOString());
    var done = doneToday.count || 0;
    var dueNow = S.tasks.filter(function (t) { return new Date(t.due_at) <= now; });
    $("#clock").textContent = fmtDate(now) + " · " + fmtTime(now);
    $("#progressText").textContent = done + " done · " + dueNow.length + " due now";
    var total = done + dueNow.length; $("#progressBar").style.width = (total ? Math.round(done / total * 100) : 0) + "%";
    // pick the card
    var focus = S.tasks.find(function (t) { return t.kind === "focus" && new Date(t.due_at).getTime() - 30 * 60000 <= now.getTime(); });
    var eod = S.tasks.find(function (t) { return t.kind === "eod" && new Date(t.due_at) <= now; });
    var rank = { call: 1, untouched: 1, confirm: 0, brief: 0, rebook: 1, chase: 2, text: 3, mockup: 2, walkin_followup: 1, custom: 4 };
    var pool = dueNow.filter(function (t) { return t.kind !== "focus" && t.kind !== "eod"; }).sort(function (a, b) {
      var na = a.leads && a.leads.stage === "new" ? -1 : 0, nb = b.leads && b.leads.stage === "new" ? -1 : 0;
      if (na !== nb) return na - nb;
      if ((rank[a.kind] || 5) !== (rank[b.kind] || 5)) return (rank[a.kind] || 5) - (rank[b.kind] || 5);
      var la = a.leads && a.leads.last_touch_at ? new Date(a.leads.last_touch_at).getTime() : 0, lb = b.leads && b.leads.last_touch_at ? new Date(b.leads.last_touch_at).getTime() : 0;
      return lb - la;
    });
    var cur = focus || eod || pool[0] || null;
    if (!cur) { var next = S.tasks.filter(function (t) { return new Date(t.due_at) > now; })[0]; renderWait(next); upnext(pool.slice(1), next); return; }
    if (silent && S.current && S.current.id === cur.id) return;
    S.current = cur; render(cur); upnext(pool.filter(function (t) { return t.id !== cur.id; }).slice(0, 3), null);
  }
  function upnext(rest, next) {
    var parts = rest.map(function (t) { return (t.leads ? first(t.leads) : t.title.replace(/\.$/, "")); });
    var html = parts.length ? "Then: " + esc(parts.join(" · ")) : (next ? "Next: " + esc(next.title) + " at " + fmtWhen(next.due_at) : "Nothing else queued.");
    $("#upnext").innerHTML = html + "<br>" + S.tasks.length + " open · <a href='#leads' data-nav='leads'>all leads</a>";
    $$("#upnext [data-nav]").forEach(function (a) { a.onclick = function (e) { e.preventDefault(); show("leads"); }; });
  }
  function renderWait(next) {
    var h = '<div class="tiny"><span class="bp6-tag bp6-intent-success">CLEAR</span><span>' + esc(fmtTime(new Date())) + "</span></div>" +
      '<h1 class="waitcard">Nothing due right now.</h1>' +
      (next ? '<p class="say">Next up: <b>' + esc(next.title) + "</b> at " + esc(fmtWhen(next.due_at)) + '.</p><button class="bp6-button bp6-outlined bp6-large go" data-startnow>Do it now</button>' : '<p class="say">The queue is empty. New leads will show up here the minute they come in.</p>');
    $("#stage").innerHTML = '<div class="bp6-card bp6-elevation-1 card slide-in">' + h + "</div>";
    var b = $("[data-startnow]"); if (b) b.onclick = function () { S.current = next; render(next); };
  }

  function facts(L) {
    var f = [];
    if (L.source) f.push(srcLabel(L.source));
    if (L.service) f.push(L.service);
    if (L.sqft) f.push(L.sqft + " sqft");
    if (L.timeline) f.push(L.timeline);
    if (L.address) f.push(L.address);
    if (L.attempts) f.push(L.attempts + (L.attempts === 1 ? " try" : " tries"));
    return f.map(function (x) { return '<span class="bp6-tag bp6-minimal">' + esc(x) + "</span>"; }).join("");
  }
  function leadLink(L) { return '<a href="#" data-lead="' + L.id + '">' + esc(fullName(L)) + "</a>"; }

  function render(t) {
    var L = t.leads || null; var h = "";
    var tag = t.kind === "untouched" ? '<span class="bp6-tag bp6-intent-danger">WAITING</span>' : (L && L.stage === "new" ? '<span class="bp6-tag bp6-intent-primary">NEW LEAD</span>' : '<span class="bp6-tag bp6-intent-primary">NOW</span>');
    var late = new Date(t.due_at) < new Date(Date.now() - 20 * 60000) ? '<span class="bp6-text-muted">due ' + esc(fmtWhen(t.due_at)) + "</span>" : "<span>" + esc(fmtTime(t.due_at)) + "</span>";
    if (t.kind === "focus") h = focusCard(t);
    else if (t.kind === "eod") h = eodCard(t);
    else if (t.kind === "text") {
      h = '<div class="tiny">' + tag + late + "</div><h1>Text " + leadLink(L) + ".</h1><p class=\"say\">" + esc(t.say || "") + "</p>" +
        '<div class="draft" contenteditable="true" id="draft">' + esc(t.draft || ("Hi " + first(L) + ", it’s " + S.storeName + ".")) + "</div>" +
        '<button class="bp6-button bp6-intent-primary bp6-large go" data-send><svg class="ic lg"><use href="#i-send-message"/></svg>&nbsp;Send this text</button>' +
        '<div class="alt"><span class="bp6-text-muted bp6-text-small">Tap the text to change it · ' + esc(L.phone || "") + '</span><button class="bp6-button bp6-minimal" data-note>Note</button><button class="bp6-button bp6-minimal" data-later>Not now</button></div><div class="outcome" hidden></div>';
    } else if (t.kind === "mockup") {
      h = '<div class="tiny">' + tag + late + "</div><h1>Send " + leadLink(L) + " the mockup.</h1><p class=\"say\">" + esc(t.say || "") + "</p>" +
        '<a class="bp6-button bp6-intent-primary bp6-large go" href="' + FLOOR_SWAP + '" target="_blank" rel="noopener"><svg class="ic lg"><use href="#i-camera"/></svg>&nbsp;Open Floor Swap</a>' +
        '<div class="alt"><button class="bp6-button bp6-minimal" data-mockup-sent><svg class="ic"><use href="#i-tick"/></svg>&nbsp;Sent it</button><button class="bp6-button bp6-minimal" data-later>Not now</button></div><div class="outcome" hidden></div>';
    } else {
      var title = L ? t.title.replace(fullName(L), "").replace(first(L), "") : t.title;
      var verb = t.title.split(" ")[0];
      var heading = L ? (esc(verb) + " " + leadLink(L) + esc(t.title.slice(verb.length + 1 + (t.title.indexOf(fullName(L)) >= 0 ? fullName(L).length : first(L).length)))) : esc(t.title);
      h = '<div class="tiny">' + tag + late + "</div><h1>" + heading + '</h1><p class="say">' + esc(t.say || "") + "</p>" + (L ? '<div class="facts">' + facts(L) + "</div>" : "") +
        (L && L.phone ? '<a class="bp6-button bp6-intent-primary bp6-large go" href="' + telHref(L.phone) + '" data-call><svg class="ic lg"><use href="#i-phone"/></svg>&nbsp;Call ' + esc(first(L)) + " · " + esc(L.phone) + "</a>" : '<button class="bp6-button bp6-intent-primary bp6-large go" data-call>Done</button>') +
        '<div class="alt"><button class="bp6-button bp6-minimal" data-say><svg class="ic"><use href="#i-chat"/></svg>&nbsp;What do I say?</button>' + (L && ghlLink(L) ? '<a class="bp6-button bp6-minimal" href="' + ghlLink(L) + '" target="_blank" rel="noopener">Open in GHL</a>' : "") + (L ? '<button class="bp6-button bp6-minimal" data-note><svg class="ic"><use href="#i-edit"/></svg>&nbsp;Note</button>' : "") + '<button class="bp6-button bp6-minimal" data-later>Not now</button></div>' +
        (t.script && t.script.lines ? '<div class="say-box"><ol>' + t.script.lines.map(function (l) { return "<li>" + esc(l) + "</li>"; }).join("") + "</ol>" + (t.script.last ? '<div class="last">' + esc(t.script.last) + "</div>" : "") + "</div>" : "") +
        '<div class="outcome" hidden></div>';
    }
    var st = $("#stage"); st.innerHTML = '<div class="bp6-card bp6-elevation-1 card slide-in">' + h + "</div>";
    $$("[data-lead]", st).forEach(function (a) { a.onclick = function (e) { e.preventDefault(); openLead(a.dataset.lead); }; });
    var say = $("[data-say]", st); if (say) say.onclick = function () { $(".say-box", st).classList.toggle("open"); };
    var later = $("[data-later]", st); if (later) later.onclick = function () { snooze(t); };
    var call = $("[data-call]", st); if (call) call.addEventListener("click", function () { setTimeout(function () { askOutcome(t); }, 600); });
    var send = $("[data-send]", st); if (send) send.onclick = function () { sendText(t); };
    var ms = $("[data-mockup-sent]", st); if (ms) ms.onclick = function () { mockupSent(t); };
    var nb = $("[data-note]", st); if (nb) nb.onclick = function () { openLead(t.lead_id, true); };
    bindFocusEod(t);
  }

  // ---------- outcomes ----------
  var OUT = {
    call: [["consult", "Booked a consult"], ["home", "Booked a home visit"], ["talked", "Talked, nothing booked"], ["na", "Voicemail / no answer"], ["lost", "Not interested / not a fit"]],
    confirm: [["confirmed", "Confirmed, photos taken"], ["confirmed_nophoto", "Confirmed, no photos yet"], ["resched", "Needs to reschedule"], ["na_soft", "No answer — try again in an hour"]],
    brief: [["confirmed", "Confirmed and briefed"], ["resched", "Needs to reschedule"], ["na_soft", "No answer — try again in an hour"]],
    chase: [["deposit", "Deposit date set"], ["thinking", "Still deciding"], ["lost", "Lost"]],
    rebook: [["consult", "Rebooked a consult"], ["home", "Rebooked a home visit"], ["na", "No answer"], ["lost", "Lost"]],
  };
  OUT.untouched = OUT.call; OUT.walkin_followup = OUT.call; OUT.custom = [["done", "Done"], ["na", "No answer"]];
  function askOutcome(t) {
    var o = $("#stage .outcome"); if (!o || !o.hidden) return; o.hidden = false;
    var opts = OUT[t.kind] || OUT.call;
    o.innerHTML = "<h2>How did it go?</h2>" + opts.map(function (x) { return '<button class="bp6-button bp6-outlined bp6-large" data-k="' + x[0] + '">' + esc(x[1]) + "</button>"; }).join("");
    $$("button", o).forEach(function (b) { b.onclick = function () { $$("button", o).forEach(function (z) { z.disabled = true; }); b.classList.add("bp6-intent-primary"); b.classList.remove("bp6-outlined"); handle(t, b.dataset.k, o); }; });
    o.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  async function handle(t, k, o) {
    var L = t.leads, now = new Date().toISOString(), f = first(L || {});
    try {
      if (k === "consult" || k === "home") { bookingForm(t, k, o); return; }
      if (k === "talked") { await done(t, k); await setStage(L, ["new", "working"].indexOf(L.stage) >= 0 ? "reached" : L.stage, "talked, nothing booked"); reply(o, "Logged. In an hour I’ll have you text " + f + " two consult times if nothing’s booked."); }
      else if (k === "na") { await done(t, k); await sb.from("leads").update({ attempts: (L.attempts || 0) + 1, last_touch_at: now, stage: L.stage === "new" ? "working" : L.stage, stage_changed_at: L.stage === "new" ? now : undefined }).eq("id", L.id); await note(L, "No answer (" + t.kind + ")"); reply(o, "Logged. The no-answer text is next, then I’ll bring " + f + " back later today."); }
      else if (k === "lost") { lostForm(t, o); return; }
      else if (k === "confirmed" || k === "confirmed_nophoto") { await done(t, k); var ap = await nextAppt(L); if (ap) await sb.from("appointments").update({ status: "confirmed", confirmed_at: now }).eq("id", ap.id); await note(L, k === "confirmed" ? "Confirmed, photos taken" : "Confirmed, photos still to come"); reply(o, k === "confirmed" ? "Great. Reminder text goes out the morning of." : "OK. Nudge " + f + " about photos tonight — even five helps."); }
      else if (k === "resched") { var ap2 = await nextAppt(L); if (ap2) await sb.from("appointments").update({ status: "rescheduled" }).eq("id", ap2.id); await done(t, k); bookingForm(t, ap2 && ap2.kind === "home_visit" ? "home" : "consult", o, true); return; }
      else if (k === "na_soft") { await sb.from("tasks").update({ due_at: new Date(Date.now() + 60 * 60000).toISOString(), outcome_note: "no answer at " + fmtTime(now) }).eq("id", t.id); reply(o, "I’ll bring it back in an hour."); }
      else if (k === "deposit") { await done(t, k); var d = prompt("When is the deposit coming? (e.g. Tue)", ""); await note(L, "Deposit date set" + (d ? ": " + d : "")); await sb.from("leads").update({ next_action_at: new Date(Date.now() + 2 * 86400000).toISOString() }).eq("id", L.id); reply(o, "That’s the one that counts. I’ll watch QuickBooks for the deposit and mark it Won when it lands."); }
      else if (k === "thinking") { await done(t, k); await note(L, "Still deciding"); reply(o, "Logged. Next touch is on the chase schedule — I’ll give you the “what’s holding it” opener."); }
      else { await done(t, k); reply(o, "Logged."); }
    } catch (e) { toast("Could not save: " + e.message, "danger"); }
  }
  function bookingForm(t, kind, o, resched) {
    var L = t.leads; var def = defaultSlot(kind);
    var assignees = (S.settings.home_visit && S.settings.home_visit.assignees) || ["Ravinder", "Shiv"];
    o.innerHTML = '<div class="booking"><div class="q" style="font-weight:600;margin-bottom:8px">' + (kind === "home" ? "Home visit" : "Store consult (" + ((S.settings.consult && S.settings.consult.slot_min) || 45) + " min)") + (resched ? " — new time" : "") + "</div>" +
      '<div class="row"><input class="bp6-input bp6-large" type="datetime-local" id="bkWhen" value="' + def + '">' + (kind === "home" ? '<div class="bp6-html-select bp6-large"><select id="bkWho">' + assignees.map(function (a) { return "<option>" + esc(a) + "</option>"; }).join("") + "</select></div>" : "") + "</div>" +
      '<div class="row"><input class="bp6-input bp6-large" id="bkSqft" inputmode="numeric" placeholder="sqft" value="' + esc(L.sqft || "") + '" style="width:110px"><input class="bp6-input bp6-large" id="bkAddr" placeholder="Address" value="' + esc(L.address || "") + '" style="flex:1"></div>' +
      '<button class="bp6-button bp6-intent-primary bp6-large go" id="bkSave">Book it</button></div>';
    $("#bkSave").onclick = async function () {
      var when = $("#bkWhen").value; if (!when) { toast("Pick a time", "warning"); return; }
      var starts = new Date(when); var who = kind === "home" ? $("#bkWho").value : null;
      var ins = await sb.from("appointments").insert({ store_id: S.store, lead_id: L.id, kind: kind === "home" ? "home_visit" : "consult", starts_at: starts.toISOString(), ends_at: new Date(starts.getTime() + (kind === "home" ? 60 : ((S.settings.consult && S.settings.consult.slot_min) || 45)) * 60000).toISOString(), assignee_name: who, status: "booked", created_by: S.user.id });
      if (ins.error) { toast("Could not book: " + ins.error.message, "danger"); return; }
      var patch = { stage: kind === "home" ? "home_booked" : "consult_booked", stage_changed_at: new Date().toISOString(), last_touch_at: new Date().toISOString() };
      var sq = Number($("#bkSqft").value); if (sq) patch.sqft = sq; var ad = $("#bkAddr").value.trim(); if (ad) patch.address = ad;
      await sb.from("leads").update(patch).eq("id", L.id);
      await sb.from("lead_events").insert({ store_id: S.store, lead_id: L.id, kind: kind === "home" ? "home_visit" : "consult", body: (kind === "home" ? "Home visit booked with " + who : "Consult booked") + " · " + fmtDate(starts) + " " + fmtTime(starts), by_user_id: S.user.id, meta: { booked: true } });
      await done(t, kind);
      reply(o, (kind === "home" ? "Booked with " + who + ". " : "Booked. ") + "Text " + first(L) + " the confirmation now; I’ll remind you to call the day before.");
    };
  }
  function defaultSlot(kind) { var d = new Date(Date.now() + 86400000); for (var i = 0; i < 7; i++) { var wd = new Intl.DateTimeFormat("en-CA", { timeZone: S.tz, weekday: "short" }).format(d); if (wd !== "Sun") break; d = new Date(d.getTime() + 86400000); } var p = new Intl.DateTimeFormat("en-CA", { timeZone: S.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); return p + (kind === "home" ? "T13:00" : "T10:30"); }
  function lostForm(t, o) {
    var L = t.leads;
    o.innerHTML = '<div class="booking"><div style="font-weight:600;margin-bottom:8px">Why?</div><div class="lostwhy">' + ["price", "timing", "went elsewhere", "not a fit", "no response", "wrong number"].map(function (r) { return '<button class="bp6-button bp6-outlined" data-r="' + r + '">' + r + "</button>"; }).join("") + "</div></div>";
    $$("[data-r]", o).forEach(function (b) { b.onclick = async function () { await done(t, "lost"); await sb.from("leads").update({ stage: "lost", lost_reason: b.dataset.r, stage_changed_at: new Date().toISOString() }).eq("id", L.id); await sb.from("lead_events").insert({ store_id: S.store, lead_id: L.id, kind: "stage", body: L.stage + " → lost (" + b.dataset.r + ")", by_user_id: S.user.id, meta: { from: L.stage, to: "lost", reason: b.dataset.r } }); reply(o, b.dataset.r === "not a fit" || b.dataset.r === "wrong number" ? "Closed. I won’t bring this one back." : "Closed. I’ll bring " + first(L) + " back in 6 months."); }; });
  }
  async function nextAppt(L) { var r = await sb.from("appointments").select("*").eq("lead_id", L.id).in("status", ["booked", "confirmed"]).gte("starts_at", new Date(Date.now() - 3600000).toISOString()).order("starts_at").limit(1); return r.data && r.data[0]; }
  async function done(t, outcome) { var r = await sb.from("tasks").update({ status: "done", outcome: outcome, done_at: new Date().toISOString(), done_by: S.user.id }).eq("id", t.id); if (r.error) throw new Error(r.error.message); }
  async function setStage(L, stage, why) { if (!L || stage === L.stage) return; await sb.from("leads").update({ stage: stage, stage_changed_at: new Date().toISOString(), last_touch_at: new Date().toISOString() }).eq("id", L.id); await sb.from("lead_events").insert({ store_id: S.store, lead_id: L.id, kind: "stage", body: L.stage + " → " + stage + " (" + why + ")", by_user_id: S.user.id, meta: { from: L.stage, to: stage } }); }
  async function note(L, body) { if (!L) return; await sb.from("lead_events").insert({ store_id: S.store, lead_id: L.id, kind: "note", body: body, by_user_id: S.user.id, meta: { via: "front-desk" } }); }
  async function snooze(t) { await sb.from("tasks").update({ due_at: new Date(Date.now() + 2 * 3600000).toISOString() }).eq("id", t.id); toast("Moved 2 hours out."); S.current = null; loadTasks(); }
  function reply(where, msg) { var d = document.createElement("div"); d.className = "reply"; d.innerHTML = '<svg class="ic"><use href="#i-tick"/></svg><span>' + esc(msg) + "</span>"; where.appendChild(d); d.scrollIntoView({ behavior: "smooth", block: "nearest" }); setTimeout(function () { S.current = null; loadTasks(); tick(); }, 1600); }
  async function sendText(t) {
    var msg = $("#draft").innerText.trim(); var b = $("[data-send]"); b.disabled = true; b.textContent = "Sending…";
    try { await authedFetch("/ghl-send", { lead_id: t.lead_id, message: msg, task_id: t.id }); var o = $("#stage .outcome"); o.hidden = false; reply(o, "Sent. I’ll bring " + first(t.leads) + " back if there’s no reply."); }
    catch (e) { b.disabled = false; b.innerHTML = '<svg class="ic lg"><use href="#i-send-message"/></svg>&nbsp;Send this text'; toast("Not sent: " + e.message, "danger"); }
  }
  async function mockupSent(t) { await sb.from("lead_events").insert({ store_id: S.store, lead_id: t.lead_id, kind: "mockup", body: "Mockup sent", by_user_id: S.user.id, meta: {} }); await done(t, "sent"); var o = $("#stage .outcome"); o.hidden = false; reply(o, "Logged. Now book the home visit while they’re excited."); }

  // ---------- focus / eod ----------
  async function todayNumbers() {
    var start = new Date(); start.setHours(0, 0, 0, 0); var iso = start.toISOString();
    var q = await Promise.all([
      sb.from("leads").select("id", { count: "exact", head: true }).eq("store_id", S.store).gte("created_at", iso).neq("source", "quickbooks"),
      sb.from("lead_events").select("id", { count: "exact", head: true }).eq("store_id", S.store).eq("kind", "call").eq("direction", "out").gte("at", iso),
      sb.from("lead_events").select("id", { count: "exact", head: true }).eq("store_id", S.store).eq("kind", "call").gte("at", iso).filter("meta->>connected", "eq", "true"),
      sb.from("appointments").select("id", { count: "exact", head: true }).eq("store_id", S.store).gte("created_at", iso),
      sb.from("appointments").select("id", { count: "exact", head: true }).eq("store_id", S.store).eq("status", "showed").gte("starts_at", iso),
      sb.from("tasks").select("id", { count: "exact", head: true }).eq("store_id", S.store).eq("status", "done").gte("done_at", iso),
      sb.from("tasks").select("id", { count: "exact", head: true }).eq("store_id", S.store).eq("status", "open").lte("due_at", new Date().toISOString()),
    ]);
    return { new_leads: q[0].count || 0, dials: q[1].count || 0, reached: q[2].count || 0, booked: q[3].count || 0, showed: q[4].count || 0, tasks_done: q[5].count || 0, due_now: q[6].count || 0 };
  }
  function focusCard(t) {
    var open = S.tasks.filter(function (x) { return x.kind !== "focus" && x.kind !== "eod"; });
    var news = open.filter(function (x) { return x.leads && x.leads.stage === "new"; }).length;
    var chases = open.filter(function (x) { return x.kind === "chase"; }).length;
    var confirms = open.filter(function (x) { return x.kind === "confirm" || x.kind === "brief"; }).length;
    var picks = ["Call every new lead inside 5 minutes" + (news ? " (" + news + " waiting)" : ""), "Book 2 consults", "Clear " + Math.min(20, open.length) + " of the " + open.length + " open follow-ups"];
    if (chases) picks.push("Chase the " + chases + " open estimate" + (chases > 1 ? "s" : ""));
    if (confirms) picks.push("Confirm tomorrow’s " + confirms + " visit" + (confirms > 1 ? "s" : ""));
    return '<div class="tiny"><span class="bp6-tag bp6-intent-primary">GOOD MORNING</span><span>' + esc(fmtTime(new Date())) + "</span></div>" +
      "<h1>" + open.length + " follow-ups open" + (news ? ", " + news + " new lead" + (news > 1 ? "s" : "") + " waiting" : "") + ".</h1>" +
      '<p class="say">Pick your top three for today. Takes five minutes. The owners see it.</p><div class="focus-list">' +
      picks.map(function (p, i) { return '<label class="bp6-control bp6-checkbox bp6-large"><input type="checkbox" class="bp6-control-input" data-pick' + (i < 3 ? " checked" : "") + '><span class="bp6-control-indicator"></span>' + esc(p) + "</label>"; }).join("") +
      '</div><input class="bp6-input bp6-large" id="focusText" placeholder="In your own words — how are you going to hit it?">' +
      '<button class="bp6-button bp6-intent-primary bp6-large go" data-focus-post>Post my focus and start</button><div class="outcome" hidden></div>';
  }
  function eodCard(t) {
    return '<div class="tiny"><span class="bp6-tag bp6-intent-primary">END OF DAY</span><span>' + esc(fmtTime(new Date())) + '</span></div><div class="eod"><h1 id="eodTitle">Today’s numbers…</h1><div class="nums" id="eodNums"></div>' +
      '<p class="say" id="eodFocus"></p><textarea class="bp6-input" id="eodWorked" placeholder="What worked"></textarea><textarea class="bp6-input" id="eodStuck" placeholder="What got stuck"></textarea>' +
      '<button class="bp6-button bp6-intent-primary bp6-large go" data-eod-post>Post and go home</button><div class="outcome" hidden></div></div>';
  }
  async function bindFocusEod(t) {
    var fp = $("[data-focus-post]"); if (fp) fp.onclick = async function () {
      var picks = $$("[data-pick]").filter(function (c) { return c.checked; }).map(function (c) { return c.parentElement.textContent.trim(); });
      var r = await sb.from("daily_reports").upsert({ store_id: S.store, user_id: S.user.id, report_date: todayISO(), kind: "focus", picks: picks, text: $("#focusText").value.trim() }, { onConflict: "store_id,report_date,kind,user_id" });
      if (r.error) { toast("Could not post: " + r.error.message, "danger"); return; }
      await done(t, "posted"); var o = $("#stage .outcome"); o.hidden = false; reply(o, "Posted. Let’s go.");
    };
    var ep = $("[data-eod-post]"); if (ep) {
      var n = await todayNumbers();
      $("#eodTitle").textContent = n.dials + " dials · " + n.reached + " reached · " + n.booked + " booked.";
      $("#eodNums").innerHTML = [["new leads", n.new_leads], ["dials", n.dials], ["reached", n.reached], ["booked", n.booked], ["showed", n.showed], ["tasks done", n.tasks_done], ["still due", n.due_now]].map(function (x) { return "<div><b>" + x[1] + "</b><span>" + x[0] + "</span></div>"; }).join("");
      var f = await sb.from("daily_reports").select("picks, text").eq("store_id", S.store).eq("report_date", todayISO()).eq("kind", "focus").eq("user_id", S.user.id).maybeSingle();
      $("#eodFocus").textContent = f.data && f.data.picks && f.data.picks.length ? "This morning you said: " + f.data.picks.join(" · ") : "No focus was posted this morning.";
      ep.onclick = async function () {
        var r = await sb.from("daily_reports").upsert({ store_id: S.store, user_id: S.user.id, report_date: todayISO(), kind: "eod", numbers: n, text: ("Worked: " + $("#eodWorked").value.trim() + "\nStuck: " + $("#eodStuck").value.trim()) }, { onConflict: "store_id,report_date,kind,user_id" });
        if (r.error) { toast("Could not post: " + r.error.message, "danger"); return; }
        await done(t, "posted"); var o = $("#stage .outcome"); o.hidden = false; reply(o, "Posted. Owners get it now. See you at 8:30.");
      };
    }
  }

  // ---------- walk-in ----------
  function openW() { $("#walkin").classList.add("open"); setTimeout(function () { $("#wName").focus(); }, 50); } function closeW() { $("#walkin").classList.remove("open"); }
  $$("[data-walkin]").forEach(function (b) { b.onclick = openW; }); $$("[data-walkin-close]").forEach(function (b) { b.onclick = closeW; });
  $("#walkinSave").onclick = async function () {
    var name = $("#wName").value.trim(), phone = $("#wPhone").value.trim(); if (!name || !phone) { toast("Name and phone", "warning"); return; }
    var parts = name.split(/\s+/); var now = new Date();
    var ins = await sb.from("leads").insert({ store_id: S.store, first_name: parts[0], last_name: parts.slice(1).join(" ") || null, phone: phone, source: "walkin", stage: "reached", service: $("#wService").value, consent_source: $("#wConsent").checked ? "walk-in form" : null, consent_at: $("#wConsent").checked ? now.toISOString() : null, last_touch_at: now.toISOString(), owner_user_id: S.user.id }).select("id").single();
    if (ins.error) { toast("Could not save: " + ins.error.message, "danger"); return; }
    await sb.from("lead_events").insert({ store_id: S.store, lead_id: ins.data.id, kind: "walkin", body: "Walked in · " + $("#wService").value, by_user_id: S.user.id, meta: {} });
    var tmr = new Date(now.getTime() + 86400000); var p = new Intl.DateTimeFormat("en-CA", { timeZone: S.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(tmr);
    await sb.from("tasks").insert({ store_id: S.store, lead_id: ins.data.id, kind: "walkin_followup", title: "Call " + parts[0] + ".", say: "Walked in yesterday looking at " + $("#wService").value.toLowerCase() + ". Ask what they thought of the samples and book the home visit.", due_at: new Date(p + "T10:00:00").toISOString(), created_by: "user", rule_key: "walkin_followup" });
    closeW(); $("#wName").value = ""; $("#wPhone").value = ""; toast("Saved. I’ll remind you to call " + parts[0] + " tomorrow at 10:00.");
    try { await authedFetch("/desk-tick", { store_id: S.store, push_contact: ins.data.id }); } catch (e) {}
  };

  // ---------- lead panel ----------
  async function openLead(id, focusNote) {
    var r = await sb.from("leads").select("*").eq("id", id).single(); var L = r.data; if (!L) return;
    S.panelLead = L; resetNote(); if (focusNote) setTimeout(function () { $("#nText").focus(); }, 350);
    $("#pName").textContent = fullName(L);
    var stageIntent = { new: "primary", working: "", reached: "primary", consult_booked: "success", consult_done: "success", home_booked: "success", home_done: "success", estimate_sent: "primary", won: "success", customer: "success", lost: "danger", nurture: "" }[L.stage] || "";
    $("#pSub").innerHTML = '<span class="bp6-tag ' + (stageIntent ? "bp6-intent-" + stageIntent : "") + '">' + esc(L.stage.replace("_", " ")) + "</span>" + (L.phone ? '<a href="' + telHref(L.phone) + '">' + esc(L.phone) + "</a>" : "") + '<span class="bp6-tag bp6-minimal bp6-round">' + esc(srcLabel(L.source)) + "</span>" + (ghlLink(L) ? '<a class="bp6-tag bp6-minimal bp6-interactive" target="_blank" rel="noopener" href="' + ghlLink(L) + '">GHL</a>' : "");
    var nt = await sb.from("tasks").select("title, due_at").eq("lead_id", id).eq("status", "open").order("due_at").limit(1);
    $("#pNext").textContent = nt.data && nt.data[0] ? nt.data[0].title + " · " + fmtWhen(nt.data[0].due_at) : (L.stage === "customer" ? "Customer — nothing scheduled" : "Nothing scheduled");
    var q = { Service: L.service, Why: L.why, Timeline: L.timeline, "Tried others": L.tried_others, "Price or quality": L.buyer_type, Sqft: L.sqft, Address: L.address, Photos: L.photos_received ? L.photos_received + " received" : "", Estimate: L.est_value ? "$" + Number(L.est_value).toLocaleString() : "", Notes: L.notes };
    $("#pQ").innerHTML = Object.keys(q).map(function (k) { var v = q[k]; return '<div><div class="k">' + k + '</div><div class="v' + (v ? "" : " empty") + '">' + esc(v || "ask on the call") + "</div></div>"; }).join("");
    var ev = await sb.from("lead_events").select("*").eq("lead_id", id).order("at", { ascending: false }).limit(60);
    $("#pThread").innerHTML = (ev.data || []).map(function (e) {
      var c = e.kind === "call" || e.kind === "voicemail" ? "call" : (e.kind === "consult" || e.kind === "home_visit" || e.kind === "mockup") ? "visit" : (e.kind === "payment" || e.kind === "estimate" || e.kind === "invoice") ? "money" : "";
      var ttl = { sms_in: "Text from " + first(L), sms_out: "Text sent", email_in: "Email in", email_out: "Email out", call: "Call", voicemail: "Voicemail", note: "Note", form: "Form", stage: "Stage", consult: "Consult", home_visit: "Home visit", estimate: "Estimate", payment: "Payment", invoice: "Invoice", mockup: "Mockup", walkin: "Walk-in", task: "Task" }[e.kind] || e.kind;
      return '<div class="ev ' + c + '"><div class="when">' + esc(fmtDate(e.at) + " " + fmtTime(e.at)) + (e.duration_s ? " · " + Math.floor(e.duration_s / 60) + ":" + String(e.duration_s % 60).padStart(2, "0") : "") + '</div><div class="ttl">' + esc(ttl) + "</div>" + (e.body ? '<div class="body' + (e.kind.indexOf("sms") === 0 ? " quote" : "") + '">' + esc(e.body) + "</div>" : "") + (e.summary ? '<div class="body">' + esc(e.summary) + "</div>" : "") + "</div>";
    }).join("") || '<div class="bp6-text-muted">Nothing yet.</div>';
    $("#panel").classList.add("open"); $("#panelBack").classList.add("open"); document.body.style.overflow = "hidden";
  }
  // note composer
  function resetNote() { $("#nText").value = ""; $$("#nPromise button").forEach(function (b) { b.classList.toggle("on", b.dataset.p === ""); }); $("#nWhen").hidden = true; $("#nDue").value = "60"; $("#nDueAt").hidden = true; $("#nHint").textContent = ""; $("#nSave").disabled = false; $("#nSave").textContent = "Save note"; }
  function noteDue() {
    var v = $("#nDue").value, d = new Date();
    if (v === "60") d = new Date(Date.now() + 3600000);
    else if (v === "eod") { d.setHours(16, 0, 0, 0); if (d < new Date()) d = new Date(Date.now() + 3600000); }
    else if (v === "tom9") { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
    else if (v === "tom15") { d.setDate(d.getDate() + 1); d.setHours(15, 0, 0, 0); }
    else if (v === "pick") { var x = $("#nDueAt").value; d = x ? new Date(x) : null; }
    return d;
  }
  $$("#nPromise button").forEach(function (b) { b.onclick = function () { $$("#nPromise button").forEach(function (z) { z.classList.remove("on"); }); b.classList.add("on"); $("#nWhen").hidden = !b.dataset.p; $("#nHint").textContent = b.dataset.p ? "This becomes a card on your stack at that time." : ""; }; });
  $("#nDue").onchange = function () { $("#nDueAt").hidden = $("#nDue").value !== "pick"; if (!$("#nDueAt").hidden) $("#nDueAt").focus(); };
  $("#nSave").onclick = async function () {
    var L = S.panelLead; if (!L) return;
    var text = $("#nText").value.trim(); var pb = $("#nPromise button.on"); var label = pb ? pb.dataset.p : "";
    var promise = null;
    if (label) { var due = noteDue(); if (!due) { toast("Pick a time for the promise.", "warning"); return; } promise = { label: label, due_at: due.toISOString() }; }
    if (!text && !promise) { toast("Write something or pick a promise.", "warning"); return; }
    $("#nSave").disabled = true; $("#nSave").textContent = "Saving…";
    try {
      var res = await authedFetch("/desk-note", { lead_id: L.id, body: text, promise: promise });
      toast(res.ghl && res.ghl.ok ? (promise ? "Saved here and in GHL. Card set for " + fmtWhen(promise.due_at) + "." : "Saved here and in GHL.") : "Saved here. GHL didn’t take it: " + ((res.ghl && res.ghl.error) || "no contact"), res.ghl && res.ghl.ok ? "success" : "warning");
      openLead(L.id); if (promise) loadTasks();
    } catch (e) { toast("Couldn’t save: " + e.message, "danger"); $("#nSave").disabled = false; $("#nSave").textContent = "Save note"; }
  };
  function closeLead() { $("#panel").classList.remove("open"); $("#panelBack").classList.remove("open"); document.body.style.overflow = ""; }
  $("#panelClose").onclick = closeLead; $("#panelBack").onclick = closeLead;
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") { closeLead(); closeW(); closeTD(); } });

  // ---------- leads list ----------
  async function loadLeads() {
    var r = await sb.from("leads").select("id, first_name, last_name, phone, source, stage, last_touch_at, created_at, attempts").eq("store_id", S.store).order("last_touch_at", { ascending: false, nullsFirst: false }).limit(400);
    S.leadsCache = r.data || []; drawLeads();
  }
  function drawLeads() {
    var q = ($("#leadSearch").value || "").toLowerCase().replace(/\D/g, "") || null; var qs = ($("#leadSearch").value || "").toLowerCase();
    var rows = S.leadsCache.filter(function (l) { return !qs || fullName(l).toLowerCase().indexOf(qs) >= 0 || (q && String(l.phone || "").replace(/\D/g, "").indexOf(q) >= 0); }).slice(0, 150);
    $("#leadRows").innerHTML = rows.map(function (l) { return '<div class="bp6-card bp6-interactive row" data-lead="' + l.id + '"><div><div class="nm">' + esc(fullName(l)) + '</div><div class="sub">' + esc(srcLabel(l.source)) + " · " + esc(l.stage.replace("_", " ")) + (l.last_touch_at ? " · last touch " + ago(l.last_touch_at) : " · never touched") + '</div></div><div class="bp6-text-muted">' + esc(l.phone || "") + "</div></div>"; }).join("") || '<div class="bp6-text-muted">No one matches.</div>';
    $$("#leadRows [data-lead]").forEach(function (el) { el.onclick = function () { openLead(el.dataset.lead); }; });
  }
  $("#leadSearch").addEventListener("input", drawLeads);

  // ---------- team board (sales / ops / marketing) ----------
  // Internal team tasks live in team_tasks. They never touch the lead-card `tasks` table or the Today stack.
  var AREAS = [["sales", "Sales"], ["ops", "Ops"], ["marketing", "Marketing"]];
  var AREA_LABEL = { sales: "Sales", ops: "Ops", marketing: "Marketing" };
  var B = { rows: [], done: [], who: "all", area: "all", loaded: false };
  var TD = null;
  try { var bp = JSON.parse(localStorage.getItem("fd-board") || "{}"); if (bp.who) B.who = bp.who; if (bp.area) B.area = bp.area; } catch (e) {}
  function saveBoardPrefs() { try { localStorage.setItem("fd-board", JSON.stringify({ who: B.who, area: B.area })); } catch (e) {} }
  function lc(s) { return String(s || "").trim().toLowerCase(); }
  function isoAdd(iso, n) { var d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function isoDow(iso) { return new Date(iso + "T12:00:00Z").getUTCDay(); }
  function fmtDay(iso, o) { return new Intl.DateTimeFormat("en-CA", Object.assign({ timeZone: "UTC" }, o)).format(new Date(iso + "T12:00:00Z")); }
  function team() {
    var names = [];
    var add = function (n) { n = String(n || "").trim(); if (n && names.map(lc).indexOf(lc(n)) < 0) names.push(n); };
    (S.settings.team || []).forEach(add);
    if (!names.length) { S.members.forEach(add); ((S.settings.home_visit && S.settings.home_visit.assignees) || []).forEach(add); }
    B.rows.concat(B.done).forEach(function (t) { add(t.owner_name); });
    var i = names.map(lc).indexOf(lc(S.myName)); if (i > 0) names.unshift(names.splice(i, 1)[0]);
    return names;
  }
  function avIdx(n) { var k = (S.settings.team || []).map(lc).indexOf(lc(n)); if (k >= 0) return k % 6; var h = 0; for (var i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0; return h % 6; }
  function dueLabel(t) {
    if (!t.due_on) return { text: "No date", cls: "" };
    var today = todayISO();
    if (t.due_on < today) return { text: "Overdue · " + fmtDay(t.due_on, { month: "short", day: "numeric" }), cls: "late" };
    if (t.due_on === today) return { text: "Today", cls: "today" };
    if (t.due_on === isoAdd(today, 1)) return { text: "Tomorrow", cls: "" };
    return { text: fmtDay(t.due_on, { weekday: "short", month: "short", day: "numeric" }), cls: "" };
  }
  function byDue(a, b) {
    if (a.due_on !== b.due_on) { if (!a.due_on) return 1; if (!b.due_on) return -1; return a.due_on < b.due_on ? -1 : 1; }
    if (a.status !== b.status) return a.status === "doing" ? -1 : 1;
    return a.created_at < b.created_at ? -1 : 1;
  }
  function findT(id) { return B.rows.concat(B.done).find(function (t) { return t.id === id; }); }
  function regroup() {
    var all = B.rows.concat(B.done);
    B.rows = all.filter(function (t) { return t.status !== "done"; });
    B.done = all.filter(function (t) { return t.status === "done"; }).sort(function (a, b) { return (b.done_at || "") < (a.done_at || "") ? -1 : 1; });
  }

  async function loadBoard() {
    var since = new Date(Date.now() - 7 * 86400000).toISOString();
    var q = await Promise.all([
      sb.from("team_tasks").select("*").eq("store_id", S.store).neq("status", "done").limit(500),
      sb.from("team_tasks").select("*").eq("store_id", S.store).eq("status", "done").gte("done_at", since).order("done_at", { ascending: false }).limit(100),
    ]);
    var err = q[0].error || q[1].error;
    if (err) { $("#boardCols").innerHTML = '<div class="bp6-callout bp6-intent-warning">Couldn’t load the board: ' + esc(err.message) + "</div>"; return; }
    B.rows = q[0].data || []; B.done = q[1].data || []; B.loaded = true;
    drawBoard();
  }

  function tcard(t, showArea) {
    var d = dueLabel(t), isDone = t.status === "done";
    var who = t.owner_name ? '<span class="who"><span class="av av-' + avIdx(t.owner_name) + '" aria-hidden="true">' + esc(t.owner_name.charAt(0).toUpperCase()) + "</span>" + esc(t.owner_name) + "</span>" : '<span class="who nobody">No owner yet</span>';
    return '<div class="bp6-card tcard' + (isDone ? " done" : "") + '" data-tid="' + t.id + '">' +
      '<button class="tcheck" data-check aria-label="' + (isDone ? "Put back: " : "Mark done: ") + esc(t.title) + '"><i>' + (isDone ? '<svg class="ic"><use href="#i-tick"/></svg>' : "") + "</i></button>" +
      '<div class="tb"><button class="ttl" data-edit>' + esc(t.title) + "</button>" + (t.note ? '<div class="tnote">' + esc(t.note) + "</div>" : "") +
      '<div class="meta">' + who +
      (isDone ? '<span class="due">done ' + esc(ago(t.done_at || t.updated_at)) + "</span>" : '<span class="due ' + d.cls + '">' + esc(d.text) + "</span>") +
      (showArea ? '<span class="bp6-tag bp6-minimal atag ' + t.area + '">' + AREA_LABEL[t.area] + "</span>" : "") +
      (isDone ? "" : '<button class="bp6-tag bp6-minimal bp6-interactive st' + (t.status === "doing" ? " bp6-intent-warning" : "") + '" data-st title="Switch between To do and Doing">' + (t.status === "doing" ? "Doing" : "To do") + "</button>") +
      "</div></div></div>";
  }

  function drawBoard() {
    var today = todayISO(), weekEnd = isoAdd(startOfWeekISO(), 6);
    var names = team();
    if (B.who !== "all" && names.map(lc).indexOf(lc(B.who)) < 0) B.who = "all";
    var mine = function (t) { return B.who === "all" || lc(t.owner_name) === lc(B.who); };
    var open = B.rows.filter(mine), done = B.done.filter(mine);
    var overdue = open.filter(function (t) { return t.due_on && t.due_on < today; }).length;
    var week = open.filter(function (t) { return t.due_on && t.due_on >= today && t.due_on <= weekEnd; }).length;
    $("#boardSub").textContent = (B.who === "all" ? "Everyone" : (lc(B.who) === lc(S.myName) ? "Your tasks" : B.who + "’s tasks")) + " · " + open.length + " open";
    var stat = function (lab, num, cls) { return '<div class="bp6-card stat"><div class="lab">' + lab + '</div><div class="num' + (cls ? " " + cls : "") + '">' + num + "</div></div>"; };
    $("#boardStats").innerHTML = stat("Open", open.length) + stat("Overdue", overdue, overdue ? "late" : "") + stat("Due this week", week) + stat("Done, 7 days", done.length, done.length ? "ok" : "");
    var chip = function (attr, v, label, on) { return '<button type="button" class="bp6-button ' + (on ? "bp6-intent-primary" : "bp6-outlined") + '" data-' + attr + '="' + esc(v) + '" aria-pressed="' + on + '">' + esc(label) + "</button>"; };
    $("#boardWho").innerHTML = chip("who", "all", "Everyone", B.who === "all") + names.map(function (n) { return chip("who", n, lc(n) === lc(S.myName) ? n + " (you)" : n, lc(B.who) === lc(n)); }).join("");
    $("#boardArea").innerHTML = chip("area", "all", "All areas", B.area === "all") + AREAS.map(function (a) { return chip("area", a[0], a[1], B.area === a[0]); }).join("");
    var areas = B.area === "all" ? AREAS : AREAS.filter(function (a) { return a[0] === B.area; });
    $("#boardCols").className = "board-cols" + (areas.length === 1 ? " one" : "");
    $("#boardCols").innerHTML = areas.map(function (a) {
      var items = open.filter(function (t) { return t.area === a[0]; }).sort(byDue);
      return '<section class="bcol"><h3><span class="area-' + a[0] + '">' + a[1] + '</span><span class="n">' + items.length + " open</span></h3>" +
        (items.map(function (t) { return tcard(t, false); }).join("") || '<div class="bempty">Nothing open here.</div>') + "</section>";
    }).join("");
    var doneShown = done.filter(function (t) { return B.area === "all" || t.area === B.area; });
    $("#boardDone").innerHTML = doneShown.length ? '<details class="bdone" open><summary>Done in the last 7 days <span class="n">· ' + doneShown.length + "</span></summary>" + doneShown.map(function (t) { return tcard(t, true); }).join("") + "</details>" : "";
    $$("#boardWho [data-who]").forEach(function (b) { b.onclick = function () { B.who = b.dataset.who; saveBoardPrefs(); drawBoard(); }; });
    $$("#boardArea [data-area]").forEach(function (b) { b.onclick = function () { B.area = b.dataset.area; saveBoardPrefs(); drawBoard(); }; });
    $$("#view-board [data-tid]").forEach(function (el) {
      var t = findT(el.dataset.tid); if (!t) return;
      el.onclick = function (e) { if (e.target.closest("[data-check],[data-st]")) return; openTask(t); };
      $("[data-check]", el).onclick = function () { toggleDone(t); };
      var st = $("[data-st]", el); if (st) st.onclick = function () { patchTask(t, { status: t.status === "doing" ? "todo" : "doing" }); };
    });
  }

  async function patchTask(t, patch, msg) {
    var prev = Object.assign({}, t); Object.assign(t, patch); regroup(); drawBoard();
    var r = await sb.from("team_tasks").update(patch).eq("id", t.id).select().single();
    if (r.error) { Object.assign(t, prev); regroup(); drawBoard(); toast("Couldn’t save: " + r.error.message, "danger"); return false; }
    Object.assign(t, r.data); regroup(); if (msg) toast(msg); return true;
  }
  function toggleDone(t) {
    if (t.status === "done") patchTask(t, { status: "todo", done_at: null, done_by: null }, "Back on the board.");
    else patchTask(t, { status: "done", done_at: new Date().toISOString(), done_by: S.user.id }, "Done.");
  }

  // add / edit dialog
  function dueChoices() {
    var today = todayISO(), dow = isoDow(today);
    var fri = isoAdd(today, ((5 - dow + 7) % 7) || 7), mon = isoAdd(today, ((1 - dow + 7) % 7) || 7);
    return [["today", "Today", today], ["tom", "Tomorrow", isoAdd(today, 1)], ["fri", "Fri " + fmtDay(fri, { month: "short", day: "numeric" }), fri], ["mon", "Next Mon", mon], ["pick", "Pick a date", null], ["none", "No date", null]];
  }
  function openTask(t) {
    var fri = dueChoices()[2][2];
    TD = t ? { id: t.id, area: t.area, owner: t.owner_name || "", due: t.due_on || null, status: t.status, mode: null }
           : { id: null, area: B.area !== "all" ? B.area : "ops", owner: B.who !== "all" ? B.who : "", due: fri, status: "todo", mode: null };
    $("#tdTitle").textContent = t ? "Edit task" : "New task";
    $("#tdText").value = t ? t.title : ""; $("#tdNote").value = t ? (t.note || "") : "";
    $("#tdSave").textContent = t ? "Save" : "Add task"; $("#tdSave").disabled = false;
    $("#tdDelete").hidden = !t; $("#tdStatusWrap").hidden = !t;
    drawTD();
    $("#taskDlg").classList.add("open");
    if (!t) setTimeout(function () { $("#tdText").focus(); }, 50);
  }
  function drawTD() {
    var ch = dueChoices();
    var mode = TD.mode || (!TD.due ? "none" : ((ch.find(function (c) { return c[2] === TD.due; }) || ["pick"])[0]));
    var chip = function (k, v, label, on) { return '<button type="button" class="bp6-button ' + (on ? "bp6-intent-primary" : "bp6-outlined") + '" data-k="' + k + '" data-v="' + esc(v) + '" aria-pressed="' + on + '">' + esc(label) + "</button>"; };
    $("#tdArea").innerHTML = AREAS.map(function (a) { return chip("area", a[0], a[1], TD.area === a[0]); }).join("");
    $("#tdOwner").innerHTML = team().map(function (n) { return chip("owner", n, lc(n) === lc(S.myName) ? n + " (you)" : n, lc(TD.owner) === lc(n)); }).join("") + chip("owner", "", "Nobody yet", !TD.owner);
    $("#tdDue").innerHTML = ch.map(function (c) { return chip("due", c[0], c[1], mode === c[0]); }).join("");
    $("#tdDate").hidden = mode !== "pick"; if (mode === "pick") $("#tdDate").value = TD.due || "";
    $("#tdDueText").textContent = TD.due ? "Due " + fmtDay(TD.due, { weekday: "long", month: "long", day: "numeric" }) : "No due date";
    $("#tdStatus").innerHTML = [["todo", "To do"], ["doing", "Doing"], ["done", "Done"]].map(function (s) { return chip("status", s[0], s[1], TD.status === s[0]); }).join("");
    $$("#taskDlg [data-k]").forEach(function (b) {
      b.onclick = function () {
        var k = b.dataset.k, v = b.dataset.v;
        if (k === "area") TD.area = v;
        if (k === "owner") TD.owner = v;
        if (k === "status") TD.status = v;
        if (k === "due") { TD.mode = v; if (v === "none") TD.due = null; else if (v !== "pick") TD.due = ch.find(function (c) { return c[0] === v; })[2]; }
        drawTD();
        if (k === "due" && v === "pick") $("#tdDate").focus();
      };
    });
  }
  function notifyBoard(id, ev) { authedFetch("/board-notify", { action: "task", task_id: id, event: ev }).catch(function () { /* Slack is best effort */ }); }
  function closeTD() { $("#taskDlg").classList.remove("open"); TD = null; }
  $("#boardAdd").onclick = function () { openTask(null); };
  $$("[data-td-close]").forEach(function (b) { b.onclick = closeTD; });
  $("#taskDlg").addEventListener("click", function (e) { if (e.target.id === "taskDlg") closeTD(); });
  $("#tdDate").onchange = function () { if (!TD) return; TD.due = $("#tdDate").value || null; TD.mode = "pick"; drawTD(); };
  $("#tdText").addEventListener("keydown", function (e) { if (e.key === "Enter") $("#tdSave").click(); });
  $("#tdSave").onclick = async function () {
    if (!TD) return;
    var title = $("#tdText").value.trim(); if (!title) { toast("Write what needs doing.", "warning"); $("#tdText").focus(); return; }
    var row = { area: TD.area, title: title, note: $("#tdNote").value.trim() || null, owner_name: TD.owner || null, due_on: TD.due || null };
    $("#tdSave").disabled = true;
    try {
      if (TD.id) {
        var t = findT(TD.id); var was = t ? t.status : "todo"; var wasOwner = t ? (t.owner_name || "") : "";
        row.status = TD.status;
        if (TD.status === "done" && was !== "done") { row.done_at = new Date().toISOString(); row.done_by = S.user.id; }
        if (TD.status !== "done" && was === "done") { row.done_at = null; row.done_by = null; }
        var r = await sb.from("team_tasks").update(row).eq("id", TD.id).select().single();
        if (r.error) throw new Error(r.error.message);
        if (t) Object.assign(t, r.data); regroup(); toast("Saved.");
        if (lc(wasOwner) !== lc(row.owner_name) && row.owner_name && TD.status !== "done") notifyBoard(TD.id, "assigned");
      } else {
        row.store_id = S.store; row.created_by = S.user.id; row.status = "todo";
        var r2 = await sb.from("team_tasks").insert(row).select().single();
        if (r2.error) throw new Error(r2.error.message);
        B.rows.push(r2.data); toast(row.owner_name ? "Added to " + row.owner_name + "’s list." : "Added. Give it an owner when you know who.");
        notifyBoard(r2.data.id, "created");
      }
      closeTD(); drawBoard();
    } catch (e) { toast("Couldn’t save: " + e.message, "danger"); $("#tdSave").disabled = false; }
  };
  $("#tdDelete").onclick = async function () {
    if (!TD || !TD.id || !confirm("Delete this task?")) return;
    var id = TD.id;
    var r = await sb.from("team_tasks").delete().eq("id", id).select("id");
    if (r.error || !(r.data || []).length) { toast(r.error ? "Couldn’t delete: " + r.error.message : "Only an owner or whoever added it can delete it.", "danger"); return; }
    B.rows = B.rows.filter(function (t) { return t.id !== id; }); B.done = B.done.filter(function (t) { return t.id !== id; });
    closeTD(); drawBoard(); toast("Deleted.");
  };

  // ---------- owners ----------
  async function loadOwners() {
    var wk = startOfWeekISO(); var body = $("#ownersBody"); body.innerHTML = '<p class="bp6-text-muted">Counting…</p>';
    var q = await Promise.all([
      sb.from("leads").select("id, source, stage, attempts, created_at").eq("store_id", S.store).gte("created_at", wk).neq("source", "quickbooks"),
      sb.from("appointments").select("id, kind, status, starts_at, created_at").eq("store_id", S.store).gte("created_at", wk),
      sb.from("estimates").select("id, total, txn_date").eq("store_id", S.store).gte("txn_date", wk),
      sb.from("payments").select("id, amount, is_deposit, txn_date").eq("store_id", S.store).gte("txn_date", wk),
      sb.from("leads").select("stage, est_value").eq("store_id", S.store).not("stage", "in", "(customer,lost)"),
      sb.from("lead_events").select("id, kind, direction, at, meta").eq("store_id", S.store).gte("at", wk).in("kind", ["call", "sms_out", "sms_in"]),
      sb.from("daily_reports").select("kind, report_date, picks, text, numbers, posted_at").eq("store_id", S.store).order("posted_at", { ascending: false }).limit(6),
      sb.rpc("desk_integration_status", { p_store: S.store }),
    ]);
    var leads = q[0].data || [], appts = q[1].data || [], ests = q[2].data || [], pays = q[3].data || [], pipe = q[4].data || [], evs = q[5].data || [], reps = q[6].data || [], integ = q[7].data || [];
    var dialed = leads.filter(function (l) { return l.attempts > 0; }).length;
    var calls = evs.filter(function (e) { return e.kind === "call" && e.direction === "out"; }).length;
    var connected = evs.filter(function (e) { return e.kind === "call" && e.meta && e.meta.connected; }).length;
    var booked = appts.length, showed = appts.filter(function (a) { return a.status === "showed"; }).length, past = appts.filter(function (a) { return new Date(a.starts_at) < new Date() && a.status !== "cancelled"; }).length;
    var deposits = pays.filter(function (p) { return p.is_deposit; }), cash = pays.reduce(function (s, p) { return s + Number(p.amount || 0); }, 0);
    var bySrc = {}; leads.forEach(function (l) { var s = bySrc[l.source] = bySrc[l.source] || { n: 0, dialed: 0, reached: 0 }; s.n++; if (l.attempts > 0) s.dialed++; if (["new", "working"].indexOf(l.stage) < 0) s.reached++; });
    var stages = {}; pipe.forEach(function (l) { var s = stages[l.stage] = stages[l.stage] || { n: 0, v: 0 }; s.n++; s.v += Number(l.est_value || 0); });
    var qbo = integ.find(function (i) { return i.provider === "qbo"; }), ghl = integ.find(function (i) { return i.provider === "ghl"; });
    var stat = function (lab, num, sub) { return '<div class="bp6-card stat"><div class="lab">' + lab + '</div><div class="num">' + num + "</div>" + (sub ? '<div class="bp6-text-muted bp6-text-small">' + sub + "</div>" : "") + "</div>"; };
    body.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;margin-bottom:12px"><h3 class="bp6-heading" style="margin:0">This week</h3><span class="bp6-text-muted">since Mon ' + wk + (qbo && qbo.status === "connected" ? " · QuickBooks live" : ' · <a href="#settings">QuickBooks not connected</a>') + "</span></div>" +
      '<div class="grid">' + stat("Leads in", leads.length, "not counting QuickBooks imports") + stat("Dialed", dialed + " <small>of " + leads.length + "</small>", calls + " outbound calls") + stat("Reached", connected, "calls over a minute") + stat("Booked", booked, appts.filter(function (a) { return a.kind === "home_visit"; }).length + " home visits") + stat("Show rate", past ? Math.round(showed / past * 100) + "%" : "—", showed + " of " + past + " that happened") + stat("Estimates", ests.length, "$" + ests.reduce(function (s, e) { return s + Number(e.total || 0); }, 0).toLocaleString()) + stat("Deposits", deposits.length, "$" + deposits.reduce(function (s, p) { return s + Number(p.amount || 0); }, 0).toLocaleString()) + stat("Cash collected", "$" + cash.toLocaleString(), pays.length + " payments") + "</div>" +
      '<div class="two"><div class="bp6-card"><h5 class="bp6-heading" style="margin:0 0 8px">Pipeline right now</h5><table class="bp6-html-table bp6-compact"><tbody>' + ["new", "working", "reached", "consult_booked", "consult_done", "home_booked", "home_done", "estimate_sent", "won", "nurture"].filter(function (k) { return stages[k]; }).map(function (k) { return "<tr><td>" + k.replace("_", " ") + '</td><td style="text-align:right"><b>' + stages[k].n + "</b></td><td style=\"text-align:right\" class=\"bp6-text-muted\">" + (stages[k].v ? "$" + stages[k].v.toLocaleString() : "") + "</td></tr>"; }).join("") + "</tbody></table></div>" +
      '<div class="bp6-card"><h5 class="bp6-heading" style="margin:0 0 8px">By source, this week</h5><table class="bp6-html-table bp6-compact bp6-html-table-striped"><thead><tr><th>Source</th><th>Leads</th><th>Dialed</th><th>Reached+</th></tr></thead><tbody>' + Object.keys(bySrc).map(function (k) { return "<tr><td>" + esc(srcLabel(k)) + "</td><td>" + bySrc[k].n + "</td><td>" + bySrc[k].dialed + "</td><td>" + bySrc[k].reached + "</td></tr>"; }).join("") + "</tbody></table></div></div>" +
      '<div class="bp6-card feed"><h5 class="bp6-heading" style="margin:0 0 8px">Focus &amp; end of day</h5>' + (reps.map(function (r) { return '<div class="item"><div class="hd"><span><b>' + r.report_date + " · " + (r.kind === "focus" ? "Focus" : "End of day") + "</b></span><span>" + fmtTime(r.posted_at) + "</span></div>" + esc((r.picks || []).join(" · ")) + (r.text ? " " + esc(r.text) : "") + (r.numbers && r.numbers.dials != null ? ' <span class="bp6-text-muted">(' + r.numbers.dials + " dials · " + r.numbers.booked + " booked)</span>" : "") + "</div>"; }).join("") || '<div class="bp6-text-muted">Nothing posted yet.</div>') + "</div>" +
      '<p class="bp6-text-muted bp6-text-small" style="margin-top:12px">GHL ' + (ghl && ghl.last_sync_at ? "synced " + ago(ghl.last_sync_at) : "not synced") + ".</p>";
    $$("#ownersBody a[href='#settings']").forEach(function (a) { a.onclick = function (e) { e.preventDefault(); show("settings"); }; });
  }

  // ---------- settings ----------
  async function loadSettings() {
    var body = $("#settingsBody"); var p = new URLSearchParams(location.search);
    var integ = await sb.rpc("desk_integration_status", { p_store: S.store }); var rows = integ.data || [];
    var qbo = rows.find(function (i) { return i.provider === "qbo"; }) || {}, ghl = rows.find(function (i) { return i.provider === "ghl"; }) || {}, slack = rows.find(function (i) { return i.provider === "slack"; }) || {};
    var msg = p.get("connected") ? '<div class="bp6-callout bp6-intent-success">QuickBooks connected. First import is running.</div>' : p.get("error") ? '<div class="bp6-callout bp6-intent-danger">QuickBooks: ' + esc(p.get("error")) + "</div>" : p.get("disconnected") ? '<div class="bp6-callout">QuickBooks disconnected.</div>' : "";
    body.innerHTML = msg + '<div class="bp6-card" style="margin-top:12px"><h5 class="bp6-heading">QuickBooks Online</h5><p>' + (qbo.status === "connected" ? "Connected" + (qbo.config && qbo.config.realm_id ? " · company " + esc(qbo.config.realm_id) : "") + (qbo.last_sync_at ? " · synced " + ago(qbo.last_sync_at) : "") : qbo.status === "error" ? "Problem: " + esc(qbo.last_error || "") : "Not connected") + "</p>" +
      '<a class="bp6-button bp6-intent-primary bp6-large" href="' + FN + "/qbo-connect?store_id=" + S.store + '">' + (qbo.status === "connected" ? "Reconnect QuickBooks" : "Connect QuickBooks") + "</a>" +
      '<p class="bp6-text-muted bp6-text-small" style="margin-top:10px">Whoever is the QuickBooks admin at ' + esc(S.storeName) + " clicks this once and signs in to Intuit. We read customers, estimates, invoices and payments. Nothing is written.</p></div>" +
      '<div class="bp6-card" style="margin-top:12px"><h5 class="bp6-heading">GHL</h5><p>' + (ghl.status === "connected" ? "Connected" + (ghl.last_sync_at ? " · synced " + ago(ghl.last_sync_at) : "") : "Not connected") + (ghl.last_error ? '<br><span class="bp6-text-muted">' + esc(ghl.last_error) + "</span>" : "") + "</p></div>" +
      '<div class="bp6-card" style="margin-top:12px"><h5 class="bp6-heading">Slack</h5><p>' + (slack.status === "connected" ? "Connected · new board tasks post to your channel" + (slack.last_error ? '<br><span class="bp6-text-muted">Last problem: ' + esc(slack.last_error) + "</span>" : "") : "Not connected") + "</p>" +
        (S.role === "owner" ? '<div class="bp6-input-group bp6-large"><input class="bp6-input" id="slackUrl" placeholder="https://hooks.slack.com/services/…" autocomplete="off"></div>' +
          '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button class="bp6-button bp6-intent-primary bp6-large" id="slackSave">' + (slack.status === "connected" ? "Change channel" : "Connect Slack") + "</button>" + (slack.status === "connected" ? '<button class="bp6-button bp6-minimal bp6-large" id="slackOff">Disconnect</button>' : "") + "</div>" : "") +
        '<p class="bp6-text-muted bp6-text-small" style="margin-top:10px">In Slack: create an app at api.slack.com/apps → Incoming Webhooks → turn on → Add New Webhook → pick the channel (e.g. #team-board) → copy the link and paste it here.</p></div>' +
      '<div class="bp6-card" style="margin-top:12px" id="pwCard"><h5 class="bp6-heading">Your password</h5>' + (RECOVERY ? '<div class="bp6-callout bp6-intent-primary">Set a new password to finish resetting it.</div>' : "") +
        '<div class="pw-row"><input class="bp6-input bp6-large" type="password" id="pwNew" autocomplete="new-password" placeholder="New password (8+ characters)" aria-label="New password"><input class="bp6-input bp6-large" type="password" id="pwNew2" autocomplete="new-password" placeholder="Type it again" aria-label="Type the new password again"></div>' +
        '<button class="bp6-button bp6-intent-primary bp6-large" id="pwSave">Save password</button></div>' +
      (S.role === "owner" ? '<div class="bp6-card" style="margin-top:12px"><h5 class="bp6-heading">Team</h5><p class="bp6-text-muted" style="margin:0">Who can sign in. Set or reset anyone’s password here.</p><div class="team-list" id="teamList"><p class="bp6-text-muted">Loading…</p></div>' +
        '<form class="team-form" id="teamForm" novalidate><div class="bp6-form-group" style="margin:0"><label class="bp6-label" for="tmName">Name</label><input class="bp6-input bp6-fill" id="tmName" autocomplete="off"></div>' +
        '<div class="bp6-form-group" style="margin:0"><label class="bp6-label" for="tmEmail">Email</label><input class="bp6-input bp6-fill" id="tmEmail" type="email" autocomplete="off"></div>' +
        '<div class="bp6-form-group" style="margin:0"><label class="bp6-label" for="tmAccess">Access</label><div class="bp6-html-select bp6-fill"><select id="tmAccess"><option value="owner">Owner — everything</option><option value="front_desk">Front desk</option><option value="team">Team member</option></select></div></div>' +
        '<div class="bp6-form-group" style="margin:0"><label class="bp6-label" for="tmPass">Password <span class="bp6-text-muted">(leave blank to keep theirs)</span></label><input class="bp6-input bp6-fill" id="tmPass" type="password" autocomplete="new-password"></div>' +
        '<label class="bp6-control bp6-checkbox full" style="margin:0"><input type="checkbox" class="bp6-control-input" id="tmShow"><span class="bp6-control-indicator"></span>Show password</label>' +
        '<div class="full" style="display:flex;gap:8px;flex-wrap:wrap"><button type="submit" class="bp6-button bp6-intent-primary bp6-large" id="tmSave">Save login</button><button type="button" class="bp6-button bp6-large bp6-minimal" id="tmClear">Clear</button></div></form></div>' : "") +
      '<div class="bp6-card" style="margin-top:12px"><h5 class="bp6-heading">Help</h5><p>Something off? <a href="mailto:hello@mybuilder.ca">hello@mybuilder.ca</a> — include the lead’s name and what you expected.</p></div>' +
      '<p class="bp6-text-muted bp6-text-small" style="margin-top:12px">Signed in as ' + esc(S.user.email) + " · " + esc(S.storeName) + " · " + esc(S.deskRole || S.role) + "</p>";
    $("#pwSave").onclick = async function () {
      var a = $("#pwNew").value, b = $("#pwNew2").value;
      if (a.length < 8) { toast("Use at least 8 characters.", "warning"); return; }
      if (a !== b) { toast("The two passwords don’t match.", "warning"); return; }
      $("#pwSave").disabled = true;
      var r = await sb.auth.updateUser({ password: a });
      $("#pwSave").disabled = false;
      if (r.error) { toast("Couldn’t save: " + r.error.message, "danger"); return; }
      $("#pwNew").value = ""; $("#pwNew2").value = ""; RECOVERY = false; toast("Password saved. Use it next time you sign in."); loadSettings();
    };
    if (RECOVERY) setTimeout(function () { $("#pwNew").focus(); }, 50);
    if (S.role === "owner") loadTeam();
    var ss = $("#slackSave"); if (ss) ss.onclick = async function () {
      var url = $("#slackUrl").value.trim(); if (!url) { toast("Paste the Slack webhook link first.", "warning"); return; }
      ss.disabled = true; ss.textContent = "Checking…";
      try { await authedFetch("/board-notify", { action: "connect", store_id: S.store, webhook_url: url }); toast("Slack connected. Check the channel for a test message."); loadSettings(); }
      catch (e) { toast(e.message, "danger"); ss.disabled = false; ss.textContent = "Connect Slack"; }
    };
    var so = $("#slackOff"); if (so) so.onclick = async function () { if (!confirm("Stop posting board tasks to Slack?")) return; try { await authedFetch("/board-notify", { action: "disconnect", store_id: S.store }); toast("Slack disconnected."); loadSettings(); } catch (e) { toast(e.message, "danger"); } };
    if (p.toString()) history.replaceState(null, "", "/#settings");
  }

  // ---------- team (owners) ----------
  var ACCESS_LABEL = { owner: "Owner", front_desk: "Front desk", team: "Team member" };
  async function loadTeam() {
    var box = $("#teamList"); if (!box) return;
    try {
      var j = await authedFetch("/team-admin", { action: "list", store_id: S.store });
      var rows = (j.members || []).slice().sort(function (a, b) { return String(a.display_name).localeCompare(String(b.display_name)); });
      var html = rows.map(function (m) {
        return '<div class="team-row"><span class="nm">' + esc(m.display_name || "—") + (m.me ? ' <span class="bp6-text-muted">(you)</span>' : "") + '</span><span class="em">' + esc(m.email || "") + '</span><span class="bp6-tag bp6-minimal">' + ACCESS_LABEL[m.access] + '</span><span class="bp6-text-muted bp6-text-small">' + (m.last_sign_in_at ? "signed in " + esc(ago(m.last_sign_in_at)) : "never signed in") + '</span><span class="acts"><button class="bp6-button bp6-small bp6-minimal" data-tm-edit="' + esc(m.email || "") + '" data-name="' + esc(m.display_name || "") + '" data-access="' + m.access + '">Edit</button>' + (m.me ? "" : '<button class="bp6-button bp6-small bp6-minimal bp6-intent-danger" data-tm-rm="' + m.user_id + '" data-name="' + esc(m.display_name || "") + '">Remove</button>') + "</span></div>";
      }).join("") + (j.pending || []).map(function (i) {
        return '<div class="team-row"><span class="nm">' + esc(i.display_name || "—") + '</span><span class="em">' + esc(i.email) + '</span><span class="bp6-tag bp6-minimal">' + ACCESS_LABEL[i.access] + '</span><span class="bp6-tag bp6-intent-warning bp6-minimal">no login yet</span><span class="acts"><button class="bp6-button bp6-small bp6-intent-primary" data-tm-edit="' + esc(i.email) + '" data-name="' + esc(i.display_name || "") + '" data-access="' + i.access + '">Create login</button></span></div>';
      }).join("");
      box.innerHTML = html || '<p class="bp6-text-muted">No one yet.</p>';
      $$("[data-tm-edit]", box).forEach(function (b) { b.onclick = function () { $("#tmName").value = b.dataset.name; $("#tmEmail").value = b.dataset.tmEdit; $("#tmAccess").value = b.dataset.access; $("#tmPass").focus(); $("#teamForm").scrollIntoView({ behavior: "smooth", block: "nearest" }); }; });
      $$("[data-tm-rm]", box).forEach(function (b) { b.onclick = async function () { if (!confirm("Take " + b.dataset.name + " off Front Desk? They won’t be able to see anything.")) return; try { await authedFetch("/team-admin", { action: "remove", store_id: S.store, user_id: b.dataset.tmRm }); toast(b.dataset.name + " removed."); loadTeam(); } catch (e) { toast(e.message, "danger"); } }; });
    } catch (e) { box.innerHTML = '<div class="bp6-callout bp6-intent-warning">Couldn’t load the team: ' + esc(e.message) + "</div>"; }
    var f = $("#teamForm"); if (!f || f.dataset.bound) return; f.dataset.bound = "1";
    $("#tmShow").onchange = function () { $("#tmPass").type = $("#tmShow").checked ? "text" : "password"; };
    $("#tmClear").onclick = function () { $("#tmName").value = ""; $("#tmEmail").value = ""; $("#tmPass").value = ""; $("#tmAccess").value = "team"; };
    f.addEventListener("submit", async function (e) {
      e.preventDefault();
      var name = $("#tmName").value.trim(), email = $("#tmEmail").value.trim(), pw = $("#tmPass").value;
      if (!name || !email) { toast("Name and email first.", "warning"); return; }
      $("#tmSave").disabled = true; $("#tmSave").textContent = "Saving…";
      try {
        var r = await authedFetch("/team-admin", { action: "save", store_id: S.store, email: email, display_name: name, access: $("#tmAccess").value, password: pw || null });
        toast(r.created ? "Login created for " + name + "." : (r.password_set ? "Password reset for " + name + "." : name + " saved."));
        $("#tmName").value = ""; $("#tmEmail").value = ""; // password stays so you can set several people in a row
        loadTeam();
      } catch (err) { toast(err.message, "danger"); }
      $("#tmSave").disabled = false; $("#tmSave").textContent = "Save login";
    });
  }

  boot();
})();
