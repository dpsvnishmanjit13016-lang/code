// SwingPulse comparison of EXITS (same entries for every model)
// Entries: Core 5 rules (4+ of 5) with your trend rules, checked at 9:30, 10:00 … 14:30 — exactly Model A's entries.
//
//  A  (current)  stop on Supertrend · sell ½ at Target 1, stop → entry, Chandelier trail, sell rest at Target 2
//  B             stop on Supertrend · sell ALL at Target 1
//  C             stop HALF as far   · sell ALL at Target 1 (same Target 1 price as A)
//  B2 (extra)    stop on Supertrend · sell ½ at Target 1, rest trails (stop → entry, Chandelier), no Target 2
//  C2 (extra)    stop HALF as far   · sell ½ at Target 1, rest trails, no Target 2
// Every model also exits on a Supertrend flip against the trade and at 15:15.
// If the stop and a target are touched in the same 5-minute candle, the stop is assumed first (the cautious choice).
// Results in rupees for a ₹1,00,000 trade, after Zerodha intraday charges.
//
// Run:  node compare_exits.js     (about 3–6 minutes, needs internet)
const fs = require('fs');
const path = require('path');
const E = require('./engine');
const SC = require('./scanner');
const ST = require('./strategies');
const T = SC._t;

const cfg = Object.assign({}, E.DEFAULT_CFG);
const POSITION = 100000;
const r0 = (x) => Math.round(x);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

// Zerodha intraday equity charges for one buy + one sell of `value` rupees
function charges(value) {
  const brokerage = 2 * Math.min(20, value * 0.0003);
  const stt = value * 0.00025;
  const txn = 2 * value * 0.0000307;
  const sebi = 2 * value * 10 / 1e7;
  const gst = 0.18 * (brokerage + txn + sebi);
  const stamp = value * 0.00003;
  return brokerage + stt + txn + sebi + gst + stamp;
}
const COST = charges(POSITION);

const MODELS = {
  A: { small: false, half: true, t2: true },
  B: { small: false, half: false, t2: false },
  C: { small: true, half: false, t2: false },
  B2: { small: false, half: true, t2: false },
  C2: { small: true, half: true, t2: false }
};

// Follow one trade with the given exit model. Returns { pctMove, reason, bars, t1 }
function run(c, ind, from, lastIdx, s, entry, stop0, t1, t2, mdl) {
  const day = E.ist(c[from - 1].time).day;
  let stop = stop0, halfDone = false, bookedPct = 0;
  const done = (px, reason, i) => {
    const restPct = (s * (px - entry) / entry) * 100;
    return { pctMove: halfDone ? (bookedPct + restPct) / 2 : restPct, reason, bars: i - from + 1, t1: halfDone || reason === 'Target 1' };
  };
  for (let i = from; i <= lastIdx; i++) {
    const b = c[i], t = E.ist(b.time);
    if (t.day !== day) return done(c[i - 1].close, 'Square-off 15:15', i - 1);
    const hitStop = s === 1 ? b.low <= stop : b.high >= stop;
    const hitT1 = s === 1 ? b.high >= t1 : b.low <= t1;
    const hitT2 = mdl.t2 && (s === 1 ? b.high >= t2 : b.low <= t2);
    if (hitStop) return done(stop, !halfDone ? 'Stop-loss' : s * (stop - entry) > 0 ? 'Trailing stop' : 'Stop at entry', i);
    if (!mdl.half && hitT1) return done(t1, 'Target 1', i);
    if (halfDone && hitT2) return done(t2, 'Target 2', i);
    if (s === 1 ? ind.dir[i] > 0 : ind.dir[i] < 0) return done(b.close, 'Supertrend flip', i);
    if (t.min + 5 >= cfg.squareOffMin) return done(b.close, 'Square-off 15:15', i);
    if (mdl.half && !halfDone && hitT1) {
      halfDone = true; bookedPct = (s * (t1 - entry) / entry) * 100;
      stop = entry;
      if (mdl.t2 && hitT2) return done(t2, 'Target 2', i);
    }
    if (halfDone) { const ch = s === 1 ? ind.chLong[i] : ind.chShort[i]; if (ch != null && s * (ch - stop) > 0) stop = ch; }
  }
  return done(c[lastIdx].close, 'Square-off 15:15', lastIdx);
}

