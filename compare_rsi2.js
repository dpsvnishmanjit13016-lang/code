// SwingPulse comparison: Model A  vs  Model A + RSI-2 pullback (Connors style)
//
// Model A      : Core 5 rules (Supertrend, 9/21 EMA, VWAP, RSI 14, Volume), 4+ of 5, checked at 9:30, 10:00 … 14:30,
//                stop on Supertrend, Target 1 = 1R (book half), Target 2 = 2R, Chandelier trailing, square-off 15:15.
// RSI-2 pullback: trend = price above 200 EMA for buys (below for sells) + your trend rules (10/20 SMA vs 200, 50-day SMA).
//                BUY when RSI(2) < 5 and price below VWAP  (a sharp dip inside an uptrend)
//                SELL when RSI(2) > 95 and price above VWAP (a sharp spike inside a downtrend)
//                Exit at VWAP, or when a candle closes back across the 5 SMA — whichever comes first.
//                Safety stop 1.5 × ATR. Square-off 15:15. Checked on every 5-minute candle 9:30–14:45, one trade per stock at a time.
// Both: same 70 stocks, last ~60 days of real NSE 5-minute data, charges 0.06% per round trip.
//
// Run:  node compare_rsi2.js     (about 3–6 minutes, needs internet)
const fs = require('fs');
const path = require('path');
const E = require('./engine');
const SC = require('./scanner');
const ST = require('./strategies');
const T = SC._t;

const COST = SC.COST_PCT;
const cfg = Object.assign({}, E.DEFAULT_CFG);
const r2 = (x) => Math.round(x * 100) / 100;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

function stats(trades) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const wins = trades.filter((t) => t.r > 0).length, grossWins = trades.filter((t) => t.grossPct > 0).length;
  const sumR = trades.reduce((a, t) => a + t.r, 0);
  const pos = trades.filter((t) => t.r > 0).reduce((a, t) => a + t.r, 0), neg = -trades.filter((t) => t.r < 0).reduce((a, t) => a + t.r, 0);
  const winsL = trades.filter((t) => t.r > 0), lossL = trades.filter((t) => t.r <= 0);
  const sorted = trades.slice().sort((a, b) => a.time - b.time);
  let eq = 0, peak = 0, dd = 0;
  for (const t of sorted) { eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const days = new Set(trades.map((t) => t.day)).size;
  return {
    n, winRate: pct(wins, n), grossWinRate: pct(grossWins, n), avgR: r2(sumR / n), totalR: r2(sumR), pf: neg ? r2(pos / neg) : null, maxDD: r2(dd),
    perDay: r2(n / Math.max(days, 1)),
    avgNetPct: r2(trades.reduce((a, t) => a + t.netPct, 0) / n), avgGrossPct: r2(trades.reduce((a, t) => a + t.grossPct, 0) / n),
    avgWinR: winsL.length ? r2(winsL.reduce((a, t) => a + t.r, 0) / winsL.length) : null,
    avgLossR: lossL.length ? r2(lossL.reduce((a, t) => a + t.r, 0) / lossL.length) : null,
    avgMinutes: Math.round(trades.reduce((a, t) => a + (t.minutes || 0), 0) / n)
  };
}

// Follow one RSI-2 trade. Returns exit info.
function simulateRsi2(c, ind, sma5, from, lastIdx, s, entry, stop) {
  const day = E.ist(c[from - 1].time).day;
  for (let i = from; i <= lastIdx; i++) {
    const b = c[i], t = E.ist(b.time);
    if (t.day !== day) return { px: c[i - 1].close, reason: 'Square-off 15:15', idx: i - 1 };
    if (s === 1 ? b.low <= stop : b.high >= stop) return { px: stop, reason: 'Stop-loss hit', idx: i };
    const vw = ind.vw[i];
    if (vw != null && s * (vw - entry) > 0 && (s === 1 ? b.high >= vw : b.low <= vw)) return { px: vw, reason: 'Reached VWAP', idx: i };
    if (sma5[i] != null && s * (b.close - sma5[i]) > 0) return { px: b.close, reason: 'Closed across 5 SMA', idx: i };
    if (t.min + 5 >= cfg.squareOffMin) return { px: b.close, reason: 'Square-off 15:15', idx: i };
  }
  const k = lastIdx; return { px: c[k].close, reason: 'Square-off 15:15', idx: k };
}

