// SwingPulse signal engine: price feed (Yahoo Finance) + indicators + trade rules.
// Same rules as the SwingPulse TradingView indicator.

const IST = 19800; // seconds offset from UTC

// ---------- symbols ----------
const INDEX_MAP = { NIFTY: '^NSEI', NIFTY50: '^NSEI', 'NIFTY 50': '^NSEI', BANKNIFTY: '^NSEBANK', NIFTYBANK: '^NSEBANK', SENSEX: '^BSESN', FINNIFTY: 'NIFTY_FIN_SERVICE.NS' };
function yahooSymbol(sym) {
  const s = String(sym).toUpperCase().trim();
  const [ex, name] = s.includes(':') ? s.split(':') : ['NSE', s];
  if (INDEX_MAP[name]) return INDEX_MAP[name];
  return name + (ex === 'BSE' ? '.BO' : '.NS');
}
function isIndex(sym) { return yahooSymbol(sym).startsWith('^') || yahooSymbol(sym).startsWith('NIFTY_'); }

// ---------- time helpers (IST) ----------
function ist(ts) { const d = new Date((ts + IST) * 1000); return { day: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() }; }
function todayIST() { return ist(Math.floor(Date.now() / 1000)).day; }
function nowMinIST() { return ist(Math.floor(Date.now() / 1000)).min; }

// ---------- data fetch ----------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const RANGE = { '1m': '1d', '5m': '5d', '15m': '5d', '60m': '1mo', '1d': '1y' };
async function fetchCandles(sym, interval = '5m', range) {
  const y = yahooSymbol(sym);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?interval=${interval}&range=${range || RANGE[interval] || '5d'}&includePrePost=false`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Price feed returned ${res.status} for ${y}`);
  const j = await res.json();
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp) throw new Error((j && j.chart && j.chart.error && j.chart.error.description) || `No data for ${y}`);
  const q = r.indicators.quote[0];
  const candles = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (q.open[i] == null || q.high[i] == null || q.low[i] == null || q.close[i] == null) continue;
    candles.push({ time: r.timestamp[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
  }
  const m = r.meta || {};
  // Previous close = last candle of the previous trading day in the data.
  // (Yahoo's "chartPreviousClose" is the close BEFORE the whole requested range, e.g. 5 days ago, so it is not used.)
  let prevClose = null;
  if (interval !== '1d' && candles.length) {
    const lastDay = ist(candles[candles.length - 1].time).day;
    for (let k = candles.length - 1; k >= 0; k--) if (ist(candles[k].time).day !== lastDay) { prevClose = candles[k].close; break; }
  }
  if (prevClose == null) prevClose = m.previousClose != null ? m.previousClose : m.chartPreviousClose;
  return { candles, price: m.regularMarketPrice, prevClose, name: m.longName || m.shortName || '' };
}

// ---------- indicators ----------
function ema(vals, len) {
  const out = new Array(vals.length).fill(null); const k = 2 / (len + 1); let prev = null, sum = 0;
  for (let i = 0; i < vals.length; i++) {
    if (i < len - 1) { sum += vals[i]; continue; }
    if (i === len - 1) { sum += vals[i]; prev = sum / len; } else prev = vals[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
function rma(vals, len) {
  const out = new Array(vals.length).fill(null); let prev = null, sum = 0;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] == null) continue;
    if (prev == null) { sum += vals[i]; if (i === len - 1) prev = sum / len; else continue; } else prev = (prev * (len - 1) + vals[i]) / len;
    out[i] = prev;
  }
  return out;
}
function sma(vals, len) {
  const out = new Array(vals.length).fill(null); let sum = 0;
  for (let i = 0; i < vals.length; i++) { sum += vals[i]; if (i >= len) sum -= vals[i - len]; if (i >= len - 1) out[i] = sum / len; }
  return out;
}
function rsi(closes, len) {
  const g = [null], l = [null];
  for (let i = 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; g.push(Math.max(d, 0)); l.push(Math.max(-d, 0)); }
  const ag = rma(g.slice(1), len), al = rma(l.slice(1), len);
  return [null].concat(ag.map((a, i) => (a == null || al[i] == null ? null : al[i] === 0 ? 100 : 100 - 100 / (1 + a / al[i]))));
}
function supertrend(c, factor, len) {
  const tr = c.map((b, i) => (i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - c[i - 1].close), Math.abs(b.low - c[i - 1].close))));
  const atr = rma(tr, len);
  const st = [], dir = []; let pl = null, pu = null, pst = null;
  for (let i = 0; i < c.length; i++) {
    if (atr[i] == null) { st.push(null); dir.push(null); continue; }
    const src = (c[i].high + c[i].low) / 2;
    let lo = src - factor * atr[i], up = src + factor * atr[i];
    const pc = i > 0 ? c[i - 1].close : c[i].close;
    if (pl != null) lo = lo > pl || pc < pl ? lo : pl;
    if (pu != null) up = up < pu || pc > pu ? up : pu;
    let d;
    if (pst == null) d = 1;
    else if (pst === pu) d = c[i].close > up ? -1 : 1;
    else d = c[i].close < lo ? 1 : -1;
    const s = d === -1 ? lo : up;
    st.push(s); dir.push(d); pl = lo; pu = up; pst = s;
  }
  return { st, dir, atr };
}
function vwap(c) {
  const out = []; let day = null, pv = 0, v = 0, tpSum = 0, n = 0;
  for (const b of c) {
    const d = ist(b.time).day; if (d !== day) { day = d; pv = 0; v = 0; tpSum = 0; n = 0; }
    const tp = (b.high + b.low + b.close) / 3; pv += tp * b.volume; v += b.volume; tpSum += tp; n++;
    out.push(v > 0 ? pv / v : tpSum / n);
  }
  return out;
}
function highest(vals, len, offset = 0) {
  return vals.map((_, i) => { const a = i - offset - len + 1, b = i - offset; if (a < 0) return null; let m = -Infinity; for (let k = a; k <= b; k++) m = Math.max(m, vals[k]); return m; });
}
function lowest(vals, len, offset = 0) {
  return vals.map((_, i) => { const a = i - offset - len + 1, b = i - offset; if (a < 0) return null; let m = Infinity; for (let k = a; k <= b; k++) m = Math.min(m, vals[k]); return m; });
}
// ADX (Wilder, 14): trend strength. Below 20 = sideways market.
function adx(c, len = 14) {
  const n = c.length, pdm = new Array(n).fill(null), mdm = new Array(n).fill(null), tr = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const up = c[i].high - c[i - 1].high, dn = c[i - 1].low - c[i].low;
    pdm[i] = up > dn && up > 0 ? up : 0; mdm[i] = dn > up && dn > 0 ? dn : 0;
    tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  }
  const sp = rma(pdm, len), sm = rma(mdm, len), st = rma(tr, len);
  const plusDI = c.map((_, i) => (st[i] ? (100 * sp[i]) / st[i] : null)), minusDI = c.map((_, i) => (st[i] ? (100 * sm[i]) / st[i] : null));
  const dx = c.map((_, i) => (plusDI[i] == null ? null : plusDI[i] + minusDI[i] ? (100 * Math.abs(plusDI[i] - minusDI[i])) / (plusDI[i] + minusDI[i]) : 0));
  return { adx: rma(dx, len), plusDI, minusDI };
}

