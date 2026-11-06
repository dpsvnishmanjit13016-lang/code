// SwingPulse scanner
// - Publishes intraday picks at fixed rounds: 9:30, 10:00 ... 14:30 IST (top 5 BUY + top 5 SELL each round)
// - Tracks every pick like a trade (Target 1, Target 2, stop-loss, Supertrend flip, 15:15 square-off)
// - Past success rate per pick: the same setup on the same stock at the same round times over ~the last month
const E = require('./engine');
const M = require('./model');
const ST = require('./strategies');

// NIFTY 50 (list as of Dec 2025) + popular liquid F&O stocks. Editable in the app (Setup → Stocks to scan).
const DEFAULT_SCAN_LIST = [
  'ADANIENT', 'ADANIPORTS', 'APOLLOHOSP', 'ASIANPAINT', 'AXISBANK', 'BAJAJ-AUTO', 'BAJFINANCE', 'BAJAJFINSV', 'BEL', 'BHARTIARTL',
  'CIPLA', 'COALINDIA', 'DRREDDY', 'EICHERMOT', 'ETERNAL', 'GRASIM', 'HCLTECH', 'HDFCBANK', 'HDFCLIFE', 'HINDALCO',
  'HINDUNILVR', 'ICICIBANK', 'INDIGO', 'INFY', 'ITC', 'JIOFIN', 'JSWSTEEL', 'KOTAKBANK', 'LT', 'M&M',
  'MARUTI', 'MAXHEALTH', 'NESTLEIND', 'NTPC', 'ONGC', 'POWERGRID', 'RELIANCE', 'SBILIFE', 'SHRIRAMFIN', 'SBIN',
  'SUNPHARMA', 'TCS', 'TATACONSUM', 'TMPV', 'TATASTEEL', 'TECHM', 'TITAN', 'TRENT', 'ULTRACEMCO', 'WIPRO',
  'BANKBARODA', 'PNB', 'CANBK', 'TATAPOWER', 'VEDL', 'BHEL', 'DLF', 'HAL', 'IOC', 'BPCL',
  'GAIL', 'SAIL', 'NMDC', 'IDFCFIRSTB', 'FEDERALBNK', 'LUPIN', 'TVSMOTOR', 'HEROMOTOCO', 'INDUSINDBK', 'ADANIGREEN'
];

const ROUNDS = []; for (let m = 9 * 60 + 30; m <= 14 * 60 + 30; m += 30) ROUNDS.push(m); // minutes after midnight IST
const MAX_PICKS = 10;            // per round, BUY + SELL together
const COST_PCT = 0.06;           // default round-trip charges in % of price (the app passes your own: charges ÷ amount, from Setup)
const costOf = (cfg) => (cfg && cfg.costPct != null ? cfg.costPct : COST_PCT);
const MIN_EDGE_PCT = 0.05;       // expected profit after charges must be at least this, in % of price
const MIN_PAST = 60;             // stock's own past success rate must be at least this (%)
const BAR = 300;
const r2 = (x) => Math.round(x * 100) / 100;

// ---------- Bayesian past success ----------
// A stock's own record with a setup is often small (e.g. 4 wins out of 5). Instead of trusting it blindly, we combine it with the
// overall record of that setup on all stocks (empirical Bayes, Beta prior worth PRIOR_K trades). Small samples are pulled toward
// the overall average; big, consistent records keep their own rate. "Certainty" = probability the true win rate is above 50%.
const PRIOR_K = 20;
function lgamma(z) { // Lanczos approximation
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1; let x = c[0]; for (let i = 1; i < g + 2; i++) x += c[i] / (z + i); const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function betaAbove(a, b, q) { // P(theta > q) for theta ~ Beta(a, b), numeric integration
  const N = 2000, lb = lgamma(a) + lgamma(b) - lgamma(a + b); let tot = 0, above = 0;
  for (let k = 0; k < N; k++) { const t = (k + 0.5) / N; const v = Math.exp((a - 1) * Math.log(t) + (b - 1) * Math.log(1 - t) - lb) / N; tot += v; if (t > q) above += v; }
  return tot ? above / tot : 0;
}
function bayesPast(wins, n, prior) {
  const p0 = Math.min(0.9, Math.max(0.1, prior || 0.45)), a = wins + PRIOR_K * p0, b = n - wins + PRIOR_K * (1 - p0);
  return { mean: a / (a + b), certainty: betaAbove(a, b, 0.5), raw: n ? wins / n : null };
}
// Overall record of the given strategies on one side, across all stocks (the Bayesian prior)
function priorOf(hist, ids, side) {
  let n = 0, w = 0;
  for (const h of Object.values(hist || {})) { const st = h && h.strat; if (!st) continue; for (const id of ids) { const t = st[id] && st[id][side]; if (t) { n += t.n; w += t.wins; } } }
  return n ? w / n : 0.45;
}
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
function epochFor(day, min) { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d) / 1000 - 19800 + min * 60; }