async function main(opts = {}) {
  const list = opts.list || SC.DEFAULT_SCAN_LIST;
  const log = opts.log || ((m) => process.stdout.write(m));
  const A = [], R = [], reasons = {};
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
      const closes = c.map((b) => b.close);
      const ind = E.indicators(c, cfg);
      const rsi2 = E.rsi(closes, 2), sma5 = E.sma(closes, 5);
      const noVol = E.isIndex(sym) || c.slice(-60).every((b) => !b.volume);
      const ctx = { days: ST.dayInfo(c), sma50: ST.dailySma50Map(daily), noVol };
      const days = [...new Set(c.map((b) => E.ist(b.time).day))];
      for (const day of days.slice(1)) {
        const lastIdx = T.idxAt(c, day, T.epochFor(day, 15 * 60 + 30));
        // ---- Model A: at round times ----
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
            if (!(lv.riskPct > 0)) continue;
            const out = T.simulate(c, ind, i + 1, lastIdx, side, lv, cfg);
            if (out.status === 'OPEN' || out.status === 'T1') continue;
            const risk = Math.abs(lv.entry - lv.sl);
            const grossPct = (out.pts / lv.entry) * 100;
            const exitIdx = c.findIndex((b) => b.time === out.exitTime);
            A.push({ day, time: c[i].time, side, r: out.pts / risk - COST / lv.riskPct, grossPct, netPct: grossPct - COST, minutes: exitIdx > i ? (exitIdx - i) * 5 : 0 });
          }
        }
        // ---- RSI-2 pullback: every candle 9:30–14:45, one trade at a time ----
        let busyUntil = -1;
        for (let i = 0; i <= lastIdx; i++) {
          if (i < 210 || i <= busyUntil) continue;
          const t = E.ist(c[i].time); if (t.day !== day) continue;
          const closeMin = t.min + 5;
          if (closeMin < 9 * 60 + 30 || closeMin > 14 * 60 + 45) continue;
          if (rsi2[i] == null || ind.vw[i] == null || ind.ema200[i] == null || ind.atr[i] == null) continue;
          let s = 0;
          if (rsi2[i] < 5 && c[i].close < ind.vw[i] && c[i].close > ind.ema200[i]) s = 1;
          else if (rsi2[i] > 95 && c[i].close > ind.vw[i] && c[i].close < ind.ema200[i]) s = -1;
          if (!s) continue;
          const cx = Object.assign(ST.context(c, ind, i, ctx), { noVol });
          if (!ST.trendOk(c, ind, i, s, cx)) continue;
          const entry = c[i].close, stop = entry - s * 1.5 * ind.atr[i], risk = Math.abs(entry - stop);
          if (!(risk > 0)) continue;
          const ex = simulateRsi2(c, ind, sma5, i + 1, lastIdx, s, entry, stop);
          const grossPct = (s * (ex.px - entry) / entry) * 100;
          const riskPct = (risk / entry) * 100;
          R.push({ day, time: c[i].time, side: s === 1 ? 'BUY' : 'SELL', r: s * (ex.px - entry) / risk - COST / riskPct, grossPct, netPct: grossPct - COST, minutes: (ex.idx - i) * 5 });
          reasons[ex.reason] = (reasons[ex.reason] || 0) + 1;
          busyUntil = ex.idx;
        }
      }
      ok++;
    } catch (e) { failed.push(sym); }
    if ((k + 1) % 10 === 0 || k === list.length - 1) log(`  ${k + 1}/${list.length} stocks done · Model A ${A.length.toLocaleString('en-IN')} · RSI-2 ${R.length.toLocaleString('en-IN')} trades\n`);
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!A.length && !R.length) throw new Error('No data. Check your internet connection and try again.');
  const days = [...new Set(A.concat(R).map((t) => t.day))].sort();
  return {
    at: new Date().toISOString(), stocks: ok, failed, days: days.length, from: days[0], to: days[days.length - 1],
    A: stats(A), RSI2: stats(R), AplusR: stats(A.concat(R)),
    rsi2Buy: stats(R.filter((t) => t.side === 'BUY')), rsi2Sell: stats(R.filter((t) => t.side === 'SELL')), rsi2Exits: reasons
  };
}

