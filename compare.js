// SwingPulse model comparison
// Model A (current): Core 5 rules (Supertrend, 9/21 EMA, VWAP, RSI, Volume) — 4 or more of 5 rules.
// Model B (new):     Model A  +  10/20 SMA cross, RSI 70 momentum, Gap & go, Pivot breakout, MACD momentum
//                    (a trade is taken when Model A OR any of these five fires).
// Both: same 70 stocks, same last ~60 days of real 5-minute NSE data, same round times (9:30 … 14:30),
//       same trend rules, same stop-loss / targets / Chandelier trailing / 15:15 square-off, same charges.
// Learning model: trained on the first 2/3 of the days, judged only on the last 1/3 it never saw.
//
// Run:  node compare.js        (takes about 3–6 minutes; needs internet)
const fs = require('fs');
const path = require('path');
const E = require('./engine');
const SC = require('./scanner');
const ST = require('./strategies');
const M = require('./model');
const T = SC._t;

const NEW_IDS = ['smaCross', 'rsi70', 'gap', 'pivot', 'macd'];
const COST = SC.COST_PCT;
const cfg = Object.assign({}, E.DEFAULT_CFG);
const r2 = (x) => Math.round(x * 100) / 100;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

function stats(trades) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const wins = trades.filter((t) => t.win).length;
  const sumR = trades.reduce((a, t) => a + t.r, 0);
  const pos = trades.filter((t) => t.r > 0).reduce((a, t) => a + t.r, 0), neg = -trades.filter((t) => t.r < 0).reduce((a, t) => a + t.r, 0);
  const sorted = trades.slice().sort((a, b) => a.time - b.time);
  let eq = 0, peak = 0, dd = 0;
  for (const t of sorted) { eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const days = new Set(trades.map((t) => t.day)).size;
  const t2 = trades.filter((t) => t.reason === 'Target 2 hit').length, sl = trades.filter((t) => t.reason === 'Stop-loss hit').length;
  return { n, wins, winRate: pct(wins, n), avgR: r2(sumR / n), totalR: r2(sumR), pf: neg ? r2(pos / neg) : null, maxDD: r2(dd),
    perDay: r2(n / Math.max(days, 1)), t2Rate: pct(t2, n), slRate: pct(sl, n), avgPctProfit: r2(trades.reduce((a, t) => a + t.pctNet, 0) / n) };
}

async function main(opts = {}) {
  const list = opts.list || SC.DEFAULT_SCAN_LIST;
  const log = opts.log || ((m) => process.stdout.write(m));
  const all = []; // every candidate trade with flags
  let ok = 0; const failed = [];
  log(`\n  Downloading 60 days of 5-minute data for ${list.length} stocks…\n`);
  for (let k = 0; k < list.length; k++) {
    const sym = list[k];
    try {
      const data = await E.fetchCandles(sym, '5m', '60d');
      let daily = null; try { daily = await E.fetchCandles(sym, '1d', '1y'); } catch (e) { daily = null; }
      const now = Math.floor(Date.now() / 1000);
      const c = data.candles.filter((b) => b.time + 300 <= now);
      if (c.length < 200) throw new Error('not enough candles');
      const ind = E.indicators(c, cfg);
      const noVol = E.isIndex(sym) || c.slice(-60).every((b) => !b.volume);
      const ctx = { days: ST.dayInfo(c), sma50: ST.dailySma50Map(daily), noVol };
      const days = [...new Set(c.map((b) => E.ist(b.time).day))];
      for (const day of days.slice(1)) {           // skip the first day (no previous-day pivots)
        const lastIdx = T.idxAt(c, day, T.epochFor(day, 15 * 60 + 30));
        for (const m of SC.ROUNDS) {
          const i = T.idxAt(c, day, T.epochFor(day, m));
          if (i < 210) continue;                    // let 200 EMA warm up
          const chk = T.checksAt(c, ind, i, cfg, noVol);
          const cx = Object.assign(ST.context(c, ind, i, ctx), { noVol });
          for (const side of ['BUY', 'SELL']) {
            const s = side === 'BUY' ? 1 : -1;
            if (!ST.trendOk(c, ind, i, s, cx)) continue;
            const rules = chk[side].filter((x) => x[0]).length;
            const ids = ST.fired(c, ind, i, s, cx, rules);
            const inA = ids.includes('core');
            const newFired = ids.filter((id) => NEW_IDS.includes(id));
            if (!inA && !newFired.length) continue;
            const lv = T.levelsAt(c, ind, i, side);
            if (!(lv.riskPct > 0)) continue;
            const out = T.simulate(c, ind, i + 1, lastIdx, side, lv, cfg);
            if (out.status === 'OPEN' || out.status === 'T1') continue;
            const risk = Math.abs(lv.entry - lv.sl);
            const costR = COST / lv.riskPct;
            const xFull = M.features(c, ind, i, s, rules, T.relVolAt(c, i), T.prevCloseOf(c, i), lv.riskPct, m, ST.extraFeatures(c, ind, i, s, cx, ids, risk));
            const xBase = M.features(c, ind, i, s, rules, T.relVolAt(c, i), T.prevCloseOf(c, i), lv.riskPct, m, null);
            all.push({ sym, day, time: c[i].time, side, inA, newFired, r: out.pts / risk - costR, win: out.pts / risk - costR > 0,
              pctNet: (out.pts / lv.entry) * 100 - COST, reason: out.reason, xFull, xBase });
          }
        }
      }
      ok++;
    } catch (e) { failed.push(sym); }
    if ((k + 1) % 10 === 0 || k === list.length - 1) log(`  ${k + 1}/${list.length} stocks done · ${all.length.toLocaleString('en-IN')} trades so far\n`);
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!all.length) throw new Error('No data. Check your internet connection and try again.');

  const A = all.filter((t) => t.inA), B = all;
  // walk-forward split: learn on the first 2/3 of days, judge on the last 1/3
  const days = [...new Set(all.map((t) => t.day))].sort();
  const split = days[Math.floor(days.length * 2 / 3)];
  const learnFilter = (set, key) => {
    const train = set.filter((t) => t.day < split), test = set.filter((t) => t.day >= split);
    const model = M.train(train.map((t) => ({ day: t.day, x: t[key], y: t.win ? 1 : 0, r: t.r })));
    const cut = Math.max(0.6, model.cutoff || 0.6);
    const picked = test.filter((t) => M.predict(model, t[key]) >= cut);
    return { all: stats(test), picked: stats(picked), cutoff: cut };
  };
  const result = {
    at: new Date().toISOString(), stocks: ok, failed, days: days.length, from: days[0], to: days[days.length - 1], split,
    A: { raw: stats(A), learned: learnFilter(A, 'xBase') },
    B: { raw: stats(B), learned: learnFilter(B, 'xFull') },
    onlyNew: stats(all.filter((t) => !t.inA)),
    perStrategy: Object.fromEntries(NEW_IDS.map((id) => [id, stats(all.filter((t) => t.newFired.includes(id)))])),
    names: Object.fromEntries(NEW_IDS.map((id) => [id, ST.BY_ID[id].name]))
  };
  return result;
}