// index of the last candle that has closed by `sec` on `day`
function idxAt(c, day, sec) {
  let k = -1;
  for (let i = 0; i < c.length; i++) { if (c[i].time + BAR <= sec) { if (E.ist(c[i].time).day === day) k = i; } else break; }
  return k;
}

// close of the previous trading day before candle i
function prevCloseOf(c, i) {
  const d = E.ist(c[i].time).day;
  for (let k = i; k >= 0; k--) if (E.ist(c[k].time).day !== d) return c[k].close;
  return null;
}

function relVolAt(c, i) {
  const last = E.ist(c[i].time), byDay = {};
  for (let k = 0; k <= i; k++) { const t = E.ist(c[k].time); if (t.min <= last.min) byDay[t.day] = (byDay[t.day] || 0) + c[k].volume; }
  const today = byDay[last.day] || 0;
  const prev = Object.keys(byDay).filter((d) => d !== last.day).map((d) => byDay[d]).filter((v) => v > 0);
  if (!prev.length || !today) return null;
  return today / (prev.reduce((a, b) => a + b, 0) / prev.length);
}

function checksAt(c, ind, i, cfg, noVol) {
  let volRecent = noVol;
  for (let k = Math.max(0, i - 2); !volRecent && k <= i; k++) volRecent = !!ind.volAvg[k] && c[k].volume > ind.volAvg[k] * cfg.volMult;
  const b = c[i], rsi = ind.rsi[i];
  return {
    BUY: [[ind.dir[i] < 0, 'Supertrend up'], [ind.emaF[i] > ind.emaS[i], 'EMA 9 above 21'], [b.close > ind.vw[i], 'Above VWAP'], [rsi > cfg.rsiBuy, 'RSI ' + Math.round(rsi)], [volRecent, 'Volume spike']],
    SELL: [[ind.dir[i] > 0, 'Supertrend down'], [ind.emaF[i] < ind.emaS[i], 'EMA 9 below 21'], [b.close < ind.vw[i], 'Below VWAP'], [rsi < cfg.rsiSell, 'RSI ' + Math.round(rsi)], [volRecent, 'Volume spike']]
  };
}

// Levels if a trade is taken at the close of candle i
function levelsAt(c, ind, i, side) {
  const s = side === 'BUY' ? 1 : -1, price = c[i].close;
  let sl = ind.st[i];
  if (sl == null || (s === 1 && sl >= price) || (s === -1 && sl <= price)) sl = price - s * ind.atr[i];
  const risk = Math.abs(price - sl);
  return { entry: r2(price), sl: r2(sl), t1: r2(price + s * risk), t2: r2(price + s * 2 * risk), riskPct: r2((risk / price) * 100) };
}

