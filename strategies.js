// SwingPulse strategies
// Each strategy is a clear BUY rule (SELL is the mirror image), checked on 5-minute candles.
// The app tests every strategy on about a month of history and only uses the ones that made money.
const E = require('./engine');

const r2 = (x) => Math.round(x * 100) / 100;

// Per-day info from 5-minute candles: day open, previous day high/low/close, classic pivot points
function dayInfo(c) {
  const days = {}, order = [];
  for (const b of c) {
    const d = E.ist(b.time).day;
    if (!days[d]) { days[d] = { open: b.open, high: b.high, low: b.low, close: b.close }; order.push(d); }
    const x = days[d]; x.high = Math.max(x.high, b.high); x.low = Math.min(x.low, b.low); x.close = b.close;
  }
  for (let k = 1; k < order.length; k++) {
    const p = days[order[k - 1]], x = days[order[k]];
    const P = (p.high + p.low + p.close) / 3;
    Object.assign(x, { prevH: p.high, prevL: p.low, prevC: p.close, P, R1: 2 * P - p.low, S1: 2 * P - p.high, R2: P + (p.high - p.low), S2: P - (p.high - p.low),
      gapPct: ((x.open - p.close) / p.close) * 100 });
  }
  return days;
}

// 50-day SMA as of each day's open (uses daily candles, previous days only)
function dailySma50Map(daily) {
  const map = {};
  if (!daily || !daily.candles) return map;
  const dc = daily.candles, closes = dc.map((b) => b.close);
  for (let i = 0; i < dc.length; i++) {
    if (i < 50) continue;
    let s = 0; for (let k = i - 50; k < i; k++) s += closes[k];
    map[E.ist(dc[i].time).day] = s / 50;
  }
  // also make it available for the next (today's) session
  if (dc.length >= 50) { let s = 0; for (let k = dc.length - 50; k < dc.length; k++) s += closes[k]; map._last = s / 50; map._lastDay = E.ist(dc[dc.length - 1].time).day; }
  return map;
}

function relVol(c, i) {
  const last = E.ist(c[i].time), byDay = {};
  for (let k = Math.max(0, i - 2000); k <= i; k++) { const t = E.ist(c[k].time); if (t.min <= last.min) byDay[t.day] = (byDay[t.day] || 0) + c[k].volume; }
  const today = byDay[last.day] || 0;
  const prev = Object.keys(byDay).filter((d) => d !== last.day).map((d) => byDay[d]).filter((v) => v > 0);
  if (!prev.length || !today) return null;
  return today / (prev.reduce((a, b) => a + b, 0) / prev.length);
}

const within = (n, i, fn) => { for (let k = Math.max(1, i - n + 1); k <= i; k++) if (fn(k)) return true; return false; };

// ctx: { days (from dayInfo), sma50 (map), noVol }
function context(c, ind, i, ctx) {
  const d = E.ist(c[i].time).day, di = ctx.days[d] || {};
  let sma50 = ctx.sma50 ? ctx.sma50[d] : null;
  if (sma50 == null && ctx.sma50 && ctx.sma50._lastDay && ctx.sma50._lastDay < d) sma50 = ctx.sma50._last;
  return { di, sma50, rvol: ctx.noVol ? null : relVol(c, i), min: E.ist(c[i].time).min + 5 };
}

// Filters to avoid false trades (Setup): ADX minimum (sideways market) and a confirmation candle.
const FILTERS = { adxMin: 20, confirm: true };
function setFilters(f) { if (f && f.adxMin != null) FILTERS.adxMin = Number(f.adxMin) || 0; if (f && f.confirm != null) FILTERS.confirm = !!f.confirm; }
function filtersOk(c, ind, i, s) {
  if (FILTERS.adxMin > 0 && !(ind.adx && ind.adx[i] != null && ind.adx[i] >= FILTERS.adxMin)) return false;
  // confirmation: the last closed candle moved in the trade's direction (closed beyond the previous close, right colour)
  if (FILTERS.confirm && i > 0 && !(s * (c[i].close - c[i - 1].close) > 0 && s * (c[i].close - c[i].open) > 0)) return false;
  return true;
}

// Trend filter from your rules: 10 & 20 SMA vs 200 EMA, and price vs the 50-day SMA (+ the false-trade filters above)
function trendOk(c, ind, i, s, cx) {
  if (!filtersOk(c, ind, i, s)) return false;
  const a = ind.sma10[i], b = ind.sma20[i], e = ind.ema200[i], px = c[i].close;
  if (a != null && b != null && e != null) {
    if (s === 1 && a < e && b < e) return false;   // both below 200 → downtrend: no buys
    if (s === -1 && a > e && b > e) return false;  // both above 200 → uptrend: no sells
  }
  if (cx.sma50 != null) { if (s === 1 && px < cx.sma50) return false; if (s === -1 && px > cx.sma50) return false; }
  return true;
}