function indicators(c, cfg) {
  const closes = c.map((b) => b.close), highs = c.map((b) => b.high), lows = c.map((b) => b.low);
  const { st, dir, atr } = supertrend(c, cfg.stMult, cfg.stLen);
  // MACD 12, 26, 9
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const macd = closes.map((_, i) => (e12[i] == null || e26[i] == null ? null : e12[i] - e26[i]));
  const firstM = macd.findIndex((v) => v != null);
  const sigPart = firstM < 0 ? [] : ema(macd.slice(firstM), 9);
  const macdSig = closes.map((_, i) => (i < firstM || firstM < 0 ? null : sigPart[i - firstM]));
  const macdHist = macd.map((v, i) => (v == null || macdSig[i] == null ? null : v - macdSig[i]));
  // Stochastic 14, 3, 3 (CM Stochastic style)
  const hh14 = highest(highs, 14), ll14 = lowest(lows, 14);
  const rawK = closes.map((v, i) => (hh14[i] == null || hh14[i] === ll14[i] ? null : ((v - ll14[i]) / (hh14[i] - ll14[i])) * 100));
  const smooth = (arr, n) => arr.map((_, i) => { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) { if (arr[k] == null) return null; s += arr[k]; } return s / n; });
  const stochK = smooth(rawK, 3), stochD = smooth(stochK, 3);
  // Donchian 20 (previous 20 candles) and its trend
  const dcHi = highest(highs, 20, 1), dcLo = lowest(lows, 20, 1);
  const dcTrend = []; let tr = 0;
  for (let i = 0; i < c.length; i++) { if (dcHi[i] != null && closes[i] > dcHi[i]) tr = 1; else if (dcLo[i] != null && closes[i] < dcLo[i]) tr = -1; dcTrend.push(tr); }
  // Chandelier Exit 22, 3
  const trs = c.map((b, i) => (i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - c[i - 1].close), Math.abs(b.low - c[i - 1].close))));
  const atr22 = rma(trs, 22), hh22 = highest(highs, 22), ll22 = lowest(lows, 22);
  const chLong = c.map((_, i) => (atr22[i] == null || hh22[i] == null ? null : hh22[i] - 3 * atr22[i]));
  const chShort = c.map((_, i) => (atr22[i] == null || ll22[i] == null ? null : ll22[i] + 3 * atr22[i]));
  const A = adx(c, 14);
  return { st, dir, atr, adx: A.adx, plusDI: A.plusDI, minusDI: A.minusDI, ema50: ema(closes, 50), emaF: ema(closes, cfg.fast), emaS: ema(closes, cfg.slow), vw: vwap(c), rsi: rsi(closes, cfg.rsiLen), volAvg: sma(c.map((b) => b.volume), cfg.volLen),
    sma10: sma(closes, 10), sma20: sma(closes, 20), sma44: sma(closes, 44), ema200: ema(closes, 200),
    macd, macdSig, macdHist, stochK, stochD, dcHi, dcLo, dcTrend, chLong, chShort };
}