// Follow a trade from candle `from` up to candle `to` (inclusive). Same rules as the signal engine.
function simulate(c, ind, from, to, side, lv, cfg) {
  const s = side === 'BUY' ? 1 : -1;
  let sl = lv.sl, t1Hit = false, t1Time = null;
  for (let i = from; i <= to; i++) {
    const b = c[i], t = E.ist(b.time);
    if (t.day !== E.ist(c[from - 1].time).day) { return finish(c[i - 1].close, 'Square-off time', c[i - 1].time); }
    const hitSL = s === 1 ? b.low <= sl : b.high >= sl;
    const hitT2 = s === 1 ? b.high >= lv.t2 : b.low <= lv.t2;
    const hitT1 = s === 1 ? b.high >= lv.t1 : b.low <= lv.t1;
    const flip = s === 1 ? ind.dir[i] > 0 : ind.dir[i] < 0;
    if (hitSL) return finish(sl, !t1Hit ? 'Stop-loss hit' : s * (sl - lv.entry) > 0 ? 'Trailing stop (Chandelier)' : 'Stop at entry', b.time);
    if (hitT2) return finish(lv.t2, 'Target 2 hit', b.time);
    if (flip) return finish(b.close, 'Supertrend flipped', b.time);
    if (t.min + 5 >= cfg.squareOffMin) return finish(b.close, 'Square-off 15:15', b.time);
    if (!t1Hit && hitT1) { t1Hit = true; t1Time = b.time; if (cfg.trail) sl = lv.entry; }
    if (t1Hit && cfg.trail) { const ch = s === 1 ? ind.chLong[i] : ind.chShort[i]; if (ch != null && s * (ch - sl) > 0) sl = ch; } // trail with Chandelier Exit
  }
  // still running
  const last = c[to];
  const livePts = last ? r2((last.close - lv.entry) * s) : 0;
  return { status: t1Hit ? 'T1' : 'OPEN', t1Hit, t1Time, livePts, success: t1Hit ? true : null, sl: r2(sl) };

  function finish(px, reason, time) {
    const exitPts = (px - lv.entry) * s;
    const t1Pts = Math.abs(lv.t1 - lv.entry);
    // half booked at Target 1 (if hit), the other half at the exit
    const pts = r2(t1Hit ? (t1Pts + exitPts) / 2 : exitPts);
    return { status: pts > 0 || reason === 'Target 2 hit' ? 'WON' : 'LOST', reason, t1Hit, t1Time, exitTime: time, exitPx: r2(px), pts, success: pts > 0, sl: r2(sl) };
  }
}

// Score a stock for one side at candle i
function scoreAt(sym, c, ind, i, cfg, noVol, prevClose) {
  const chk = checksAt(c, ind, i, cfg, noVol);
  const b = c[i];
  const rvol = relVolAt(c, i);
  const atrPct = ind.atr[i] ? (ind.atr[i] / b.close) * 100 : 0;
  const chg = prevClose ? ((b.close - prevClose) / prevClose) * 100 : 0;
  const out = {};
  for (const side of ['BUY', 'SELL']) {
    const s = side === 'BUY' ? 1 : -1;
    const met = chk[side].filter((x) => x[0]);
    const lv = levelsAt(c, ind, i, side);
    const reasons = met.map((x) => x[1]);
    let score = met.length * 18 + Math.min(rvol || 1, 4) * 8 + Math.min(atrPct, 0.6) * 25 + Math.max(Math.min(s * chg, 3), -2) * 4 - (lv.riskPct > 1.5 ? 15 : 0);
    const stretched = side === 'BUY' ? ind.rsi[i] > 85 : ind.rsi[i] < 15;
    if (stretched) { score -= 25; reasons.push(side === 'BUY' ? 'Overbought: wait for a pullback' : 'Oversold: wait for a bounce'); }
    if (rvol && rvol >= 1.3) reasons.push(`Volume ${rvol.toFixed(1)}× normal`);
    if (Math.abs(chg) >= 0.3) reasons.push(`${chg >= 0 ? 'Up' : 'Down'} ${Math.abs(chg).toFixed(1)}% today`);
    out[side] = { symbol: sym, side, rules: met.length, score: Math.round(score), reasons, levels: lv, chg: r2(chg), stretched };
  }
  return out;
}

