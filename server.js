// SwingPulse server
// - Fetches live prices for your watchlist and calculates BUY / SELL / Target / EXIT signals itself
// - Also accepts TradingView webhook alerts (optional) at /tv-alert
// - Streams everything live to the app on your phone and computer
// No packages needed. Requires Node.js 18 or newer.  Start:  node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const E = require('./engine');
const SC = require('./scanner');
const M = require('./model');
const ST = require('./strategies');

const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.SECRET_KEY || '';
// Where saved files live. On a cloud server set DATA_DIR to a persistent disk (e.g. /var/data).
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* exists */ }
const DATA_FILE = path.join(DATA_DIR, 'data.json');
// Public address when running online (Render sets RENDER_EXTERNAL_URL automatically; or set PUBLIC_URL yourself)
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
// Optional password so only you can open the app when it is online
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const crypto = require('crypto');
const AUTH_TOKEN = APP_PASSWORD ? crypto.createHash('sha256').update('swingpulse|' + APP_PASSWORD).digest('hex') : '';

// ---------- push notifications (reach the phone even when the app is closed) ----------
let webpush = null;
try { webpush = require('web-push'); } catch (e) { webpush = null; }
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json'), PUSH_FILE = path.join(DATA_DIR, 'push.json');
let vapid = null, pushSubs = [];
if (webpush) {
  try { vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')); } catch (e) { vapid = webpush.generateVAPIDKeys(); try { fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid)); } catch (e2) { /* ignore */ } }
  webpush.setVapidDetails('mailto:swingpulse@example.com', vapid.publicKey, vapid.privateKey);
  try { pushSubs = JSON.parse(fs.readFileSync(PUSH_FILE, 'utf8')); if (!Array.isArray(pushSubs)) pushSubs = []; } catch (e) { pushSubs = []; }
}
function savePush() { fs.writeFile(PUSH_FILE, JSON.stringify(pushSubs), () => {}); }
function sendPush(payload) {
  if (!webpush || !pushSubs.length) return;
  const body = JSON.stringify(payload);
  for (const sub of pushSubs.slice()) {
    webpush.sendNotification(sub, body, { TTL: 900, urgency: 'high' }).catch((err) => {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) { pushSubs = pushSubs.filter((x) => x.endpoint !== sub.endpoint); savePush(); }
    });
  }
}
const fmtN = (n) => (n == null ? '–' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }));
function pushSignal(sig) {
  const title = { BUY: '▲ BUY ', SELL: '▼ SELL ', T1: 'Target 1 hit · ', EXIT: 'EXIT · ' }[sig.event] + sig.symbol + (sig.test ? ' (test)' : '');
  const body = sig.event === 'BUY' || sig.event === 'SELL' ? `Entry ${fmtN(sig.entry)} · SL ${fmtN(sig.sl)} · T1 ${fmtN(sig.t1)} · T2 ${fmtN(sig.t2)}` : (sig.note || '');
  sendPush({ title, body, tag: sig.id, url: '/' });
}
const PUBLIC_DIR = path.join(__dirname, 'public');
const SIGNAL_TF = '5m', SIGNAL_SEC = 300;

const DEFAULT_WATCHLIST = ['NSE:RELIANCE', 'NSE:HDFCBANK', 'NSE:ICICIBANK', 'NSE:SBIN', 'NSE:TCS', 'NSE:INFY', 'NSE:NIFTY', 'BSE:SENSEX'];

// ---------- storage ----------
let state = { watchlist: DEFAULT_WATCHLIST.slice(), trades: {}, history: [], signals: [], settings: { need: 5 } };
try { state = Object.assign(state, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) { /* first run */ }
state.settings = Object.assign({ need: 5, amount: 100000, charges: 65, adxFilter: true, confirm: true }, state.settings);
ST.setFilters({ adxMin: state.settings.adxFilter ? 20 : 0, confirm: state.settings.confirm });   // rules to avoid false trades   // money per trade: amount and charges (buy + sell)
if (!Array.isArray(state.scanList) || !state.scanList.length) state.scanList = SC.DEFAULT_SCAN_LIST.slice();
if (!Array.isArray(state.learn)) state.learn = [];   // the model's own finished picks (its lessons)
let saveTimer = null;
// ---------- trade journal (permanent history, kept in journal.json) ----------
const JOURNAL_FILE = path.join(DATA_DIR, 'journal.json');
let journal = [];
try { journal = JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf8')); if (!Array.isArray(journal)) journal = []; } catch (e) { journal = []; }
for (const j of journal) { j.t2Hit = /Target 2/i.test(j.reason || ''); j.t1Hit = !!j.t1Hit || j.t2Hit; j.outcome = j.t2Hit ? 'T2' : j.t1Hit ? 'T1' : 'FAIL'; }
let jTimer = null;
function saveJournal() { clearTimeout(jTimer); jTimer = setTimeout(() => fs.writeFile(JOURNAL_FILE, JSON.stringify(journal), () => {}), 300); }
const CHARGES_1L = require('./compare_exits').charges(100000);
// e: { id, source, symbol, side, recAt (ISO), entry, sl, t1, t2, exitAt (ISO), exitPx, reason, pts, t1Hit }
function journalAdd(e) {
  if (!e || !e.id || journal.some((j) => j.id === e.id)) return false;
  const day = E.ist(Math.floor(new Date(e.recAt).getTime() / 1000)).day;
  const pctGross = e.entry ? (e.pts / e.entry) * 100 : 0;
  const rupees = Math.round((pctGross / 100) * 100000 - CHARGES_1L);
  const t2Hit = /Target 2/i.test(e.reason || '');
  const t1Hit = !!e.t1Hit || t2Hit;          // reaching Target 2 means Target 1 was passed too
  journal.push(Object.assign({ day, taken: false }, e, {
    pctGross: Math.round(pctGross * 1000) / 1000, rupees, success: rupees > 0, t1Hit, t2Hit,
    outcome: t2Hit ? 'T2' : t1Hit ? 'T1' : 'FAIL'   // ✓✓ success at Target 2 · ✓ success at Target 1 · ✗ failed
  }));
  saveJournal();
  broadcast('journal', { day });
  return true;
}
function journalDays() {
  const by = {};
  for (const j of journal) {
    const d = (by[j.day] = by[j.day] || { day: j.day, n: 0, wins: 0, t1: 0, t2: 0, failed: 0, rupees: 0, takenN: 0, takenWins: 0, takenRupees: 0 });
    d.n++; if (j.success) d.wins++; d.rupees += j.rupees;
    if (j.outcome === 'T2') d.t2++; else if (j.outcome === 'T1') d.t1++; else d.failed++;
    if (j.taken) { d.takenN++; if (j.success) d.takenWins++; d.takenRupees += j.rupees; }
  }
  return Object.values(by).sort((a, b) => (a.day < b.day ? 1 : -1));
}

function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => fs.writeFile(DATA_FILE, JSON.stringify(state, null, 2), () => {}), 300); }