const DEFAULT_CFG = { stLen: 10, stMult: 3, fast: 9, slow: 21, rsiLen: 14, rsiBuy: 55, rsiSell: 45, volMult: 1.5, volLen: 20, need: 5,
  t1R: 1, t2R: 2, trail: true, adxMin: 0, confirm: false, startMin: 9 * 60 + 30, lastEntryMin: 14 * 60 + 45, squareOffMin: 15 * 60 + 15 };

function rulesAt(c, ind, i, cfg, noVolume) {
  const b = c[i];
  const ok = (x) => x != null;
  if (![ind.dir[i], ind.emaF[i], ind.emaS[i], ind.rsi[i]].every(ok)) return { up: 0, dn: 0, detail: null };
  // volume spike on this candle or one of the 2 before it
  let vol = noVolume;
  for (let k = Math.max(0, i - 2); !vol && k <= i; k++) vol = ind.volAvg[k] != null && c[k].volume > ind.volAvg[k] * cfg.volMult;
  const up = [ind.dir[i] < 0, ind.emaF[i] > ind.emaS[i], b.close > ind.vw[i], ind.rsi[i] > cfg.rsiBuy, vol];
  const dn = [ind.dir[i] > 0, ind.emaF[i] < ind.emaS[i], b.close < ind.vw[i], ind.rsi[i] < cfg.rsiSell, vol];
  return { up: up.filter(Boolean).length, dn: dn.filter(Boolean).length,
    detail: { st: ind.dir[i] < 0 ? 'up' : 'down', emaF: ind.emaF[i], emaS: ind.emaS[i], vwap: ind.vw[i], rsi: ind.rsi[i], volX: ind.volAvg[i] ? b.volume / ind.volAvg[i] : null } };
}