// Strategy test on earlier days: at every round time, check which strategies fire, follow the trade, record the result.
// Also produces the training examples for the learning model.
function backtest(sym, hist, cfg, beforeDay, daily) {
  const now = Math.floor(Date.now() / 1000);
  const c = hist.candles.filter((b) => b.time + BAR <= now);
  if (c.length < 60) return null;
  const ind = E.indicators(c, cfg);
  const noVol = E.isIndex(sym) || c.slice(-60).every((b) => !b.volume);
  const ctx = { days: ST.dayInfo(c), sma50: ST.dailySma50Map(daily), noVol };
  const days = [...new Set(c.map((b) => E.ist(b.time).day))].filter((d) => d < beforeDay);
  const res = { BUY: { n: 0, wins: 0 }, SELL: { n: 0, wins: 0 }, days: days.length, samples: [], strat: {} };
  for (const day of days) {
    const lastIdx = idxAt(c, day, epochFor(day, 15 * 60 + 30));
    for (const m of ROUNDS) {
      const i = idxAt(c, day, epochFor(day, m));
      if (i < 30) continue;
      const chk = checksAt(c, ind, i, cfg, noVol);
      const cx = Object.assign(ST.context(c, ind, i, ctx), { noVol });
      for (const side of ['BUY', 'SELL']) {
        const s = side === 'BUY' ? 1 : -1;
        if (!ST.trendOk(c, ind, i, s, cx)) continue;
        const rules = chk[side].filter((x) => x[0]).length;
        const ids = ST.fired(c, ind, i, s, cx, rules);
        if (rules < 3 && !ids.length) continue;
        const lv = levelsAt(c, ind, i, side);
        const out = simulate(c, ind, i + 1, lastIdx, side, lv, cfg);
        if (out.status === 'OPEN' || out.status === 'T1') continue;
        const risk = Math.abs(lv.entry - lv.sl) || 1;
        const cost = costOf(cfg);
        const rNet = out.pts / risk - cost / (lv.riskPct || 1);   // result in multiples of risk, after charges
        const profit = (out.pts / lv.entry) * 100 > cost;           // success = profit AFTER your charges
        const x = M.features(c, ind, i, s, rules, relVolAt(c, i), prevCloseOf(c, i), lv.riskPct, m, ST.extraFeatures(c, ind, i, s, cx, ids, risk));
        res.samples.push({ day, x, y: profit ? 1 : 0, r: out.pts / risk });
        res[side].n++; if (profit) res[side].wins++;
        for (const id of ids) {
          const t = (res.strat[id] = res.strat[id] || { BUY: { n: 0, wins: 0, sumR: 0 }, SELL: { n: 0, wins: 0, sumR: 0 } })[side];
          t.n++; if (profit) t.wins++; t.sumR += rNet;
        }
      }
    }
  }
  return res;
}

// Combine every stock's strategy test into one table and choose the best strategies
function rankStrategies(histList) {
  const rows = ST.STRATEGIES.map((st) => {
    const r = { id: st.id, name: st.name, from: st.from, n: 0, wins: 0, sumR: 0, BUY: { n: 0, wins: 0 }, SELL: { n: 0, wins: 0 } };
    for (const h of histList) {
      const t = h && h.strat && h.strat[st.id]; if (!t) continue;
      for (const side of ['BUY', 'SELL']) { r.n += t[side].n; r.wins += t[side].wins; r.sumR += t[side].sumR; r[side].n += t[side].n; r[side].wins += t[side].wins; }
    }
    r.rate = r.n ? Math.round((r.wins / r.n) * 100) : null;
    r.avgR = r.n ? Math.round((r.sumR / r.n) * 100) / 100 : null;
    return r;
  });
  const good = rows.filter((r) => r.n >= 30 && r.rate >= 55 && r.avgR > 0.05).sort((a, b) => b.avgR - a.avgR);
  let active = good.slice(0, 5).map((r) => r.id);
  let fallback = false;
  if (!active.length) { active = ['core']; fallback = true; }
  for (const r of rows) r.active = active.includes(r.id);
  rows.sort((a, b) => (b.active - a.active) || ((b.avgR ?? -9) - (a.avgR ?? -9)));
  return { rows, active, fallback, notAdded: ST.NOT_ADDED };
}

