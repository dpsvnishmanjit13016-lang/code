// SwingPulse comparison: do the "rules to avoid false trades" really help? (real NSE data)
//
// A  Model A          : Core 5 rules (Supertrend, 9/21 EMA, VWAP, RSI 14, Volume), 4+ of 5, your trend rules,
//                       checked at 9:30, 10:00 … 14:30. Stop on Supertrend, T1 = 1R (book half), T2 = 2R,
//                       Chandelier trailing after T1, square-off 15:15.
// B  A + ADX          : same, but no trade while ADX (14) is below 20 (sideways market).
// C  A + ADX + confirm: same as B, and the last closed candle must confirm (close beyond the previous close, right colour).
// D  New rules only   : Supertrend confirmed reversal — Supertrend flips red→green (green→red for sells), candle closes
//                       beyond Supertrend, a later candle confirms, price above VWAP, 50 EMA and 200 EMA, ADX above 20,
//                       RSI 14 above 50 and EMA 9 above 21 (mirror for sells). Checked on every 5-minute candle
//                       9:30–14:45, one trade per stock at a time, same stop/targets/exits as the app.
// E  C + D together
// Success = profit after charges (default ₹65 on ₹1,00,000; change with: node compare_adx.js 100000 65).
//
// Run:  node compare_adx.js      (about 3–6 minutes, needs internet)
const fs = require('fs');
const path = require('path');
const E = require('./engine');
const SC = require('./scanner');
const ST = require('./strategies');
const M = require('./model');
const T = SC._t;

ST.setFilters({ adxMin: 0, confirm: false });   // filters are applied by hand below, per model
const AMOUNT = Number(process.argv[2]) || 100000, CHARGES = process.argv[3] != null ? Number(process.argv[3]) : 65;
const COST_PCT = (CHARGES / AMOUNT) * 100;
const cfg = Object.assign({}, E.DEFAULT_CFG, { costPct: COST_PCT });
const NEW = ST.BY_ID.stConfirm;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const r2 = (x) => Math.round(x * 100) / 100;

function stats(list) {
  const n = list.length; if (!n) return { n: 0 };
  const wins = list.filter((t) => t.pct > COST_PCT).length, t1 = list.filter((t) => t.t1).length;
  const rupees = list.map((t) => (t.pct / 100) * AMOUNT - CHARGES);
  const pos = rupees.filter((v) => v > 0).reduce((a, b) => a + b, 0), neg = -rupees.filter((v) => v <= 0).reduce((a, b) => a + b, 0);
  const days = new Set(list.map((t) => t.day)).size;
  let eq = 0, peak = 0, dd = 0;
  for (const v of list.slice().sort((a, b) => a.time - b.time).map((t) => (t.pct / 100) * AMOUNT - CHARGES)) { eq += v; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return { n, perDay: r2(n / Math.max(days, 1)), win: pct(wins, n), low: Math.round(M.wilsonLow(wins, n) * 1000) / 10, t1: pct(t1, n),
    avg: Math.round(rupees.reduce((a, b) => a + b, 0) / n), total: Math.round(rupees.reduce((a, b) => a + b, 0)), pf: neg ? r2(pos / neg) : null, dd: Math.round(dd) };
}

function trade(c, ind, i, lastIdx, side) {
  const lv = T.levelsAt(c, ind, i, side);
  if (!(lv.riskPct > 0)) return null;
  const out = T.simulate(c, ind, i + 1, lastIdx, side, lv, cfg);
  if (out.status === 'OPEN' || out.status === 'T1') return null;
  const exitIdx = c.findIndex((b) => b.time === out.exitTime);
  const s = side === 'BUY' ? 1 : -1;
  let t1 = false; for (let k = i + 1; k <= (exitIdx > i ? exitIdx : lastIdx); k++) if (s === 1 ? c[k].high >= lv.t1 : c[k].low <= lv.t1) { t1 = true; break; }
  return { pct: (out.pts / lv.entry) * 100, t1, exitIdx: exitIdx > i ? exitIdx : lastIdx };
}

async function main(opts = {}) {
  const list = opts.list || SC.DEFAULT_SCAN_LIST;
  const log = opts.log || ((m) => process.stdout.write(m));
  const A = [], B = [], C = [], D = [];
  let ok = 0; const failed = [];
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
        // ---- A, B, C at round times ----
        for (const m of SC.ROUNDS) {
          const i = T.idxAt(c, day, T.epochFor(day, m));
          if (i < 210) continue;
          const chk = T.checksAt(c, ind, i, cfg, noVol);
          const cx = Object.assign(ST.context(c, ind, i, ctx), { noVol });
          for (const side of ['BUY', 'SELL']) {
            const s = side === 'BUY' ? 1 : -1;
            if (!ST.trendOk(c, ind, i, s, cx)) continue;
            if (chk[side].filter((x) => x[0]).length < 4) continue;
            const t = trade(c, ind, i, lastIdx, side); if (!t) continue;
            const rec = { day, time: c[i].time, pct: t.pct, t1: t.t1 };
            A.push(rec);
            const adxOk = ind.adx[i] != null && ind.adx[i] >= 20;
            if (!adxOk) continue;
            B.push(rec);
            if (s * (c[i].close - c[i - 1].close) > 0 && s * (c[i].close - c[i].open) > 0) C.push(rec);
          }
        }
        // ---- D: new rules on every candle, one trade at a time ----
        let busyUntil = -1;
        for (let i = 210; i <= lastIdx; i++) {
          if (i <= busyUntil) continue;
          const tm = E.ist(c[i].time); if (tm.day !== day) continue;
          const closeMin = tm.min + 5;
          if (closeMin < cfg.startMin || closeMin > cfg.lastEntryMin) continue;
          const cx = Object.assign(ST.context(c, ind, i, ctx), { noVol });
          for (const side of ['BUY', 'SELL']) {
            const s = side === 'BUY' ? 1 : -1;
            let hit = false; try { hit = NEW.test(c, ind, i, s, cx) && ST.trendOk(c, ind, i, s, cx); } catch (e) { hit = false; }
            if (!hit) continue;
            const t = trade(c, ind, i, lastIdx, side); if (!t) continue;
            D.push({ day, time: c[i].time, pct: t.pct, t1: t.t1 });
            busyUntil = t.exitIdx; break;
          }
        }
      }
      ok++;
    } catch (e) { failed.push(sym); }
    if ((k + 1) % 10 === 0 || k === list.length - 1) log(`  ${k + 1}/${list.length} stocks · A ${A.length.toLocaleString('en-IN')} · A+ADX ${B.length.toLocaleString('en-IN')} · +confirm ${C.length.toLocaleString('en-IN')} · new rules ${D.length.toLocaleString('en-IN')} trades\n`);
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!A.length && !D.length) throw new Error('No data. Check your internet connection and try again.');
  const days = [...new Set(A.concat(D).map((t) => t.day))].sort();
  return { at: new Date().toISOString(), stocks: ok, failed, days: days.length, from: days[0], to: days[days.length - 1], amount: AMOUNT, charges: CHARGES,
    A: stats(A), B: stats(B), C: stats(C), D: stats(D), E: stats(C.concat(D)) };
}

