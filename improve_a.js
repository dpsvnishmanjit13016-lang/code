// SwingPulse: "Improve Model A" study — real data, honest check on unseen days
//
// PART 1  Which kinds of Model A trades make money?
//         Every Model A trade (Core 5 rules, 4+ of 5, your trend rules, current exits) is grouped by:
//         time of day, buy/sell, rules met, volume (RVOL), gap, stock's usual move (ATR), distance from VWAP,
//         how far the stock already moved today, stop-loss size, and NIFTY direction.
//         LEARN = first 2/3 of the days. CHECK = last 1/3 (never used for choosing). A group only counts if it made
//         money after charges in BOTH.
// PART 2  "Only high-probability trades": each trade gets a score from what was learned in the LEARN days,
//         then on the CHECK days we take only score > 0, or only the top 3 / 5 / 10 trades per day.
// PART 3  Same Model A rules on bigger candles: 15-minute (60 days) and 1-hour (about 2 years).
// PART 4  Every strategy on its own on about 2 years of 1-hour data (much bigger sample than 60 days).
//
// Money: rupees for a ₹1,00,000 trade, after Zerodha intraday charges (≈ ₹83 per trade).
// Run:  node improve_a.js      (about 6–12 minutes, needs internet)
const fs = require('fs');
const path = require('path');
const E = require('./engine');
const SC = require('./scanner');
const ST = require('./strategies');
const X = require('./compare_exits');
const T = SC._t;

const cfg = Object.assign({}, E.DEFAULT_CFG);
const POSITION = 100000;
const COST = X.charges(POSITION);
const EXIT = X.MODELS.A;
const r0 = (x) => Math.round(x);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

function summary(list) {
  const n = list.length; if (!n) return { n: 0 };
  const net = list.reduce((a, t) => a + t.net, 0), gross = list.reduce((a, t) => a + t.gross, 0);
  const pos = list.filter((t) => t.net > 0).reduce((a, t) => a + t.net, 0), neg = -list.filter((t) => t.net <= 0).reduce((a, t) => a + t.net, 0);
  const days = new Set(list.map((t) => t.day)).size;
  return { n, win: pct(list.filter((t) => t.net > 0).length, n), gross: r0(gross / n), net: r0(net / n), total: r0(net), perDay: r0(net / Math.max(days, 1)),
    tradesPerDay: Math.round((n / Math.max(days, 1)) * 10) / 10, pf: neg ? Math.round((pos / neg) * 100) / 100 : null };
}

// ---------- grouping ----------
const DIMS = {
  'Time of day': (t) => (t.min <= 600 ? '9:30–10:00' : t.min <= 690 ? '10:30–11:30' : t.min <= 780 ? '12:00–13:00' : '13:30–14:30'),
  'Buy or sell': (t) => t.side,
  'Rules met': (t) => (t.rules >= 5 ? '5 of 5' : '4 of 5'),
  'Volume today (RVOL)': (t) => (t.rvol == null ? 'unknown' : t.rvol < 1 ? 'below 1×' : t.rvol < 1.5 ? '1–1.5×' : t.rvol < 2.5 ? '1.5–2.5×' : '2.5× +'),
  'Opening gap': (t) => (t.gap == null ? 'unknown' : Math.abs(t.gap) < 0.5 ? 'under 0.5%' : t.gap * (t.side === 'BUY' ? 1 : -1) > 0 ? 'gap with trade' : 'gap against trade'),
  'Stock’s usual 5-min move (ATR)': (t) => (t.atrPct < 0.15 ? 'under 0.15%' : t.atrPct < 0.3 ? '0.15–0.3%' : '0.3% +'),
  'Distance from VWAP': (t) => (t.vwapDist < 0.3 ? 'under 0.3%' : t.vwapDist < 0.8 ? '0.3–0.8%' : '0.8% +'),
  'Move already made today': (t) => (t.moveWith < 0 ? 'against trade' : t.moveWith < 1 ? '0–1%' : t.moveWith < 2.5 ? '1–2.5%' : '2.5% +'),
  'Stop-loss size': (t) => (t.riskPct < 0.3 ? 'under 0.3%' : t.riskPct < 0.6 ? '0.3–0.6%' : '0.6% +'),
  'NIFTY direction': (t) => (t.nifty == null ? 'unknown' : t.nifty ? 'with trade' : 'against trade')
};