// Build all rounds for the trading day of the given 5-minute data set.
// stocks: [{ sym, data }]   hist: { [sym]: backtest result }
function buildDay(stocks, cfg, hist, model, active, dailyMap) {
  active = active && active.length ? active : ['core'];
  const now = Math.floor(Date.now() / 1000);
  // trading day = newest candle day across stocks
  let day = null;
  const prepared = [];
  for (const { sym, data } of stocks) {
    const c = data.candles.filter((b) => b.time + BAR <= now);
    if (c.length < 40) continue;
    const d = E.ist(c[c.length - 1].time).day; if (!day || d > day) day = d;
    const noVol = E.isIndex(sym) || c.slice(-60).every((b) => !b.volume);
    prepared.push({ sym, c, ind: E.indicators(c, cfg), noVol, prevClose: data.prevClose, name: data.name, ctx: { days: ST.dayInfo(c), sma50: ST.dailySma50Map(dailyMap && dailyMap[sym]), noVol } });
  }
  if (!day) return { day: null, rounds: [], summary: null };
  const cutoff = model && model.cutoff ? Math.max(0.6, model.cutoff) : 0.6;
  const avgWinR = (model && model.avgWinR) || 1.25, avgLossR = (model && model.avgLossR) || 1;
  const rounds = [];
  const openUntil = {}; // sym|side -> epoch when the earlier pick finished (or Infinity)
  for (const m of ROUNDS) {
    const at = epochFor(day, m);
    if (at > now) break;
    const cands = [];
    let considered = 0;
    for (const p of prepared) {
      if (E.ist(p.c[p.c.length - 1].time).day !== day) continue;
      const i = idxAt(p.c, day, at);
      if (i < 30) continue;
      const sc = scoreAt(p.sym, p.c, p.ind, i, cfg, p.noVol, p.prevClose);
      for (const side of ['BUY', 'SELL']) {
        const x = sc[side], s = side === 'BUY' ? 1 : -1;
        if (x.stretched) continue;
        if ((openUntil[p.sym + '|' + side] || 0) > at) continue; // already an open pick for this stock
        // 0) trend filter + at least one of the best strategies must fire
        const cx = Object.assign(ST.context(p.c, p.ind, i, p.ctx), { noVol: p.noVol });
        if (!ST.trendOk(p.c, p.ind, i, s, cx)) continue;
        const ids = ST.fired(p.c, p.ind, i, s, cx, x.rules);
        const act = ids.filter((id) => active.includes(id));
        if (!act.length) continue;
        considered++;
        // 1) the learning model's win chance
        const risk = Math.abs(x.levels.entry - x.levels.sl) || 1;
        const feats = M.features(p.c, p.ind, i, s, x.rules, relVolAt(p.c, i), prevCloseOf(p.c, i), x.levels.riskPct, m, ST.extraFeatures(p.c, p.ind, i, s, cx, ids, risk));
        const prob = M.predict(model, feats);
        if (prob == null || prob < cutoff) continue;
        // 2) this stock's own past success with these strategies
        const hs = hist[p.sym] && hist[p.sym].strat;
        const h = { n: 0, wins: 0 };
        for (const id of act) { const t = hs && hs[id] && hs[id][side]; if (t) { h.n += t.n; h.wins += t.wins; } }
        // 2b) Bayesian past success: stock's own record shrunk toward the setup's record on all stocks
        const bp = bayesPast(h.wins, h.n, priorOf(hist, act, side));
        const pastRate = h.n >= 5 ? Math.round(bp.mean * 100) : null;
        if (pastRate == null || pastRate < MIN_PAST) continue;
        x.reasons = act.map((id) => ST.BY_ID[id].name).concat(x.reasons);
        x.strategies = act.map((id) => ST.BY_ID[id].name);
        // 3) expected profit after charges, in % of price
        const R = x.levels.riskPct;
        const cost = costOf(cfg);
        const expPct = prob * avgWinR * R - (1 - prob) * avgLossR * R - cost;
        if (R < 3 * cost || expPct < MIN_EDGE_PCT) continue;
        cands.push(Object.assign(x, { p, i, side, feats, prob, pastRate, h, expPct, bp }));
      }
    }
    const round = { min: m, time: hhmm(m), at, considered, picks: { BUY: [], SELL: [] } };
    cands.sort((a, b) => b.expPct - a.expPct);
    for (const x of cands.slice(0, MAX_PICKS)) {
      const p = x.p, side = x.side;
      const lastIdx = p.c.length - 1;
      const out = simulate(p.c, p.ind, x.i + 1, lastIdx, side, x.levels, cfg);
      openUntil[p.sym + '|' + side] = out.exitTime ? out.exitTime + BAR : Infinity;
      round.picks[side].push({
        symbol: p.sym.replace(/^.*:/, ''), name: p.name || '', side, rules: x.rules, score: x.score, reasons: x.reasons, chg: x.chg, strategies: x.strategies,
        levels: x.levels, price: r2(p.c[lastIdx].close), result: out, startTime: p.c[x.i].time + BAR,
        winChance: Math.round(x.prob * 100),
        expected: { pct: r2(x.expPct), perShare: r2((x.expPct / 100) * x.levels.entry), costPct: costOf(cfg) },
        past: { n: x.h.n, wins: x.h.wins, rate: x.pastRate, raw: x.bp.raw == null ? null : Math.round(x.bp.raw * 100), certainty: Math.round(x.bp.certainty * 100), days: hist[p.sym].days },
        x: x.feats
      });
    }
    rounds.push(round);
  }
  // summaries
  const all = rounds.flatMap((r) => r.picks.BUY.concat(r.picks.SELL));
  const sum = (list) => {
    const won = list.filter((x) => x.result.status === 'WON').length, lost = list.filter((x) => x.result.status === 'LOST').length;
    const t1 = list.filter((x) => x.result.status === 'T1').length, open = list.filter((x) => x.result.status === 'OPEN').length;
    const done = won + lost;
    return { total: list.length, won, lost, runningT1: t1, open, rate: done ? Math.round((won / done) * 100) : null };
  };
  for (const r of rounds) r.summary = sum(r.picks.BUY.concat(r.picks.SELL));
  const nextMin = ROUNDS.find((m) => epochFor(day, m) > now);
  return { day, rounds, summary: sum(all), nextRound: day === E.todayIST() && nextMin ? hhmm(nextMin) : null };
}