function volBurst(c, ind, i, x) { for (let k = Math.max(0, i - 2); k <= i; k++) if (ind.volAvg[k] && c[k].volume >= ind.volAvg[k] * x) return true; return false; }

// ---- the strategies (s = +1 for BUY, -1 for SELL) ----
const STRATEGIES = [
  { id: 'core', name: 'Core 5 rules', from: 'Supertrend, 9/21 EMA, VWAP, RSI, Volume',
    test: (c, ind, i, s, cx, rules) => rules >= 4 },
  { id: 'smaCross', name: '10/20 SMA cross with 200 trend', from: '10 SMA × 20 SMA, 200 EMA',
    test: (c, ind, i, s) => within(6, i, (k) => ind.sma10[k] != null && ind.sma20[k] != null && ind.sma10[k - 1] != null && s * (ind.sma10[k] - ind.sma20[k]) > 0 && s * (ind.sma10[k - 1] - ind.sma20[k - 1]) <= 0)
      && ind.ema200[i] != null && s * (ind.sma10[i] - ind.ema200[i]) > 0 && s * (ind.sma20[i] - ind.ema200[i]) > 0 },
  { id: 'macd', name: 'MACD momentum', from: 'MACD above zero and rising, above VWAP',
    test: (c, ind, i, s) => ind.macd[i] != null && ind.macdHist[i] != null && ind.macdHist[i - 1] != null && s * ind.macd[i] > 0 && s * (ind.macdHist[i] - ind.macdHist[i - 1]) > 0 && s * ind.macdHist[i] > 0 && s * (c[i].close - ind.vw[i]) > 0 },
  { id: 'stFlip', name: 'Supertrend colour reversal', from: 'Supertrend flip, with 200 EMA trend',
    test: (c, ind, i, s) => within(6, i, (k) => ind.dir[k] != null && ind.dir[k - 1] != null && ind.dir[k] === -s && ind.dir[k - 1] === s) && ind.ema200[i] != null && s * (c[i].close - ind.ema200[i]) > 0 },
  { id: 'breakout', name: 'Swing breakout + volume burst', from: '20-candle high/low break (trend-line/swing breakout), Volume burst, RVOL',
    test: (c, ind, i, s, cx) => !cx.noVol && within(3, i, (k) => (s === 1 ? ind.dcHi[k] != null && c[k].close > ind.dcHi[k] : ind.dcLo[k] != null && c[k].close < ind.dcLo[k])) && volBurst(c, ind, i, 2) && (cx.rvol == null || cx.rvol >= 1.2) },
  { id: 'rsi70', name: 'RSI 70 momentum', from: 'RSI above 70 for buying (below 30 for selling), above VWAP & 21 EMA',
    test: (c, ind, i, s) => ind.rsi[i] != null && (s === 1 ? ind.rsi[i] > 70 : ind.rsi[i] < 30) && s * (c[i].close - ind.vw[i]) > 0 && s * (c[i].close - ind.emaS[i]) > 0 },
  { id: 'ma44', name: '44 MA pullback', from: '44 moving average rising + Stochastic turn (CM Stochastic)',
    test: (c, ind, i, s) => ind.sma44[i] != null && ind.sma44[i - 6] != null && s * (c[i].close - ind.sma44[i]) > 0 && s * (ind.sma44[i] - ind.sma44[i - 6]) > 0
      && within(3, i, (k) => ind.stochK[k] != null && ind.stochD[k] != null && ind.stochK[k - 1] != null && ind.stochD[k - 1] != null
        && s * (ind.stochK[k] - ind.stochD[k]) > 0 && s * (ind.stochK[k - 1] - ind.stochD[k - 1]) <= 0 && (s === 1 ? ind.stochK[k - 1] < 30 : ind.stochK[k - 1] > 70)) },
  { id: 'donchian', name: 'Donchian trend ribbon', from: 'Donchian trend + 9/21 EMA + VWAP',
    test: (c, ind, i, s) => ind.dcTrend[i] === s && within(6, i, (k) => ind.dcTrend[k - 1] !== s) && s * (ind.emaF[i] - ind.emaS[i]) > 0 && s * (c[i].close - ind.vw[i]) > 0 },
  { id: 'pivot', name: 'Pivot point breakout', from: 'Classic pivots: break of R1 (buy) or S1 (sell) with volume',
    test: (c, ind, i, s, cx) => { const di = cx.di; if (di.R1 == null) return false; const lvl = s === 1 ? di.R1 : di.S1;
      return within(3, i, (k) => s * (c[k].close - lvl) > 0 && s * (c[k - 1].close - lvl) <= 0) && (cx.noVol || volBurst(c, ind, i, 1.5)); } },
  { id: 'gap', name: 'Gap & go (episodic pivot)', from: 'Gap of 1%+ with RVOL 2+, holding above day open & VWAP, before 11:30',
    test: (c, ind, i, s, cx) => { const di = cx.di; return !cx.noVol && di.gapPct != null && s * di.gapPct >= 1 && cx.rvol != null && cx.rvol >= 2 && cx.min <= 11 * 60 + 30
      && s * (c[i].close - di.open) > 0 && s * (c[i].close - ind.vw[i]) > 0; } },
  { id: 'stConfirm', name: 'Supertrend confirmed reversal (ADX)', from: 'Supertrend flip, candle closes beyond Supertrend, next candle confirms, VWAP, 50 EMA, 200 EMA, ADX 14 above 20, RSI 14 and 9/21 EMA agree',
    test: (c, ind, i, s) => {
      // flip on candle j (1–3 candles ago), then a later candle closed further in the new direction
      let j = -1;
      for (let k = i - 1; k >= Math.max(1, i - 3); k--) if (ind.dir[k] === -s && ind.dir[k - 1] === s) { j = k; break; }
      if (j < 0 || ind.dir[i] !== -s) return false;
      if (!(s * (c[j].close - ind.st[j]) > 0)) return false;
      let confirmed = false;
      for (let k = j + 1; k <= i; k++) if (s * (c[k].close - c[j].close) > 0 && s * (c[k].close - c[k].open) > 0) { confirmed = true; break; }
      if (!confirmed) return false;
      const px = c[i].close;
      return s * (px - ind.st[i]) > 0 && s * (px - ind.vw[i]) > 0 && ind.ema50[i] != null && s * (px - ind.ema50[i]) > 0
        && ind.ema200[i] != null && s * (px - ind.ema200[i]) > 0 && ind.adx[i] != null && ind.adx[i] > 20
        && ind.rsi[i] != null && s * (ind.rsi[i] - 50) > 0 && s * (ind.emaF[i] - ind.emaS[i]) > 0;
    } }
];
const BY_ID = Object.fromEntries(STRATEGIES.map((x) => [x.id, x]));