function analyseGroups(trades, split) {
  const learn = trades.filter((t) => t.day < split), check = trades.filter((t) => t.day >= split);
  const baseLearn = summary(learn).net || 0;
  const out = {};
  const weights = {};
  for (const [dim, fn] of Object.entries(DIMS)) {
    const keys = [...new Set(trades.map(fn))];
    out[dim] = keys.map((k) => {
      const L = summary(learn.filter((t) => fn(t) === k)), C = summary(check.filter((t) => fn(t) === k));
      return { group: k, learn: L, check: C, keep: L.n >= 100 && C.n >= 30 && L.net > 0 && C.net > 0 };
    }).sort((a, b) => (b.learn.net ?? -1e9) - (a.learn.net ?? -1e9));
    // score weight per group, shrunk toward zero when the group is small
    weights[dim] = Object.fromEntries(out[dim].map((g) => [g.group, g.learn.n ? ((g.learn.net - baseLearn) * g.learn.n) / (g.learn.n + 200) : 0]));
  }
  const score = (t) => Object.entries(DIMS).reduce((a, [dim, fn]) => a + (weights[dim][fn(t)] || 0), 0) + baseLearn;
  for (const t of trades) t.score = score(t);
  const topPerDay = (list, n) => {
    const byDay = {}; for (const t of list) (byDay[t.day] = byDay[t.day] || []).push(t);
    return Object.values(byDay).flatMap((d) => d.sort((a, b) => b.score - a.score).slice(0, n));
  };
  const selections = {
    'All Model A trades': [learn, check],
    'Only score above ₹0': [learn.filter((t) => t.score > 0), check.filter((t) => t.score > 0)],
    'Only score above ₹50': [learn.filter((t) => t.score > 50), check.filter((t) => t.score > 50)],
    'Top 10 trades per day': [topPerDay(learn, 10), topPerDay(check, 10)],
    'Top 5 trades per day': [topPerDay(learn, 5), topPerDay(check, 5)],
    'Top 3 trades per day': [topPerDay(learn, 3), topPerDay(check, 3)]
  };
  const sel = Object.fromEntries(Object.entries(selections).map(([k, [a, b]]) => [k, { learn: summary(a), check: summary(b) }]));
  return { groups: out, selections: sel };
}

// ---------- Model A trades on any timeframe ----------
function modelATrades(sym, c, daily, barMin, opts = {}) {
  const ind = E.indicators(c, cfg);
  const noVol = E.isIndex(sym) || c.slice(-60).every((b) => !b.volume);
  const ctx = { days: ST.dayInfo(c), sma50: ST.dailySma50Map(daily), noVol };
  const out = [];
  const dayLast = {}; for (let i = 0; i < c.length; i++) dayLast[E.ist(c[i].time).day] = i;
  let busy = { BUY: -1, SELL: -1 };
  for (let i = 210; i < c.length; i++) {
    const t = E.ist(c[i].time), closeMin = t.min + barMin;
    if (opts.rounds ? !SC.ROUNDS.includes(closeMin) : closeMin < 9 * 60 + 30 || closeMin > 14 * 60 + 45) continue;
    const chk = T.checksAt(c, ind, i, cfg, noVol);
    const cx = Object.assign(ST.context(c, ind, i, ctx), { noVol });
    for (const side of ['BUY', 'SELL']) {
      if (i <= busy[side]) continue;
      const s = side === 'BUY' ? 1 : -1;
      if (!ST.trendOk(c, ind, i, s, cx)) continue;
      const rules = chk[side].filter((x) => x[0]).length;
      const ids = opts.strategies ? ST.fired(c, ind, i, s, cx, rules) : null;
      if (!opts.strategies && rules < 4) continue;
      if (opts.strategies && !ids.length) continue;
      const lv = T.levelsAt(c, ind, i, side);
      const entry = c[i].close, dist = Math.abs(entry - lv.sl);
      if (!(dist > 0)) continue;
      const lastIdx = dayLast[t.day];
      const r = X.run(c, ind, i + 1, lastIdx, s, entry, entry - s * dist, entry + s * dist, entry + s * 2 * dist, EXIT);
      if (!opts.rounds) busy[side] = i + r.bars; // one open trade per side per stock (candle-by-candle mode)
      const gross = (r.pctMove / 100) * POSITION;
      const di = cx.di || {};
      out.push({ sym, day: t.day, time: c[i].time, min: closeMin, side, rules, ids, gross, net: gross - COST,
        rvol: cx.rvol, gap: di.gapPct == null ? null : di.gapPct, atrPct: (ind.atr[i] / entry) * 100,
        vwapDist: Math.abs(entry - ind.vw[i]) / entry * 100,
        moveWith: di.prevC ? s * ((entry - di.prevC) / di.prevC) * 100 : 0, riskPct: (dist / entry) * 100 });
    }
  }
  return out;
}