// live-only data (not saved)
const quotes = {};
const feed = { ok: null, error: '', lastUpdate: null, source: 'Yahoo Finance (may be a few minutes delayed)' };
const seen = new Set(state.signals.filter((s) => s.key).map((s) => s.key));

// ---------- live stream (Server-Sent Events) ----------
const clients = new Set();
function broadcast(type, payload) { const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`; for (const res of clients) res.write(msg); }
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

// ---------- signals ----------
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const bare = (s) => String(s || '').toUpperCase().replace(/^.*:/, '').trim();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function normalise(raw) {
  const ev = String(raw.event || raw.side || '').toUpperCase();
  let event = null;
  if (ev.startsWith('BUY') || ev === 'LONG') event = 'BUY';
  else if (ev.startsWith('SELL') || ev === 'SHORT') event = 'SELL';
  else if (ev.includes('TARGET 1') || ev === 'T1') event = 'T1';
  else if (ev.startsWith('EXIT')) event = 'EXIT';
  if (!event) return null;
  return { id: newId(), event, symbol: bare(raw.symbol || raw.ticker), tf: String(raw.tf || ''),
    entry: num(raw.entry), sl: num(raw.sl), t1: num(raw.t1), t2: num(raw.t2), price: num(raw.price),
    note: String(raw.note || '').replace(/^\s*\|\s*/, ''), test: !!raw.test, source: raw.source || 'tradingview',
    at: raw.at || new Date().toISOString(), key: raw.key2 || null };
}

function apply(sig, silent) {
  const sym = sig.symbol; const tr = state.trades[sym];
  if (sig.event === 'BUY' || sig.event === 'SELL') {
    state.trades[sym] = { symbol: sym, side: sig.event === 'BUY' ? 'LONG' : 'SHORT', tf: sig.tf, entry: sig.entry, sl: sig.sl, t1: sig.t1, t2: sig.t2,
      t1Hit: false, openedAt: sig.at, test: sig.test, source: sig.source, origSl: sig.sl, x: sig.x || null, p: sig.p == null ? null : sig.p };
  } else if (sig.event === 'T1' && tr) {
    tr.t1Hit = true; tr.sl = tr.entry;
  } else if (sig.event === 'EXIT' && tr) {
    const m = sig.note.match(/([+-]?\d+(\.\d+)?)\s*pts/);
    state.history.unshift(Object.assign({}, tr, { closedAt: sig.at, reason: sig.note.split('|')[0].trim() || 'Exit', pts: m ? parseFloat(m[1]) : null }));
    if (!tr.test && m && tr.x) addLesson({ key: `sig|${sym}|${tr.openedAt}`, src: 'Signal', day: E.ist(Math.floor(new Date(tr.openedAt).getTime() / 1000)).day, x: tr.x, p: tr.p, pts: parseFloat(m[1]), entry: tr.entry, risk: Math.abs(tr.entry - (tr.origSl != null ? tr.origSl : tr.sl)) });
    if (!tr.test && m) journalAdd({ id: `sig|${sym}|${tr.openedAt}`, source: tr.source === 'tradingview' ? 'TradingView' : 'Signal', symbol: sym, side: tr.side === 'LONG' ? 'BUY' : 'SELL',
      recAt: tr.openedAt, entry: tr.entry, sl: tr.origSl != null ? tr.origSl : tr.sl, t1: tr.t1, t2: tr.t2, exitAt: sig.at, exitPx: sig.price, reason: sig.note.split('|')[0].trim() || 'Exit', pts: parseFloat(m[1]), t1Hit: !!tr.t1Hit });
    state.history = state.history.slice(0, 300);
    delete state.trades[sym];
  }
  if (sym && !state.watchlist.some((w) => bare(w) === sym)) state.watchlist.push('NSE:' + sym);
  if (sig.key) seen.add(sig.key);
  state.signals.unshift(sig);
  state.signals.sort((a, b) => (a.at < b.at ? 1 : -1));
  state.signals = state.signals.slice(0, 500);
  save();
  if (silent) broadcast('state', state); else { broadcast('signal', { signal: sig, state }); pushSignal(sig); }
}

// ---------- built-in price feed + signal engine ----------
const candleCache = {}; // key sym|tf -> { at, data }
async function getCandles(sym, tf) {
  const k = sym + '|' + tf, c = candleCache[k];
  if (c && Date.now() - c.at < 15000) return c.data;
  const data = await E.fetchCandles(sym, tf);
  candleCache[k] = { at: Date.now(), data };
  return data;
}
function costPct() { const a = state.settings.amount || 100000, c = state.settings.charges != null ? state.settings.charges : 65; return (c / a) * 100; }
function cfg() { return Object.assign({}, E.DEFAULT_CFG, { need: state.settings.need, costPct: costPct(), adxMin: state.settings.adxFilter ? 20 : 0, confirm: !!state.settings.confirm }); }

// ---------- learning from mistakes: every finished recommendation becomes a lesson ----------
// A lesson = what the model saw at entry (x), what it predicted (p) and whether the trade made money AFTER your charges (y).
function addLesson({ key, src, day, x, p, pts, entry, risk }) {
  x = M.upgradeX(x);
  if (!Array.isArray(x) || x.length !== M.FEATURES.length || !entry) return;
  if (state.learn.some((l) => l.key === key)) return;
  const pct = (pts / entry) * 100, net = pct - costPct();
  state.learn.push({ key, src, day, x, y: net > 0 ? 1 : 0, r: risk ? pts / risk : 0, p: p == null ? null : Math.round(p * 1000) / 1000, pct: Math.round(pct * 10000) / 10000, net: Math.round(net * 1000) / 1000, at: new Date().toISOString() });
  state.learn = state.learn.slice(-4000);
  liveSinceTrain++;
}
function predictNow(x) { const v = M.predict(state.model, x); return v == null ? null : v; }
function marketOpen() {
  const t = E.ist(Math.floor(Date.now() / 1000));
  return t.dow >= 1 && t.dow <= 5 && t.min >= 9 * 60 + 10 && t.min <= 15 * 60 + 40;
}

function closeStaleTrades() {
  const today = E.todayIST();
  for (const sym of Object.keys(state.trades)) {
    const tr = state.trades[sym];
    if (E.ist(Math.floor(new Date(tr.openedAt).getTime() / 1000)).day !== today) {
      apply(normalise({ event: 'EXIT', symbol: sym, entry: tr.entry, sl: tr.sl, t1: tr.t1, t2: tr.t2, note: 'Square-off (previous day)', source: tr.source }), true);
    }
  }
}

async function pollSymbol(w) {
  const sym = bare(w);
  const data = await getCandles(w, SIGNAL_TF);
  const a = E.analyse(data, SIGNAL_SEC, cfg(), w);
  const chg = data.price != null && data.prevClose ? ((data.price - data.prevClose) / data.prevClose) * 100 : null;
  quotes[sym] = { price: data.price, chgPct: chg, up: a.rules.up, dn: a.rules.dn, noVol: a.noVol, name: data.name, at: new Date().toISOString() };
  const nowSec = Math.floor(Date.now() / 1000);
  for (const ev of a.events) {
    const key = `auto|${sym}|${ev.time}|${ev.event}`;
    if (seen.has(key)) continue;
    const closeSec = ev.time + SIGNAL_SEC;
    const live = nowSec - closeSec < SIGNAL_SEC * 2 + 60;
    const sig = normalise({ event: ev.event, symbol: sym, tf: '5', entry: ev.entry, sl: ev.sl, t1: ev.t1, t2: ev.t2, price: ev.price,
      note: ev.note, source: 'auto', at: new Date(closeSec * 1000).toISOString(), key2: key });
    if (ev.rules) sig.rules = ev.rules;
    if (ev.event === 'BUY' || ev.event === 'SELL') {
      try {
        const i = a.closed.findIndex((b) => b.time === ev.time);
        if (i >= 0) { const h = histCache[w] || histCache[sym]; sig.x = SC.featuresAt(w, a.closed, a.ind, i, ev.event, cfg(), h && h.daily); sig.p = predictNow(sig.x); }
      } catch (e) { /* learning extra only */ }
    }
    apply(sig, !live);
  }
}

let polling = false;
async function poll() {
  if (polling) return; polling = true;
  try {
    closeStaleTrades();
    let okCount = 0, lastErr = '';
    for (const w of state.watchlist.slice()) {
      try { await pollSymbol(w); okCount++; } catch (e) { lastErr = `${bare(w)}: ${e.message}`; }
      await new Promise((r) => setTimeout(r, 250));
    }
    feed.ok = okCount > 0 || state.watchlist.length === 0;
    feed.error = lastErr;
    feed.lastUpdate = new Date().toISOString();
    if (!feed.ok) console.log('Price feed problem:', lastErr);
  } finally {
    polling = false;
    broadcast('quotes', { quotes, feed, marketOpen: marketOpen() });
    setTimeout(poll, marketOpen() ? 20000 : 300000);
  }
}

// ---------- scanner: intraday picks at 9:30, 10:00 ... 14:30 with tracked results ----------
const scan = { at: null, day: null, rounds: [], summary: null, nextRound: null, scanned: 0, failed: [], running: false, done: 0, total: 0 };
const histCache = {}; // sym -> { day, res, daily }
let strategyTable = null; // ranked strategies (from the month-long test)
let scanTimer = null;
function modelInfo() {
  const m = state.model; if (!m) return null;
  const { w, gb, iso, ...info } = m; return Object.assign(info, { report: modelReport() });   // the big model internals stay on the server
}
// "Model report": how its predictions compared with what really happened (profit after your charges)
function modelReport() {
  const L = state.learn.filter((l) => l.src);   // lessons recorded by this version (older ones have no source)
  const rate = (list) => (list.length ? Math.round((list.filter((l) => l.y === 1).length / list.length) * 100) : null);
  const pred = (list) => { const q = list.filter((l) => l.p != null); return q.length ? Math.round((q.reduce((a, l) => a + l.p, 0) / q.length) * 100) : null; };
  const bySource = ['Pick', 'Momentum', 'Signal'].map((src) => { const l = L.filter((x) => x.src === src); return { src, n: l.length, actual: rate(l), predicted: pred(l) }; });
  const buckets = [[0, 0.5, 'under 50%'], [0.5, 0.6, '50–60%'], [0.6, 0.7, '60–70%'], [0.7, 1.01, '70% +']].map(([a, b, label]) => {
    const l = L.filter((x) => x.p != null && x.p >= a && x.p < b); return { label, n: l.length, predicted: pred(l), actual: rate(l) };
  });
  const weekOf = (d) => { const t = new Date(d + 'T00:00:00Z'); const wd = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - wd); return t.toISOString().slice(0, 10); };
  const wk = {}; for (const l of L) (wk[weekOf(l.day)] = wk[weekOf(l.day)] || []).push(l);
  const weeks = Object.keys(wk).sort().slice(-8).map((w) => { const l = wk[w]; const pr = pred(l), ac = rate(l); return { week: w, n: l.length, predicted: pr, actual: ac, gap: pr != null && ac != null ? ac - pr : null }; });
  const checks = (state.modelHistory || []).filter((h) => h.check).slice(-10).map((h) => ({ at: h.at, cutoff: h.cutoff, rate: h.check.rate, n: h.check.n, baseRate: h.baseRate }));
  return { lessons: L.length, profitRate: rate(L), bySource, buckets, weeks, checks, costPct: Math.round(costPct() * 1000) / 1000, amount: state.settings.amount, charges: state.settings.charges };
}
function scanSummary() { const { running, done, total, at, day, rounds, summary, nextRound, scanned, failed, momentum } = scan; return { running, done, total, at, day, rounds, summary, nextRound, scanned, failed, momentum, autoWatch: !!state.settings.autoWatch, marketOpen: marketOpen(), today: E.todayIST(), model: modelInfo(), strategies: strategyTable }; }
let liveSinceTrain = 0;
function retrain(today) {
  const samples = [];
  for (const sym of Object.keys(histCache)) { const r = histCache[sym].res; if (r && r.samples) samples.push(...r.samples); }
  for (const l of state.learn) samples.push({ day: l.day, x: l.x, y: l.y, r: l.r, w: 2, live: true }); // its own finished recommendations count double
  if (samples.length < 30) return;
  const t0 = Date.now();
  state.model = Object.assign(M.train(samples), { trainedDay: today });
  liveSinceTrain = 0;
  if (!Array.isArray(state.modelHistory)) state.modelHistory = [];
  const mc = state.model.check;
  state.modelHistory.push({ at: state.model.at, day: today, cutoff: state.model.cutoff, check: mc ? { n: mc.n, rate: mc.rate } : null, baseRate: state.model.baseRate, trainedOn: state.model.trainedOn, lessons: state.learn.length });
  state.modelHistory = state.modelHistory.slice(-120);
  save();
  const ch = state.model.check;
  console.log(`  Model trained on ${samples.length} trades in ${Date.now() - t0} ms` + (ch ? ` · check on last 5 days: picks rated ${Math.round(state.model.cutoff * 100)}%+ won ${ch.rate}% (${ch.wins}/${ch.n})` : ''));
}
// Auto-add the top momentum stocks (5 up + 5 down) to the watchlist so their BUY / SELL popups come automatically.
// Stocks added this way are marked as auto, and are removed again when they drop out (unless a trade is open).
function applyAutoWatch(mom) {
  if (!Array.isArray(state.autoWatch)) state.autoWatch = [];
  if (!state.settings.autoWatch || !marketOpen()) return;
  const want = mom.up.filter((x) => !x.stretched).slice(0, 5).concat(mom.down.filter((x) => !x.stretched).slice(0, 5)).map((x) => 'NSE:' + x.symbol);
  const has = (w) => state.watchlist.some((v) => bare(v) === bare(w));
  let changed = false;
  for (const w of want) if (!has(w)) { state.watchlist.push(w); state.autoWatch.push(w); changed = true; }
  for (const w of state.autoWatch.slice()) {
    if (want.includes(w) || state.trades[bare(w)]) continue;
    state.watchlist = state.watchlist.filter((v) => v !== w); state.autoWatch = state.autoWatch.filter((v) => v !== w); changed = true;
  }
  if (changed) { save(); broadcast('state', state); setTimeout(poll, 500); }
}

// Follow the top 5 up + top 5 down momentum recommendations like trades (same exits as Model A) and journal the result.
function trackMomentum(mom, stocks) {
  if (!Array.isArray(state.momTrack)) state.momTrack = [];
  const today = E.todayIST();
  if (marketOpen()) {
    for (const x of mom.up.filter((y) => !y.stretched).slice(0, 5).concat(mom.down.filter((y) => !y.stretched).slice(0, 5))) {
      const key = `${today}|${x.symbol}|${x.side}`;
      if (state.momTrack.some((t) => t.key === key) || journal.some((j) => j.id === 'mom|' + key)) continue;   // once per stock and side per day
      let fx = null, fp = null;
      try {
        const st = stocks.find((y) => bare(y.sym) === x.symbol);
        if (st) { const c = st.data.candles.filter((b) => b.time + 300 <= x.time); const h = histCache[st.sym]; fx = SC.featuresAt(st.sym, c, E.indicators(c, cfg()), c.length - 1, x.side, cfg(), h && h.daily); fp = predictNow(fx); }
      } catch (e) { fx = null; }
      state.momTrack.push({ key, symbol: x.symbol, side: x.side, recTime: x.time, levels: x.levels, x: fx, p: fp });
    }
  }
  const bySym = {}; for (const st of stocks) bySym[bare(st.sym)] = st.data;
  for (const t of state.momTrack.slice()) {
    const data = bySym[t.symbol];
    const ageDays = (Date.now() / 1000 - t.recTime) / 86400;
    if (!data) { if (ageDays > 2) state.momTrack = state.momTrack.filter((y) => y !== t); continue; }
    const now = Math.floor(Date.now() / 1000);
    const c = data.candles.filter((b) => b.time + 300 <= now);
    const i = c.findIndex((b) => b.time + 300 === t.recTime);
    if (i < 0) { if (ageDays > 2) state.momTrack = state.momTrack.filter((y) => y !== t); continue; }
    const ind = E.indicators(c, cfg());
    const out = SC._t.simulate(c, ind, i + 1, c.length - 1, t.side, t.levels, cfg());
    if (out.status !== 'WON' && out.status !== 'LOST') continue;
    journalAdd({ id: 'mom|' + t.key, source: 'Momentum', symbol: t.symbol, side: t.side, recAt: new Date(t.recTime * 1000).toISOString(),
      entry: t.levels.entry, sl: t.levels.sl, t1: t.levels.t1, t2: t.levels.t2, exitAt: new Date((out.exitTime + 300) * 1000).toISOString(),
      exitPx: out.exitPx, reason: out.reason, pts: out.pts, t1Hit: !!out.t1Hit });
    addLesson({ key: 'mom|' + t.key, src: 'Momentum', day: t.key.split('|')[0], x: t.x, p: t.p, pts: out.pts, entry: t.levels.entry, risk: Math.abs(t.levels.entry - t.levels.sl) || 1 });
    state.momTrack = state.momTrack.filter((y) => y !== t);
  }
  save();
}

async function runScan() {
  if (scan.running) return;
  scan.running = true; scan.done = 0; scan.total = state.scanList.length;
  broadcast('scan', scanSummary());
  const today = E.todayIST(), stocks = [], failed = [], hist = {};
  for (const sym of state.scanList.slice()) {
    try {
      const data = await getCandles(sym, SIGNAL_TF);
      stocks.push({ sym, data });
      const h = histCache[sym];
      if (!h || h.day !== today) {
        let daily = null;
        try { daily = await E.fetchCandles(sym, '1d', '1y'); } catch (e) { daily = null; }   // for the 50-day SMA
        try { histCache[sym] = { day: today, daily, res: SC.backtest(sym, await E.fetchCandles(sym, '5m', '1mo'), cfg(), today, daily) }; }
        catch (e) { histCache[sym] = { day: today, daily, res: null }; }
        await new Promise((r) => setTimeout(r, 150));
      }
      hist[sym] = histCache[sym].res;
    } catch (e) { failed.push(sym); }
    scan.done++;
    if (scan.done % 10 === 0) broadcast('scan', scanSummary());
    await new Promise((r) => setTimeout(r, 150));
  }
  // older saved lessons/models from a previous version have fewer inputs: drop them and retrain
  for (const l of state.learn) l.x = M.upgradeX(l.x);
  state.learn = state.learn.filter((l) => Array.isArray(l.x) && l.x.length === M.FEATURES.length);
  const outdated = state.model && (!state.model.w || state.model.w.length !== M.FEATURES.length + 1);
  if (!state.model || outdated || state.model.trainedDay !== today || liveSinceTrain >= 5 || state.learn.length - (state.model.liveSamples || 0) >= 5) retrain(today);
  strategyTable = SC.rankStrategies(Object.values(hist));
  const dailyMap = {}; for (const sym of Object.keys(histCache)) dailyMap[sym] = histCache[sym].daily;
  const built = SC.buildDay(stocks, cfg(), hist, state.model, strategyTable.active, dailyMap);
  // live momentum ranking of every scanned stock
  try { scan.momentum = SC.momentumRank(stocks, cfg()); } catch (e) { scan.momentum = null; console.log('Momentum ranking failed:', e.message); }
  if (scan.momentum) { applyAutoWatch(scan.momentum); trackMomentum(scan.momentum, stocks); }
  // learn from finished picks: every success or failure becomes a training example
  for (const r of built.rounds) for (const x of r.picks.BUY.concat(r.picks.SELL)) {
    if (x.result.status !== 'WON' && x.result.status !== 'LOST') continue;
    const key = `${built.day}|${r.time}|${x.symbol}|${x.side}`;
    journalAdd({ id: 'pick|' + key, source: 'Pick ' + r.time, symbol: x.symbol, side: x.side, recAt: new Date(x.startTime * 1000).toISOString(),
      entry: x.levels.entry, sl: x.levels.sl, t1: x.levels.t1, t2: x.levels.t2, exitAt: new Date((x.result.exitTime + 300) * 1000).toISOString(),
      exitPx: x.result.exitPx, reason: x.result.reason, pts: x.result.pts, t1Hit: !!x.result.t1Hit, winChance: x.winChance });
    addLesson({ key, src: 'Pick', day: built.day, x: x.x, p: x.winChance != null ? x.winChance / 100 : null, pts: x.result.pts, entry: x.levels.entry, risk: Math.abs(x.levels.entry - x.levels.sl) || 1 });
  }
  state.learn = state.learn.slice(-3000);
  for (const r of built.rounds) for (const x of r.picks.BUY.concat(r.picks.SELL)) delete x.x;
  save();
  Object.assign(scan, built, { at: new Date().toISOString(), scanned: stocks.length, failed, running: false });
  // announce a new round with a popup
  const last = built.rounds[built.rounds.length - 1];
  if (last && built.day === today) {
    const tag = built.day + ' ' + last.time;
    const fresh = Date.now() / 1000 - last.at < (+process.env.ROUND_FRESH_MIN || 15) * 60;
    if (state.lastRound !== tag) {
      state.lastRound = tag; save();
      if (fresh) {
        const buys = last.picks.BUY.map((x) => x.symbol), sells = last.picks.SELL.map((x) => x.symbol);
        broadcast('round', { time: last.time, buys, sells });
        if (buys.length || sells.length) sendPush({ title: 'New intraday picks · ' + last.time, body: 'Buy: ' + (buys.join(', ') || '–') + ' · Sell: ' + (sells.join(', ') || '–'), tag: 'round' + last.time, url: '/' });
      }
    }
  }
  broadcast('scan', scanSummary());
  if (failed.length) console.log('Scanner could not load:', failed.join(', '));
}
function scheduleScan() {
  clearTimeout(scanTimer);
  const wait = marketOpen() ? (300 - ((Date.now() / 1000) % 300) + 25) * 1000 : 30 * 60 * 1000; // 25 s after each 5-min candle closes
  scanTimer = setTimeout(async () => { try { await runScan(); } finally { scheduleScan(); } }, wait);
}

// chart data for the app
async function chartData(sym, tf) {
  const tfMap = { '1': '1m', '5': '5m', '15': '15m', '60': '60m' };
  const interval = tfMap[tf] || '5m';
  const data = await getCandles(sym, interval);
  const ind = E.indicators(data.candles, E.DEFAULT_CFG);
  const days = [...new Set(data.candles.map((b) => E.ist(b.time).day))];
  const keepDays = interval === '1m' ? 1 : interval === '60m' ? 10 : 2;
  const from = days.slice(-keepDays)[0];
  const idx = data.candles.map((b, i) => i).filter((i) => E.ist(data.candles[i].time).day >= from);
  const pick = (arr) => idx.filter((i) => arr[i] != null).map((i) => ({ time: data.candles[i].time, value: Math.round(arr[i] * 100) / 100 }));
  return {
    symbol: bare(sym), interval, price: data.price, prevClose: data.prevClose, name: data.name,
    candles: idx.map((i) => data.candles[i]),
    emaF: pick(ind.emaF), emaS: pick(ind.emaS), vwap: pick(ind.vw), ema200: pick(ind.ema200),
    stUp: idx.map((i) => ({ time: data.candles[i].time, value: ind.dir[i] === -1 ? Math.round(ind.st[i] * 100) / 100 : undefined })),
    stDn: idx.map((i) => ({ time: data.candles[i].time, value: ind.dir[i] === 1 ? Math.round(ind.st[i] * 100) / 100 : undefined }))
  };
}

// ---------- phone links: same-Wi-Fi addresses + automatic Cloudflare link ----------
const links = { public: null, lan: [], tunnel: 'off', error: '' };
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/vethernet|virtualbox|vmware|docker|wsl|loopback|bluetooth/i.test(name)) continue;
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      out.push({ name, url: `http://${a.address}:${PORT}`, wifi: /wi-?fi|wlan|wireless/i.test(name) });
    }
  }
  return out.sort((a, b) => b.wifi - a.wifi);
}
let tunnelProc = null, tunnelTries = 0;
function startTunnel() {
  if (PUBLIC_URL) { links.public = PUBLIC_URL; links.tunnel = 'cloud'; return; }   // running online: fixed address, no tunnel needed
  if (process.env.NO_TUNNEL) return;
  const exe = path.join(__dirname, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (!fs.existsSync(exe)) { links.tunnel = 'missing'; return; }
  links.tunnel = 'starting'; links.public = null; broadcast('links', links);
  try { tunnelProc = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { windowsHide: true }); }
  catch (e) { links.tunnel = 'error'; links.error = e.message; return; }
  const onData = (buf) => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && links.public !== m[0]) {
      links.public = m[0]; links.tunnel = 'on'; tunnelTries = 0;
      console.log('');
      console.log('  PHONE LINK (works anywhere, also on mobile data):');
      console.log('  ' + links.public);
      console.log('  Or open SwingPulse → Setup and scan the QR code with your phone camera.');
      console.log('');
      broadcast('links', links);
    }
  };
  tunnelProc.stdout.on('data', onData); tunnelProc.stderr.on('data', onData);
  tunnelProc.on('error', (e) => { links.tunnel = 'error'; links.error = e.message; broadcast('links', links); });
  tunnelProc.on('exit', () => {
    tunnelProc = null; links.public = null; links.tunnel = 'off'; broadcast('links', links);
    if (++tunnelTries <= 5) setTimeout(startTunnel, 20000 * tunnelTries);
  });
}
function stopTunnel() { if (tunnelProc) { try { tunnelProc.kill(); } catch (e) { /* ignore */ } } }
process.on('exit', stopTunnel);
process.on('SIGINT', () => { stopTunnel(); process.exit(0); });
process.on('SIGTERM', () => { stopTunnel(); process.exit(0); });