// Which strategies fire at candle i for side s
function fired(c, ind, i, s, cx, rules) {
  if (i < 30) return [];
  return STRATEGIES.filter((st) => { try { return !!st.test(c, ind, i, s, cx, rules); } catch (e) { return false; } }).map((st) => st.id);
}

// Extra numbers for the learning model
function extraFeatures(c, ind, i, s, cx, firedIds, riskPts) {
  const clip = (x, a, b) => Math.max(a, Math.min(b, x));
  const px = c[i].close;
  const flags = STRATEGIES.filter((x) => x.id !== 'core').map((x) => (firedIds.includes(x.id) ? 1 : 0));
  const macdN = ind.macd[i] != null ? clip((s * ind.macd[i] / px) * 1000, -1, 1) : 0;
  const stoch = ind.stochK[i] != null ? clip(s * (ind.stochK[i] - 50) / 50, -1, 1) : 0;
  const di = cx.di;
  let room = 1;
  if (di.R1 != null && riskPts > 0) {
    const levels = [di.S2, di.S1, di.P, di.R1, di.R2].filter((v) => v != null);
    const ahead = levels.filter((v) => s * (v - px) > 0).map((v) => Math.abs(v - px));
    room = ahead.length ? clip(Math.min(...ahead) / (2 * riskPts), 0, 1) : 1;
  }
  const d50 = cx.sma50 != null ? clip(s * ((px - cx.sma50) / cx.sma50) * 10, -1, 1) : 0;
  const t200 = ind.ema200[i] != null ? clip(s * ((px - ind.ema200[i]) / px) * 100, -1, 1) : 0;
  const adxN = ind.adx && ind.adx[i] != null ? clip((ind.adx[i] - 20) / 20, -1, 1) : 0;
  return flags.concat([macdN, stoch, room, d50, t200, adxN]);
}
const EXTRA_NAMES = STRATEGIES.filter((x) => x.id !== 'core').map((x) => 's_' + x.id).concat(['macd', 'stoch', 'pivotRoom', 'trend50d', 'trend200', 'adx']);

const NOT_ADDED = [
  { name: 'PCR data, OI analysis', why: 'Needs live option-chain data (Put/Call ratio, open interest). The free price feed this app uses does not have it.' },
  { name: 'ZigZag indicator', why: 'It redraws past swings once new prices arrive, so it cannot be traded live and makes back-tests look falsely good. The swing breakout strategy covers swing highs/lows without redrawing.' },
  { name: 'VuManChu Swing Free, Imbalance Algo, USE Algo, Purple dot (fast swing speed)', why: 'Closed TradingView community scripts whose exact rules are not public. Their ideas (fast swing moves, trend shifts) are covered by Supertrend reversal, Donchian trend and MACD momentum.' },
  { name: 'Breakout probability', why: 'This is what the learning model already calculates for every pick (its win chance).' }
];

module.exports = { FILTERS, setFilters, filtersOk, STRATEGIES, BY_ID, NOT_ADDED, EXTRA_NAMES, dayInfo, dailySma50Map, context, trendOk, fired, extraFeatures, relVol };