async function main(opts = {}) {
  const list = opts.list || SC.DEFAULT_SCAN_LIST;
  const log = opts.log || ((m) => process.stdout.write(m));
  const t5 = [], t15 = [], t60 = [], s60 = []; const failed = []; let ok = 0;
  // NIFTY direction (Supertrend on NIFTY 5-minute candles)
  let niftyDir = {};
  try {
    const nd = await E.fetchCandles('NSE:NIFTY', '5m', '60d');
    const nind = E.indicators(nd.candles, cfg);
    nd.candles.forEach((b, i) => { if (nind.dir[i] != null) niftyDir[b.time] = nind.dir[i]; });
  } catch (e) { niftyDir = {}; }
  log(`\n  Downloading data for ${list.length} stocks (5-min, 15-min, 1-hour, daily)…\n`);
  for (let k = 0; k < list.length; k++) {
    const sym = list[k];
    try {
      const now = Math.floor(Date.now() / 1000);
      let daily = null; try { daily = await E.fetchCandles(sym, '1d', '2y'); } catch (e) { daily = null; }
      const d5 = await E.fetchCandles(sym, '5m', '60d');
      const c5 = d5.candles.filter((b) => b.time + 300 <= now);
      for (const t of modelATrades(sym, c5, daily, 5, { rounds: true })) { const nd = niftyDir[t.time]; t.nifty = nd == null ? null : nd === (t.side === 'BUY' ? -1 : 1); t5.push(t); }
      try { const d = await E.fetchCandles(sym, '15m', '60d'); t15.push(...modelATrades(sym, d.candles.filter((b) => b.time + 900 <= now), daily, 15)); } catch (e) { /* skip */ }
      try {
        const d = await E.fetchCandles(sym, '60m', '730d'); const c60 = d.candles.filter((b) => b.time + 3600 <= now);
        t60.push(...modelATrades(sym, c60, daily, 60));
        s60.push(...modelATrades(sym, c60, daily, 60, { strategies: true }));
      } catch (e) { /* skip */ }
      ok++;
    } catch (e) { failed.push(sym); }
    if ((k + 1) % 10 === 0 || k === list.length - 1) log(`  ${k + 1}/${list.length} stocks · 5-min ${t5.length.toLocaleString('en-IN')} · 15-min ${t15.length.toLocaleString('en-IN')} · 1-hour ${t60.length.toLocaleString('en-IN')} trades\n`);
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!t5.length) throw new Error('No data. Check your internet connection and try again.');
  const splitOf = (list) => { const d = [...new Set(list.map((t) => t.day))].sort(); return { split: d[Math.floor(d.length * 2 / 3)], from: d[0], to: d[d.length - 1], days: d.length }; };
  const p5 = splitOf(t5);
  const part1 = analyseGroups(t5, p5.split);
  const tf = (list) => { if (!list.length) return null; const p = splitOf(list); return Object.assign(p, { learn: summary(list.filter((t) => t.day < p.split)), check: summary(list.filter((t) => t.day >= p.split)), all: summary(list) }); };
  const strat = {};
  if (s60.length) {
    const p = splitOf(s60);
    for (const st of ST.STRATEGIES) {
      const l = s60.filter((t) => t.ids.includes(st.id));
      strat[st.id] = { name: st.name, learn: summary(l.filter((t) => t.day < p.split)), check: summary(l.filter((t) => t.day >= p.split)) };
    }
    strat._period = p;
  }
  return { at: new Date().toISOString(), stocks: ok, failed, cost: Math.round(COST * 100) / 100, p5, part1,
    timeframes: { '5-minute (now)': tf(t5), '15-minute': tf(t15), '1-hour': tf(t60) }, strat };
}