// Live evaluation of one stock right now, for the chart's trade card
function suggestNow(sym, data, cfg, hist, model, active, daily) {
  active = active && active.length ? active : ['core'];
  const now = Math.floor(Date.now() / 1000);
  const c = data.candles.filter((b) => b.time + BAR <= now);
  if (c.length < 40) return null;
  const ind = E.indicators(c, cfg), i = c.length - 1;
  const noVol = E.isIndex(sym) || c.slice(-60).every((b) => !b.volume);
  const ctx = { days: ST.dayInfo(c), sma50: ST.dailySma50Map(daily), noVol };
  const sc = scoreAt(sym, c, ind, i, cfg, noVol, data.prevClose);
  const m = E.ist(c[i].time).min + 5;
  const cx = Object.assign(ST.context(c, ind, i, ctx), { noVol });
  let best = null;
  for (const side of ['BUY', 'SELL']) {
    const x = sc[side], s = side === 'BUY' ? 1 : -1;
    const trend = ST.trendOk(c, ind, i, s, cx);
    const ids = ST.fired(c, ind, i, s, cx, x.rules), act = ids.filter((id) => active.includes(id));
    const risk = Math.abs(x.levels.entry - x.levels.sl) || 1;
    const prob = M.predict(model, M.features(c, ind, i, s, x.rules, relVolAt(c, i), prevCloseOf(c, i), x.levels.riskPct, m, ST.extraFeatures(c, ind, i, s, cx, ids, risk)));
    const hs = hist && hist.strat, h = { n: 0, wins: 0 };
    for (const id of act) { const t = hs && hs[id] && hs[id][side]; if (t) { h.n += t.n; h.wins += t.wins; } }
    const bp = bayesPast(h.wins, h.n, 0.45);
    const pastRate = h.n >= 5 ? Math.round(bp.mean * 100) : null;
    const cand = { certainty: Math.round(bp.certainty * 100), side, rules: x.rules, levels: x.levels, time: c[i].time + BAR, winChance: prob == null ? null : Math.round(prob * 100), pastRate,
      stretched: x.stretched, trend, strategies: act.map((id) => ST.BY_ID[id].name), noStrategy: !act.length,
      ok: trend && act.length > 0 && !x.stretched && prob != null && prob >= Math.max(0.6, (model && model.cutoff) || 0.6) && pastRate != null && pastRate >= MIN_PAST && m <= 14 * 60 + 45 };
    if (!best || (cand.ok && !best.ok) || (cand.ok === best.ok && (cand.winChance || 0) > (best.winChance || 0))) best = cand;
  }
  return best;
}