function printReport(R, log = console.log) {
  const row = (label, a, b, fmt = (v) => v) => log('  ' + label.padEnd(30) + String(a == null ? '–' : fmt(a)).padStart(14) + String(b == null ? '–' : fmt(b)).padStart(14));
  const sgn = (v) => (v > 0 ? '+' : '') + v;
  const block = (title, a, b) => {
    log(`\n  ${title}`); log('  ' + ''.padEnd(30) + 'Model A'.padStart(14) + 'Model B'.padStart(14)); log('  ' + '-'.repeat(58));
    row('Trades', a.n, b.n, (v) => v.toLocaleString('en-IN'));
    row('Trades per day (all stocks)', a.perDay, b.perDay);
    row('Win rate %', a.winRate, b.winRate);
    row('Average result (R)', a.avgR, b.avgR, sgn);
    row('Average result % of price', a.avgPctProfit, b.avgPctProfit, sgn);
    row('Total result (R)', a.totalR, b.totalR, sgn);
    row('Profit factor', a.pf, b.pf);
    row('Worst losing streak (R)', a.maxDD, b.maxDD, (v) => '-' + v);
    row('Reached Target 2 %', a.t2Rate, b.t2Rate);
    row('Hit stop-loss %', a.slRate, b.slRate);
  };
  log('\n  ================= SWINGPULSE MODEL COMPARISON =================');
  log(`  Real NSE 5-minute data · ${R.stocks} stocks · ${R.days} trading days (${R.from} to ${R.to})`);
  log('  Model A = current (Core 5 rules)');
  log('  Model B = current + 10/20 SMA cross, RSI 70, Gap & go, Pivot breakout, MACD momentum');
  log('  Results after estimated charges (0.06%). R = result in multiples of the risk (stop-loss distance).');
  block('1) ALL SETUPS, NO LEARNING MODEL (all ' + R.days + ' days)', R.A.raw, R.B.raw);
  block(`2) WITH LEARNING MODEL (learned before ${R.split}, judged after — unseen days)`, R.A.learned.picked, R.B.learned.picked);
  log(`\n  3) EACH NEW STRATEGY ON ITS OWN (all days)`);
  log('  ' + 'Strategy'.padEnd(32) + 'Trades'.padStart(8) + 'Win %'.padStart(8) + 'Avg R'.padStart(8) + 'PF'.padStart(7));
  log('  ' + '-'.repeat(63));
  for (const [id, s] of Object.entries(R.perStrategy)) log('  ' + R.names[id].padEnd(32) + String(s.n || 0).padStart(8) + String(s.n ? s.winRate : '–').padStart(8) + String(s.n ? sgn(s.avgR) : '–').padStart(8) + String(s.pf ?? '–').padStart(7));
  const o = R.onlyNew;
  log(`\n  Trades only Model B takes (Model A would skip them): ${o.n || 0}` + (o.n ? ` · win ${o.winRate}% · avg ${sgn(o.avgR)}R` : ''));
  if (R.failed.length) log(`  Could not load: ${R.failed.join(', ')}`);
  log('  ===============================================================\n');
}

module.exports = { main, printReport };

if (require.main === module) {
  main().then((R) => {
    printReport(R);
    const out = path.join(__dirname, 'comparison_result.json');
    fs.writeFileSync(out, JSON.stringify(R, null, 2));
    console.log('  Saved: comparison_result.json  (send a screenshot of this window, or this file)\n');
  }).catch((e) => { console.error('\n  Comparison failed:', e.message, '\n'); process.exit(1); });
}