function printReport(R, log = console.log) {
  const inr = (v) => (v == null ? '–' : (v < 0 ? '-' : v > 0 ? '+' : '') + '₹' + Math.abs(v).toLocaleString('en-IN'));
  const cell = (s) => (s && s.n ? `${String(s.n).padStart(6)} ${inr(s.net).padStart(7)}` : '     –       –');
  log('\n  ========================= SWINGPULSE: HOW TO IMPROVE MODEL A =========================');
  log(`  Real NSE data · ${R.stocks} stocks · 5-min period ${R.p5.from} to ${R.p5.to} (${R.p5.days} days)`);
  log(`  ₹ = average result per ₹1,00,000 trade AFTER charges (₹${R.cost} per trade). PF > 1 = profit.`);
  log(`  LEARN = days before ${R.p5.split}. CHECK = from ${R.p5.split} (not used for choosing). ✓ = profit in BOTH.`);

  log('\n  PART 1 — WHICH MODEL A TRADES MAKE MONEY?            LEARN: trades  avg ₹   CHECK: trades  avg ₹');
  for (const [dim, groups] of Object.entries(R.part1.groups)) {
    log(`  ${dim}`);
    for (const g of groups) log(`    ${(g.keep ? '✓ ' : '  ') + g.group}`.padEnd(54) + cell(g.learn) + '        ' + cell(g.check));
  }

  log('\n  PART 2 — ONLY HIGH-PROBABILITY TRADES (score learned on LEARN days)');
  log('  ' + ''.padEnd(26) + 'LEARN: trades/day  avg ₹    PF'.padStart(32) + '   CHECK: trades/day  avg ₹    PF  ₹ per day');
  for (const [k, v] of Object.entries(R.part1.selections)) {
    const f = (s) => (s && s.n ? `${String(s.tradesPerDay).padStart(10)} ${inr(s.net).padStart(7)} ${String(s.pf ?? '–').padStart(5)}` : '         –       –     –');
    log('  ' + k.padEnd(26) + f(v.learn).padStart(32) + '      ' + f(v.check) + (v.check.n ? inr(v.check.perDay).padStart(11) : ''));
  }

  log('\n  PART 3 — SAME MODEL A RULES ON BIGGER CANDLES');
  log('  ' + ''.padEnd(18) + 'Period'.padEnd(26) + 'Trades'.padStart(8) + 'Win %'.padStart(7) + 'Before chg'.padStart(12) + 'After chg'.padStart(11) + 'PF'.padStart(6) + '   CHECK part: avg ₹  PF');
  for (const [k, v] of Object.entries(R.timeframes)) {
    if (!v) { log('  ' + k.padEnd(18) + 'no data'); continue; }
    log('  ' + k.padEnd(18) + `${v.from} to ${v.to}`.padEnd(26) + String(v.all.n).padStart(8) + String(v.all.win).padStart(7) + inr(v.all.gross).padStart(12) + inr(v.all.net).padStart(11) + String(v.all.pf ?? '–').padStart(6) + `   ${inr(v.check.net).padStart(12)} ${String(v.check.pf ?? '–').padStart(4)}`);
  }

  if (R.strat && R.strat._period) {
    const p = R.strat._period;
    log(`\n  PART 4 — EACH STRATEGY ON 1-HOUR CANDLES (${p.from} to ${p.to}, ${p.days} days)`);
    log('  ' + 'Strategy'.padEnd(34) + 'LEARN: trades  avg ₹    PF'.padStart(28) + '    CHECK: trades  avg ₹    PF');
    for (const [id, v] of Object.entries(R.strat)) {
      if (id === '_period') continue;
      const f = (s) => (s && s.n ? `${String(s.n).padStart(13)} ${inr(s.net).padStart(7)} ${String(s.pf ?? '–').padStart(5)}` : '            –       –     –');
      const keep = v.learn.n >= 50 && v.check.n >= 25 && v.learn.net > 0 && v.check.net > 0;
      log('  ' + ((keep ? '✓ ' : '  ') + v.name).padEnd(34) + f(v.learn) + '    ' + f(v.check));
    }
  }
  if (R.failed.length) log(`\n  Could not load: ${R.failed.join(', ')}`);
  log('  ========================================================================================\n');
}

module.exports = { main, printReport };

if (require.main === module) {
  main().then((R) => {
    printReport(R);
    fs.writeFileSync(path.join(__dirname, 'improve_a_result.json'), JSON.stringify(R, null, 2));
    console.log('  Saved: improve_a_result.json  (send screenshots of this window, or this file)\n');
  }).catch((e) => { console.error('\n  Study failed:', e.message, '\n'); process.exit(1); });
}
