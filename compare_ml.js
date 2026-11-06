// SwingPulse ML Lab — does machine learning + calibration really make picks more reliable? (real NSE data)
//
// Trades: every setup the app considers (3+ of the Core 5 rules or any strategy firing, with your trend rules),
//         checked at 9:30, 10:00 … 14:30 on the last ~60 days for all 70 stocks, with the app's exits.
// Success: PROFIT AFTER CHARGES (default ₹65 on a ₹1,00,000 trade; change with: node compare_ml.js 100000 65).
// Walk-forward test: the models only ever learn from days BEFORE the days they are judged on —
//   5-day windows, each trained on all earlier days, like using the app day after day.
// Compared:
//   A  All setups (no model)
//   B  Old model: logistic regression, win chance ≥ 60% (not calibrated)
//   C  New model: best of logistic / boosted trees / ensemble, isotonic-calibrated, its own cut-off (≥ 60%)
//   D  New model, only the top 5 trades per day
//
// Run:  node compare_ml.js        (about 5–10 minutes, needs internet)
const fs = require('fs');
const path = require('path');
const E = require('./engine');
const SC = require('./scanner');
const ST = require('./strategies');
const M = require('./model');
const T = SC._t;

const AMOUNT = Number(process.argv[2]) || 100000, CHARGES = process.argv[3] != null ? Number(process.argv[3]) : 65;
const COST_PCT = (CHARGES / AMOUNT) * 100;
const cfg = Object.assign({}, E.DEFAULT_CFG, { costPct: COST_PCT });
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

function stats(list) {
  const n = list.length; if (!n) return { n: 0 };
  const wins = list.filter((t) => t.y === 1).length;
  const rupees = list.map((t) => (t.pct / 100) * AMOUNT - CHARGES);
  const pos = rupees.filter((v) => v > 0).reduce((a, b) => a + b, 0), neg = -rupees.filter((v) => v <= 0).reduce((a, b) => a + b, 0);
  const days = new Set(list.map((t) => t.day)).size;
  return { n, perDay: Math.round((n / Math.max(days, 1)) * 10) / 10, win: pct(wins, n), low: Math.round(M.wilsonLow(wins, n) * 1000) / 10,
    avg: Math.round(rupees.reduce((a, b) => a + b, 0) / n), total: Math.round(rupees.reduce((a, b) => a + b, 0)), pf: neg ? Math.round((pos / neg) * 100) / 100 : null };
}

async function main(opts = {}) {
  const list = opts.list || SC.DEFAULT_SCAN_LIST;
  const log = opts.log || ((m) => process.stdout.write(m));
  const all = []; const failed = []; let ok = 0;
  log(`\n  Downloading 60 days of 5-minute data for ${list.length} stocks…\n`);
  for (let k = 0; k < list.length; k++) {
    const sym = list[k];
    try {
      const data = await E.fetchCandles(sym, '5m', '60d');
      let daily = null; try { daily = await E.fetchCandles(sym, '1d', '1y'); } catch (e) { daily = null; }
      const now = Math.floor(Date.now() / 1000);
      const c = data.candles.filter((b) => b.time + 300 <= now);
      if (c.length < 250) throw new Error('not enough candles');
      const ind = E.indicators(c, cfg);
      const noVol = E.isIndex(sym) || c.slice(-60).every((b) => !b.volume);
      const ctx = { days: ST.dayInfo(c), sma50: ST.dailySma50Map(daily), noVol };
      const days = [...new Set(c.map((b) => E.ist(b.time).day))];
      for (const day of days.slice(1)) {
        const lastIdx = T.idxAt(c, day, T.epochFor(day, 15 * 60 + 30));
        for (const m of SC.ROUNDS) {
          const i = T.idxAt(c, day, T.epochFor(day, m));
          if (i < 210) continue;
          const chk = T.checksAt(c, ind, i, cfg, noVol);
          const cx = Object.assign(ST.context(c, ind, i, ctx), { noVol });
          for (const side of ['BUY', 'SELL']) {
            const s = side === 'BUY' ? 1 : -1;
            if (!ST.trendOk(c, ind, i, s, cx)) continue;
            const rules = chk[side].filter((x) => x[0]).length;
            const ids = ST.fired(c, ind, i, s, cx, rules);
            if (rules < 3 && !ids.length) continue;
            const lv = T.levelsAt(c, ind, i, side);
            if (!(lv.riskPct > 0)) continue;
            const out = T.simulate(c, ind, i + 1, lastIdx, side, lv, cfg);
            if (out.status === 'OPEN' || out.status === 'T1') continue;
            const risk = Math.abs(lv.entry - lv.sl) || 1, movePct = (out.pts / lv.entry) * 100;
            const x = M.features(c, ind, i, s, rules, T.relVolAt(c, i), T.prevCloseOf(c, i), lv.riskPct, m, ST.extraFeatures(c, ind, i, s, cx, ids, risk));
            all.push({ sym, day, time: c[i].time, x, y: movePct > COST_PCT ? 1 : 0, r: out.pts / risk, pct: movePct });
          }
        }
      }
      ok++;
    } catch (e) { failed.push(sym); }
    if ((k + 1) % 10 === 0 || k === list.length - 1) log(`  ${k + 1}/${list.length} stocks · ${all.length.toLocaleString('en-IN')} trades\n`);
    await new Promise((r) => setTimeout(r, 200));
  }
  if (all.length < 500) throw new Error('Not enough data. Check your internet connection and try again.');

  // walk-forward windows over the last ~25 days
  const days = [...new Set(all.map((t) => t.day))].sort();
  const firstTest = Math.max(20, days.length - 25);
  const A = [], B = [], C = [], D = [], calib = [];
  const chosen = {};
  for (let s = firstTest; s < days.length; s += 5) {
    const testDays = new Set(days.slice(s, s + 5)), trainSet = all.filter((t) => t.day < days[s]), testSet = all.filter((t) => testDays.has(t.day));
    if (!testSet.length) continue;
    log(`  Learning on ${days[0]}…${days[s - 1]} (${trainSet.length.toLocaleString('en-IN')} trades), judging ${days[s]}…${days[Math.min(s + 4, days.length - 1)]}\n`);
    A.push(...testSet);
    const wOld = M._t.fit(trainSet);
    const sig = (z) => 1 / (1 + Math.exp(-z));
    for (const t of testSet) { let z = wOld[0]; for (let k = 0; k < t.x.length; k++) z += wOld[k + 1] * t.x[k]; if (sig(z) >= 0.6) B.push(t); }
    const model = M.train(trainSet);
    chosen[model.type] = (chosen[model.type] || 0) + 1;
    const cut = Math.max(0.6, model.cutoff || 0.6);
    const scored = testSet.map((t) => Object.assign({}, t, { p: M.predict(model, t.x) }));
    for (const t of scored) { if (t.p != null) calib.push(t); if (t.p != null && t.p >= cut) C.push(t); }
    const byDay = {}; for (const t of scored) if (t.p != null && t.p >= cut) (byDay[t.day] = byDay[t.day] || []).push(t);
    for (const l of Object.values(byDay)) D.push(...l.sort((a, b) => b.p - a.p).slice(0, 5));
  }
  const buckets = [[0, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 1.01]].map(([a, b]) => {
    const l = calib.filter((t) => t.p >= a && t.p < b);
    return { label: `${Math.round(a * 100)}–${b > 1 ? 100 : Math.round(b * 100)}%`, n: l.length, predicted: l.length ? Math.round((l.reduce((s, t) => s + t.p, 0) / l.length) * 100) : null, actual: l.length ? pct(l.filter((t) => t.y === 1).length, l.length) : null };
  });
  return { at: new Date().toISOString(), stocks: ok, failed, days: days.length, from: days[0], to: days[days.length - 1], testFrom: days[firstTest],
    amount: AMOUNT, charges: CHARGES, A: stats(A), B: stats(B), C: stats(C), D: stats(D), buckets, chosen };
}