// ---------- Momentum now: rank every scanned stock by current strength ----------
// Not a tested edge — a live ranking of which stocks are moving strongly with trend, volume and VWAP behind them.
function momentumRank(stocks, cfg, n = 10) {
  const now = Math.floor(Date.now() / 1000);
  const rows = [];
  for (const { sym, data } of stocks) {
    const c = data.candles.filter((b) => b.time + BAR <= now);
    if (c.length < 60) continue;
    const i = c.length - 1, b = c[i];
    const ind = E.indicators(c, cfg);
    if (ind.dir[i] == null || ind.emaF[i] == null || ind.rsi[i] == null) continue;
    const day = E.ist(b.time).day, today = c.filter((x) => E.ist(x.time).day === day);
    if (today.length < 3) continue;                                    // need at least 15 minutes of today
    const prev = prevCloseOf(c, i);
    const chg = prev ? ((b.close - prev) / prev) * 100 : 0;
    const k6 = Math.max(0, i - 6), move30 = ((b.close - c[k6].close) / c[k6].close) * 100;
    const noVol = E.isIndex(sym) || c.slice(-60).every((x) => !x.volume);
    const rvol = noVol ? null : relVolAt(c, i);
    const vwDist = ((b.close - ind.vw[i]) / b.close) * 100;
    for (const side of ['BUY', 'SELL']) {
      const s = side === 'BUY' ? 1 : -1;
      const st = s === 1 ? ind.dir[i] < 0 : ind.dir[i] > 0, ema = s * (ind.emaF[i] - ind.emaS[i]) > 0, vw = s * vwDist > 0;
      const aligned = [st, ema, vw].filter(Boolean).length;
      if (aligned < 3 || s * chg <= 0.3) continue;                      // must be moving with trend, EMA and VWAP all agreeing
      const stretched = s === 1 ? ind.rsi[i] > 85 : ind.rsi[i] < 15;
      let score = Math.min(s * chg, 5) * 10 + Math.max(Math.min(s * move30, 2), -1) * 12 + Math.min(rvol || 1, 4) * 8 + Math.min(s * vwDist, 2) * 5;
      if (stretched) score -= 25;
      const reasons = [`${s === 1 ? 'Up' : 'Down'} ${Math.abs(chg).toFixed(1)}% today`];
      if (Math.abs(move30) >= 0.2) reasons.push(`${move30 >= 0 ? '+' : ''}${move30.toFixed(1)}% in last 30 min`);
      if (rvol && rvol >= 1.2) reasons.push(`Volume ${rvol.toFixed(1)}× normal`);
      reasons.push(s === 1 ? 'Supertrend up' : 'Supertrend down', s === 1 ? 'EMA 9 above 21' : 'EMA 9 below 21', s === 1 ? 'Above VWAP' : 'Below VWAP');
      if (stretched) reasons.push(s === 1 ? 'Overbought: wait for a pullback' : 'Oversold: wait for a bounce');
      rows.push({ symbol: sym.replace(/^.*:/, ''), name: data.name || '', side, score: Math.round(score), price: r2(b.close), chg: r2(chg), move30: r2(move30),
        rvol: rvol ? r2(rvol) : null, rsi: Math.round(ind.rsi[i]), stretched, reasons, levels: levelsAt(c, ind, i, side), time: b.time + BAR });
    }
  }
  const pick = (side) => rows.filter((x) => x.side === side).sort((a, b) => b.score - a.score).slice(0, n);
  return { at: new Date().toISOString(), up: pick('BUY'), down: pick('SELL') };
}

// What the model "sees" at candle i: used to learn from Momentum and Watchlist-signal trades too
function featuresAt(sym, c, ind, i, side, cfg, daily) {
  const s = side === 'BUY' ? 1 : -1;
  const noVol = E.isIndex(sym) || c.slice(-60).every((b) => !b.volume);
  const ctx = { days: ST.dayInfo(c), sma50: ST.dailySma50Map(daily), noVol };
  const cx = Object.assign(ST.context(c, ind, i, ctx), { noVol });
  const rules = checksAt(c, ind, i, cfg, noVol)[side].filter((x) => x[0]).length;
  const ids = ST.fired(c, ind, i, s, cx, rules);
  const lv = levelsAt(c, ind, i, side);
  const m = E.ist(c[i].time).min + 5;
  return M.features(c, ind, i, s, rules, relVolAt(c, i), prevCloseOf(c, i), lv.riskPct, m, ST.extraFeatures(c, ind, i, s, cx, ids, Math.abs(lv.entry - lv.sl) || 1));
}

module.exports = { featuresAt, momentumRank, DEFAULT_SCAN_LIST, ROUNDS, buildDay, backtest, rankStrategies, hhmm, suggestNow, COST_PCT, MIN_PAST,
  _t: { idxAt, epochFor, checksAt, levelsAt, simulate, relVolAt, prevCloseOf } };