// ---------- TradingView webhook parsing (optional) ----------
function readBody(req) {
  return new Promise((resolve) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 100000) req.destroy(); }); req.on('end', () => resolve(d)); });
}
function parseAlert(text) {
  try { return JSON.parse(text); } catch (e) { /* plain text */ }
  const t = String(text);
  const pick = (k) => { const m = t.match(new RegExp(k + '\\s*([0-9.]+)', 'i')); return m ? m[1] : null; };
  const head = t.split('|')[0].trim().split(/\s+/);
  let event = head[0], symIdx = 1;
  if (/^TARGET$/i.test(head[0])) { event = 'TARGET 1'; symIdx = 3; }
  return { event, symbol: head[symIdx], entry: pick('Entry'), sl: pick('SL'), t1: pick('T1'), t2: pick('T2'), note: t.split('|').slice(5).join('|'), key: (t.match(/key\s*[:=]\s*(\S+)/i) || [])[1] };
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const safeJson = (s) => { try { return JSON.parse(s || '{}'); } catch (e) { return {}; } };

// ---------- server ----------
function loginPage(res, msg) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0B0F14"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icon-192.png"><title>SwingPulse · Sign in</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0B0F14;color:#E6EDF3;font-family:Inter,system-ui,-apple-system,sans-serif;padding:16px;box-sizing:border-box}
form{width:100%;max-width:340px;background:#121922;border:1px solid #1E2935;border-radius:16px;padding:22px;display:flex;flex-direction:column;gap:12px}
h1{margin:0;font-size:22px}label{font-size:13px;color:#93A1AF}input{height:46px;border-radius:10px;border:1px solid #243140;background:#0B0F14;color:#E6EDF3;padding:0 12px;font-size:16px}
button{height:48px;border:0;border-radius:10px;background:#4EA8FF;color:#071A2C;font-size:16px;font-weight:700;cursor:pointer}.err{color:#FF7A84;font-size:13px}</style></head>
<body><form method="post" action="/login"><h1>SwingPulse</h1><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
${msg ? `<div class="err">${msg}</div>` : ''}<button type="submit">Sign in</button></form></body></html>`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  // ---- health check and login (when APP_PASSWORD is set) ----
  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (APP_PASSWORD) {
    const open = p === '/login' || p === '/tv-alert' || p === '/manifest.webmanifest' || p === '/sw.js' || /^\/icon[\w.-]*\.(png|svg)$/.test(p);
    const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((x) => x[0]));
    const authed = cookies.sp_auth === AUTH_TOKEN;
    if (p === '/login' && req.method === 'POST') {
      const body = new URLSearchParams(await readBody(req));
      if (body.get('password') === APP_PASSWORD) {
        const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
        res.writeHead(302, { 'Set-Cookie': `sp_auth=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`, Location: '/' });
        return res.end();
      }
      return loginPage(res, 'Wrong password, try again.');
    }
    if (p === '/login') return loginPage(res, '');
    if (!open && !authed) {
      if (p.startsWith('/api') || p === '/events') return json(res, 401, { ok: false, error: 'login needed' });
      res.writeHead(302, { Location: '/login' }); return res.end();
    }
  }
  try {
    if (req.method === 'POST' && p === '/tv-alert') {
      const raw = parseAlert(await readBody(req));
      if (SECRET_KEY && raw.key !== SECRET_KEY) return json(res, 401, { ok: false, error: 'bad key' });
      const sig = normalise(Object.assign({}, raw, { source: 'tradingview' }));
      if (!sig || !sig.symbol) return json(res, 400, { ok: false, error: 'unrecognised alert' });
      apply(sig, false);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/test') {
      const sig = normalise(Object.assign({}, safeJson(await readBody(req)), { test: true, source: 'test' }));
      if (!sig || !sig.symbol) return json(res, 400, { ok: false });
      apply(sig, false);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/state') return json(res, 200, state);
    if (p === '/api/push/key') return json(res, 200, { enabled: !!webpush, key: vapid ? vapid.publicKey : null, subscribers: pushSubs.length });
    if (p === '/api/push/subscribe' && req.method === 'POST') {
      const sub = safeJson(await readBody(req)).subscription;
      if (!webpush || !sub || !sub.endpoint || !sub.keys) return json(res, 400, { ok: false });
      if (!pushSubs.some((x) => x.endpoint === sub.endpoint)) { pushSubs.push(sub); pushSubs = pushSubs.slice(-20); savePush(); }
      return json(res, 200, { ok: true });
    }
    if (p === '/api/push/test' && req.method === 'POST') { sendPush({ title: 'SwingPulse test notification', body: 'Push notifications are working on this device.', tag: 'test', url: '/' }); return json(res, 200, { ok: true, subscribers: pushSubs.length }); }
    if (p === '/api/journal' && req.method === 'GET') {
      const day = url.searchParams.get('day');
      const running = Object.keys(state.trades).length + (state.momTrack || []).length +
        (scan.rounds || []).reduce((a, r) => a + r.picks.BUY.concat(r.picks.SELL).filter((x) => x.result.status === 'OPEN' || x.result.status === 'T1').length, 0);
      return json(res, 200, { days: journalDays(), trades: day ? journal.filter((j) => j.day === day).sort((a, b) => (a.recAt < b.recAt ? -1 : 1)) : [], running, chargesPer1L: Math.round(CHARGES_1L * 100) / 100 });
    }
    if (p === '/api/journal/all' && req.method === 'GET') return json(res, 200, journal);
    if (p === '/api/journal/taken' && req.method === 'POST') {
      const body = safeJson(await readBody(req));
      const j = journal.find((x) => x.id === body.id);
      if (j) { j.taken = !!body.taken; saveJournal(); }
      return json(res, 200, { ok: !!j });
    }
    if (p === '/api/links') { links.lan = lanAddresses(); return json(res, 200, links); }
    if (p === '/api/scan' && req.method === 'GET') return json(res, 200, scanSummary());
    if (p === '/api/scan/run' && req.method === 'POST') { runScan(null); return json(res, 200, { ok: true }); }
    if (p === '/api/scanlist' && req.method === 'POST') {
      const body = safeJson(await readBody(req));
      if (body.reset) state.scanList = SC.DEFAULT_SCAN_LIST.slice();
      else if (Array.isArray(body.list)) state.scanList = [...new Set(body.list.map((s) => String(s).toUpperCase().trim()).filter(Boolean))].slice(0, 200);
      save(); broadcast('state', state);
      return json(res, 200, { ok: true, count: state.scanList.length });
    }
    if (p === '/api/chart') {
      const sym = url.searchParams.get('symbol') || 'NSE:RELIANCE';
      try {
        const d = await chartData(sym, url.searchParams.get('tf') || '5');
        try { const h = histCache[sym.replace(/^NSE:/, '')] || histCache[sym]; d.suggest = SC.suggestNow(sym, await getCandles(sym, SIGNAL_TF), cfg(), h && h.res, state.model, strategyTable && strategyTable.active, h && h.daily); } catch (e) { d.suggest = null; }
        return json(res, 200, d);
      }
      catch (e) { return json(res, 200, { error: e.message }); }
    }
    if (req.method === 'POST' && p === '/api/watchlist') {
      const body = safeJson(await readBody(req));
      if (Array.isArray(body.watchlist)) {
        state.watchlist = body.watchlist.map((s) => String(s).toUpperCase().trim()).filter(Boolean).slice(0, 60);
        save(); broadcast('state', state);
        setTimeout(poll, 200);
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/settings') {
      const body = safeJson(await readBody(req));
      if (typeof body.autoWatch === 'boolean') {
        state.settings.autoWatch = body.autoWatch;
        if (!body.autoWatch && Array.isArray(state.autoWatch)) { for (const w of state.autoWatch) if (!state.trades[bare(w)]) state.watchlist = state.watchlist.filter((v) => v !== w); state.autoWatch = []; }
        else if (scan.momentum) applyAutoWatch(scan.momentum);
        save(); broadcast('state', state); broadcast('scan', scanSummary());
      }
      if (typeof body.adxFilter === 'boolean' || typeof body.confirm === 'boolean') {
        if (typeof body.adxFilter === 'boolean') state.settings.adxFilter = body.adxFilter;
        if (typeof body.confirm === 'boolean') state.settings.confirm = body.confirm;
        ST.setFilters({ adxMin: state.settings.adxFilter ? 20 : 0, confirm: state.settings.confirm });
        for (const k of Object.keys(histCache)) histCache[k].day = '';   // re-test strategies with the new filters on the next scan
        if (state.model) state.model.trainedDay = null;
        save(); broadcast('state', state); setTimeout(poll, 200);
      }
      if ([3, 4, 5].includes(body.need)) { state.settings.need = body.need; save(); broadcast('state', state); }
      const amt = Number(body.amount), chg = Number(body.charges);
      if (Number.isFinite(amt) && amt >= 1000 && amt <= 1e8 && Number.isFinite(chg) && chg >= 0 && chg <= 100000) {
        const changed = state.settings.amount !== Math.round(amt) || state.settings.charges !== Math.round(chg * 100) / 100;
        state.settings.amount = Math.round(amt); state.settings.charges = Math.round(chg * 100) / 100; save(); broadcast('state', state);
        if (changed) {   // "success" now means profit after the new charges: re-test history and retrain on the next scan
          for (const k of Object.keys(histCache)) histCache[k].day = '';
          for (const l of state.learn) if (l.pct != null) { l.net = Math.round((l.pct - costPct()) * 1000) / 1000; l.y = l.net > 0 ? 1 : 0; }   // re-judge past lessons
          if (state.model) state.model.trainedDay = null;
        }
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/clear-tests') {
      state.signals = state.signals.filter((s) => !s.test);
      state.history = state.history.filter((h) => !h.test);
      for (const k of Object.keys(state.trades)) if (state.trades[k].test) delete state.trades[k];
      save(); broadcast('state', state);
      return json(res, 200, { ok: true });
    }
    if (p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
      res.write(`event: quotes\ndata: ${JSON.stringify({ quotes, feed, marketOpen: marketOpen() })}\n\n`);
      res.write(`event: scan\ndata: ${JSON.stringify(scanSummary())}\n\n`);
      links.lan = lanAddresses();
      res.write(`event: links\ndata: ${JSON.stringify(links)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    const file = path.normalize(path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { ok: false, error: 'server error' });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('');
    console.log(`  SwingPulse is already running in another window (port ${PORT} is busy).`);
    console.log('  Close the other black window, or run:  taskkill /F /IM node.exe /IM cloudflared.exe   and start again.');
    console.log('');
    process.exit(1);
  }
  throw e;
});
server.listen(PORT, () => {
  console.log('');
  console.log(`  SwingPulse is running.  Open  http://localhost:${PORT}  in Chrome.`);
  console.log('  Keep this window open while you use the app.');
  console.log('');
  links.lan = lanAddresses();
  startTunnel();
  if (!process.env.NO_FEED) { poll(); setTimeout(async () => { await runScan(null); scheduleScan(); }, 3000); }
});