function printReport(R, log = console.log) {
  const inr = (v) => (v == null ? '–' : (v < 0 ? '-' : v > 0 ? '+' : '') + '₹' + Math.abs(v).toLocaleString('en-IN'));
  const cols = [['A Model A', R.A], ['B A+ADX', R.B], ['C B+confirm', R.C], ['D New rules', R.D], ['E C + D', R.E]];
  const row = (label, key, fmt = (v) => v) => log('  ' + label.padEnd(32) + cols.map(([, s]) => String(s.n ? (s[key] == null ? '–' : fmt(s[key])) : '–').padStart(13)).join(''));
  log('\n  ========== SWINGPULSE: RULES TO AVOID FALSE TRADES (ADX, confirmation, Supertrend reversal) ==========');
  log(`  Real NSE 5-minute data · ${R.stocks} stocks · ${R.days} trading days (${R.from} to ${R.to})`);
  log(`  Success = profit after charges (₹${R.charges} on ₹${R.amount.toLocaleString('en-IN')} per trade). Money per ₹${R.amount.toLocaleString('en-IN')} trade.\n`);
  log('  ' + ''.padEnd(32) + cols.map(([n]) => n.padStart(13)).join(''));
  log('  ' + '-'.repeat(32 + 13 * cols.length));
  row('Trades', 'n', (v) => v.toLocaleString('en-IN'));
  row('Trades per day (all stocks)', 'perDay');
  row('Reached Target 1 %', 't1');
  row('Win rate % (profit after charges)', 'win');
  row('…at least (95% sure)', 'low');
  row('Average per trade', 'avg', inr);
  row('Profit factor (>1 = profit)', 'pf');
  row('Total', 'total', inr);
  row('Worst fall from a peak', 'dd', (v) => inr(-v));
  log('\n  Read it like this: a filter helps only if the win rate AND the average per trade go up, not just the trade count down.');
  if (R.failed.length) log(`  Could not load: ${R.failed.join(', ')}`);
  log('  ======================================================================================================\n');
}

module.exports = { main, printReport };

if (require.main === module) {
  main().then((R) => {
    printReport(R);
    fs.writeFileSync(path.join(__dirname, 'comparison_adx_result.json'), JSON.stringify(R, null, 2));
    console.log('  Saved: comparison_adx_result.json  (send a screenshot of this window)\n');
  }).catch((e) => { console.error('\n  Comparison failed:', e.message, '\n'); process.exit(1); });
}