function printReport(R, log = console.log) {
  const sgn = (v) => (v > 0 ? '+' : '') + v;
  const cols = [['Model A', R.A], ['RSI-2 only', R.RSI2], ['A + RSI-2', R.AplusR]];
  const row = (label, key, fmt = (v) => v) => log('  ' + label.padEnd(32) + cols.map(([, s]) => String(s[key] == null ? '–' : fmt(s[key])).padStart(13)).join(''));
  log('\n  ============ SWINGPULSE: MODEL A  vs  MODEL A + RSI-2 PULLBACK ============');
  log(`  Real NSE 5-minute data · ${R.stocks} stocks · ${R.days} trading days (${R.from} to ${R.to})`);
  log('  Charges 0.06% per trade included. R = result in multiples of the risk (stop-loss distance).\n');
  log('  ' + ''.padEnd(32) + cols.map(([n]) => n.padStart(13)).join(''));
  log('  ' + '-'.repeat(32 + 13 * 3));
  row('Trades', 'n', (v) => v.toLocaleString('en-IN'));
  row('Trades per day (all stocks)', 'perDay');
  row('Win rate % BEFORE charges', 'grossWinRate');
  row('Win rate % AFTER charges', 'winRate');
  row('Average result (R)', 'avgR', sgn);
  row('Average win (R)', 'avgWinR', sgn);
  row('Average loss (R)', 'avgLossR', sgn);
  row('Average move % before charges', 'avgGrossPct', sgn);
  row('Average result % after charges', 'avgNetPct', sgn);
  row('Total result (R)', 'totalR', sgn);
  row('Profit factor (>1 = profit)', 'pf');
  row('Worst losing streak (R)', 'maxDD', (v) => '-' + v);
  row('Average time in trade (min)', 'avgMinutes');
  log('\n  RSI-2 pullback by direction');
  for (const [n, s] of [['Buys (dips in uptrend)', R.rsi2Buy], ['Sells (spikes in downtrend)', R.rsi2Sell]]) {
    log('  ' + n.padEnd(32) + (s.n ? `${String(s.n).padStart(6)} trades · win ${s.winRate}% (before charges ${s.grossWinRate}%) · avg ${sgn(s.avgR)}R · PF ${s.pf ?? '–'}` : '   no trades'));
  }
  const tot = Object.values(R.rsi2Exits).reduce((a, b) => a + b, 0);
  log('\n  How RSI-2 trades ended: ' + Object.entries(R.rsi2Exits).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v, tot)}%`).join(' · '));
  if (R.failed.length) log(`  Could not load: ${R.failed.join(', ')}`);
  log('  ==========================================================================\n');
}

module.exports = { main, printReport };

if (require.main === module) {
  main().then((R) => {
    printReport(R);
    fs.writeFileSync(path.join(__dirname, 'comparison_rsi2_result.json'), JSON.stringify(R, null, 2));
    console.log('  Saved: comparison_rsi2_result.json  (send a screenshot of this window)\n');
  }).catch((e) => { console.error('\n  Comparison failed:', e.message, '\n'); process.exit(1); });
}