function printReport(R, log = console.log) {
  const inr = (v) => (v == null ? '–' : (v < 0 ? '-' : v > 0 ? '+' : '') + '₹' + Math.abs(v).toLocaleString('en-IN'));
  const cols = [['A All setups', R.A], ['B Old model', R.B], ['C New ML', R.C], ['D New ML top 5', R.D]];
  const row = (label, key, fmt = (v) => v) => log('  ' + label.padEnd(30) + cols.map(([, s]) => String(s.n ? (s[key] == null ? '–' : fmt(s[key])) : '–').padStart(15)).join(''));
  log('\n  ======================= SWINGPULSE ML LAB (real NSE data) =======================');
  log(`  ${R.stocks} stocks · ${R.days} trading days (${R.from} to ${R.to}) · judged on ${R.testFrom} onwards, never on days it learned from`);
  log(`  Success = profit after charges (₹${R.charges} on ₹${R.amount.toLocaleString('en-IN')} per trade). Money per ₹${R.amount.toLocaleString('en-IN')} trade.\n`);
  log('  ' + ''.padEnd(30) + cols.map(([n]) => n.padStart(15)).join(''));
  log('  ' + '-'.repeat(30 + 15 * cols.length));
  row('Trades', 'n', (v) => v.toLocaleString('en-IN'));
  row('Trades per day (all stocks)', 'perDay');
  row('Win rate % (profit after charges)', 'win');
  row('…at least (95% sure)', 'low');
  row('Average per trade', 'avg', inr);
  row('Profit factor (>1 = profit)', 'pf');
  row('Total', 'total', inr);
  log('\n  Is the new model honest? (calibration on unseen days)');
  log('  ' + 'Its win chance'.padEnd(20) + 'Trades'.padStart(10) + 'It predicted'.padStart(15) + 'Really won'.padStart(13));
  for (const b of R.buckets) if (b.n) log('  ' + b.label.padEnd(20) + String(b.n).padStart(10) + (b.predicted + '%').padStart(15) + (b.actual + '%').padStart(13));
  log('\n  Algorithm it chose in each window: ' + Object.entries(R.chosen).map(([k, v]) => `${k} ×${v}`).join(', '));
  if (R.failed.length) log(`  Could not load: ${R.failed.join(', ')}`);
  log('  ==================================================================================\n');
}

module.exports = { main, printReport };

if (require.main === module) {
  main().then((R) => {
    printReport(R);
    fs.writeFileSync(path.join(__dirname, 'ml_lab_result.json'), JSON.stringify(R, null, 2));
    console.log('  Saved: ml_lab_result.json  (send a screenshot of this window)\n');
  }).catch((e) => { console.error('\n  ML Lab failed:', e.message, '\n'); process.exit(1); });
}