function stats(list) {
  const n = list.length; if (!n) return { n: 0 };
  const pnl = list.map((t) => t.rupees);
  const wins = pnl.filter((v) => v > 0), losses = pnl.filter((v) => v <= 0);
  const sum = pnl.reduce((a, b) => a + b, 0);
  const pos = wins.reduce((a, b) => a + b, 0), neg = -losses.reduce((a, b) => a + b, 0);
  const sorted = list.slice().sort((a, b) => a.time - b.time);
  let eq = 0, peak = 0, dd = 0; for (const t of sorted) { eq += t.rupees; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const reasons = {}; for (const t of list) reasons[t.reason] = (reasons[t.reason] || 0) + 1;
  const days = new Set(list.map((t) => t.day)).size;
  return { n, winRate: pct(wins.length, n), grossWinRate: pct(list.filter((t) => t.pctMove > 0).length, n), t1Rate: pct(list.filter((t) => t.t1).length, n),
    stopRate: pct(list.filter((t) => t.reason === 'Stop-loss').length, n),
    avgWin: wins.length ? r0(pos / wins.length) : null, avgLoss: losses.length ? r0(-neg / losses.length) : null,
    avg: r0(sum / n), total: r0(sum), perDay: r0(sum / Math.max(days, 1)), pf: neg ? Math.round((pos / neg) * 100) / 100 : null, maxDD: r0(dd),
    avgMin: Math.round(list.reduce((a, t) => a + t.bars * 5, 0) / n), reasons };
}

async function main(opts = {}) {
  const list = opts.list || SC.DEFAULT_SCAN_LIST;
  const log = opts.log || ((m) => process.stdout.write(m));
  const res = Object.fromEntries(Object.keys(MODELS).map((k) => [k, []]));
  let ok = 0, entries = 0; const failed = []; const allDays = new Set();
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
            if (chk[side].filter((x) => x[0]).length < 4) continue;
            const lv = T.levelsAt(c, ind, i, side);
            const entry = c[i].close, dist = Math.abs(entry - lv.sl);
            if (!(dist > 0)) continue;
            entries++; allDays.add(day);
            const t1 = entry + s * dist, t2 = entry + s * 2 * dist;
            for (const [key, mdl] of Object.entries(MODELS)) {
              const stop = entry - s * (mdl.small ? dist / 2 : dist);
              const out = run(c, ind, i + 1, lastIdx, s, entry, stop, t1, t2, mdl);
              const rupees = (out.pctMove / 100) * POSITION - COST;
              res[key].push({ day, time: c[i].time, rupees, pctMove: out.pctMove, reason: out.reason, bars: out.bars, t1: out.t1 });
            }
          }
        }
      }
      ok++;
    } catch (e) { failed.push(sym); }
    if ((k + 1) % 10 === 0 || k === list.length - 1) log(`  ${k + 1}/${list.length} stocks done · ${entries.toLocaleString('en-IN')} trades so far\n`);
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!entries) throw new Error('No data. Check your internet connection and try again.');
  const days = [...allDays].sort();
  return { at: new Date().toISOString(), stocks: ok, failed, days: days.length, from: days[0], to: days[days.length - 1], cost: Math.round(COST * 100) / 100,
    models: Object.fromEntries(Object.entries(res).map(([k, v]) => [k, stats(v)])) };
}

function printReport(R, log = console.log) {
  const keys = ['A', 'B', 'C', 'B2', 'C2'];
  const inr = (v) => (v < 0 ? '-' : v > 0 ? '+' : '') + '₹' + Math.abs(v).toLocaleString('en-IN');
  const row = (label, key, fmt = (v) => v) => log('  ' + label.padEnd(30) + keys.map((k) => { const v = R.models[k][key]; return String(v == null ? '–' : fmt(v)).padStart(12); }).join(''));
  log('\n  ===================== SWINGPULSE: COMPARING EXITS (same entries) =====================');
  log(`  Real NSE 5-minute data · ${R.stocks} stocks · ${R.days} trading days (${R.from} to ${R.to})`);
  log(`  Rupees for a ₹1,00,000 trade, after Zerodha charges (₹${R.cost} per trade)`);
  log('  A  = current (½ at T1, rest at T2 or trailing stop)      B  = sell all at T1');
  log('  C  = sell all at T1 with stop half as far                B2 = ½ at T1, rest trails, no T2');
  log('  C2 = ½ at T1, rest trails, no T2, stop half as far\n');
  log('  ' + ''.padEnd(30) + keys.map((k) => k.padStart(12)).join(''));
  log('  ' + '-'.repeat(30 + 12 * keys.length));
  row('Trades', 'n', (v) => v.toLocaleString('en-IN'));
  row('Win rate % before charges', 'grossWinRate');
  row('Win rate % after charges', 'winRate');
  row('Reached Target 1 %', 't1Rate');
  row('Hit stop-loss %', 'stopRate');
  row('Average win', 'avgWin', inr);
  row('Average loss', 'avgLoss', inr);
  row('Average per trade', 'avg', inr);
  row('Profit factor (>1 = profit)', 'pf');
  row('Total (all trades)', 'total', inr);
  row('Per trading day (all stocks)', 'perDay', inr);
  row('Worst losing streak', 'maxDD', (v) => '-₹' + v.toLocaleString('en-IN'));
  row('Average time in trade (min)', 'avgMin');
  log('\n  How trades ended (% of trades)');
  const reasons = [...new Set(keys.flatMap((k) => Object.keys(R.models[k].reasons || {})))];
  for (const r of reasons) log('  ' + r.padEnd(30) + keys.map((k) => String(pct((R.models[k].reasons || {})[r] || 0, R.models[k].n)).padStart(12)).join(''));
  if (R.failed.length) log(`\n  Could not load: ${R.failed.join(', ')}`);
  log('  ======================================================================================\n');
}

module.exports = { main, printReport, charges, run, MODELS };

if (require.main === module) {
  main().then((R) => {
    printReport(R);
    fs.writeFileSync(path.join(__dirname, 'comparison_exits_result.json'), JSON.stringify(R, null, 2));
    console.log('  Saved: comparison_exits_result.json  (send a screenshot of this window)\n');
  }).catch((e) => { console.error('\n  Comparison failed:', e.message, '\n'); process.exit(1); });
}