// Run the trade rules over today's closed candles. Returns events in time order.
function runRules(c, ind, cfg, noVolume, day) {
  const r2 = (x) => Math.round(x * 100) / 100;
  const events = []; let pos = 0, entry, sl, t1, t2, t1Done = false, entryIdx = -1, prevUp = 0, prevDn = 0, pending = 0, pendingIdx = -1;
  for (let i = 0; i < c.length; i++) {
    const t = ist(c[i].time);
    const rules = rulesAt(c, ind, i, cfg, noVolume);
    if (t.day !== day) { prevUp = rules.up; prevDn = rules.dn; continue; }
    const closeMin = t.min + (c[1] ? Math.round((c[1].time - c[0].time) / 60) : 5);
    const pastSq = closeMin >= cfg.squareOffMin;
    // exits
    if (pos !== 0 && i > entryIdx) {
      const b = c[i];
      const hitT1 = pos === 1 ? b.high >= t1 : b.low <= t1, hitT2 = pos === 1 ? b.high >= t2 : b.low <= t2, hitSL = pos === 1 ? b.low <= sl : b.high >= sl;
      const flip = pos === 1 ? ind.dir[i] > 0 : ind.dir[i] < 0;
      let why = null, px = b.close;
      if (hitSL) { why = !t1Done ? 'Stop-loss hit' : (pos === 1 ? sl > entry : sl < entry) ? 'Trailing stop (Chandelier)' : 'Stop at entry'; px = sl; }
      else if (hitT2) { why = 'Target 2 hit'; px = t2; }
      else if (flip) why = 'Supertrend flipped';
      else if (pastSq) why = 'Square-off time';
      if (!why && !t1Done && hitT1) {
        t1Done = true;
        events.push({ time: c[i].time, event: 'T1', entry, sl: cfg.trail ? entry : sl, t1, t2, price: b.close, note: 'Book 50%' + (cfg.trail ? ', move SL to entry' : '') });
        if (cfg.trail) sl = entry;
      }
      // after Target 1 the stop trails with the Chandelier Exit (never loosens)
      if (t1Done && !why && cfg.trail) {
        const ch = pos === 1 ? ind.chLong[i] : ind.chShort[i];
        if (ch != null && (pos === 1 ? ch > sl : ch < sl)) sl = r2(ch);
      }
      if (why) {
        const pts = r2((px - entry) * pos);
        events.push({ time: c[i].time, event: 'EXIT', entry, sl, t1, t2, price: r2(px), note: `${why} | ${pts >= 0 ? '+' : ''}${pts} pts` });
        pos = 0; t1Done = false;
      }
    }
    // entries
    const canEnter = pos === 0 && t.min >= cfg.startMin && t.min <= cfg.lastEntryMin && !pastSq;
    let side = 0;
    const fresh = rules.up >= cfg.need && prevUp < cfg.need ? 1 : rules.dn >= cfg.need && prevDn < cfg.need ? -1 : 0;
    if (cfg.confirm) {
      // wait for the NEXT candle to close in the same direction (and the rules to still hold) before entering
      if (pending && i === pendingIdx + 1) {
        const ps = pending, still = ps === 1 ? rules.up >= cfg.need : rules.dn >= cfg.need;
        if (canEnter && still && ps * (c[i].close - c[i - 1].close) > 0 && ps * (c[i].close - c[i].open) > 0) side = ps;
        pending = 0;
      }
      if (!side && fresh && pos === 0) { pending = fresh; pendingIdx = i; }
    } else if (canEnter) side = fresh;
    // avoid sideways markets: no entry while ADX is below the minimum
    if (side && cfg.adxMin > 0 && !(ind.adx && ind.adx[i] != null && ind.adx[i] >= cfg.adxMin)) side = 0;
    if (side) {
      const b = c[i];
      let s = ind.st[i];
      if (side === 1 && (s == null || s >= b.close)) s = b.close - ind.atr[i];
      if (side === -1 && (s == null || s <= b.close)) s = b.close + ind.atr[i];
      const risk = Math.abs(b.close - s);
      pos = side; entry = r2(b.close); sl = r2(s); t1 = r2(entry + side * risk * cfg.t1R); t2 = r2(entry + side * risk * cfg.t2R); t1Done = false; entryIdx = i;
      events.push({ time: b.time, event: side === 1 ? 'BUY' : 'SELL', entry, sl, t1, t2, price: entry, note: cfg.confirm ? 'Confirmed by next candle' : '', rules: Object.assign({}, rules.detail, { adx: ind.adx ? ind.adx[i] : null }) });
    }
    prevUp = rules.up; prevDn = rules.dn;
  }
  return events;
}

// Full analysis for one symbol: closed candles only.
function analyse(data, intervalSec, cfg, sym) {
  const now = Math.floor(Date.now() / 1000);
  const closed = data.candles.filter((b) => b.time + intervalSec <= now);
  const ind = indicators(closed, cfg);
  const day = closed.length ? ist(closed[closed.length - 1].time).day : todayIST();
  const noVol = isIndex(sym) || closed.slice(-30).every((b) => !b.volume);
  const events = runRules(closed, ind, cfg, noVol, day);
  const last = closed.length - 1;
  const rules = last >= 0 ? rulesAt(closed, ind, last, cfg, noVol) : { up: 0, dn: 0 };
  return { closed, ind, events, rules, day, noVol };
}

module.exports = { adx, yahooSymbol, isIndex, ist, todayIST, nowMinIST, fetchCandles, indicators, analyse, DEFAULT_CFG, sma, ema, rsi };
