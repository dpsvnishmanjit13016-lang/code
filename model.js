// SwingPulse learning model
// Predicts the chance a trade ends in PROFIT AFTER CHARGES, using machine learning + probability theory:
//  • Three candidate models: logistic regression, gradient-boosted decision trees, and an ensemble (average of both).
//  • Each is trained on older days and judged on the newest days it never saw (walk-forward validation).
//  • Isotonic regression calibrates the probabilities, so "70%" really means about 70% on unseen days.
//  • The candidate with the best calibrated Brier score on unseen days is used automatically.
//  • The cut-off is the lowest win chance (60% or more) whose picks really won 60%+ on unseen days.
// It learns from about a month of simulated trades on every scanned stock and from every one of its own
// finished recommendations, so its mistakes become training data.

const ST = require('./strategies');
const FEATURES = ['rules', 'rsi', 'rvol', 'atr', 'move', 'vwapDist', 'emaGap', 'time', 'risk', 'stTrend'].concat(ST.EXTRA_NAMES);
const clip = (x, a, b) => Math.max(a, Math.min(b, x));

// Build the feature vector for a decision at candle i (side: 1 = BUY, -1 = SELL)
function features(c, ind, i, side, rules, rvol, prevClose, riskPct, minOfDay, extra) {
  const b = c[i], px = b.close;
  return [
    rules / 5,
    clip((side * (ind.rsi[i] - 50)) / 50, -1, 1),
    clip((rvol || 1) / 4, 0, 1),
    clip(((ind.atr[i] || 0) / px) * 100, 0, 1),
    clip((side * (prevClose ? (px - prevClose) / prevClose * 100 : 0)) / 3, -1, 1),
    clip((side * ((px - ind.vw[i]) / px) * 100) / 2, -1, 1),
    clip(side * ((ind.emaF[i] - ind.emaS[i]) / px) * 100, -1, 1),
    clip((minOfDay - 570) / 300, 0, 1),
    clip(riskPct / 2, 0, 1),
    side * (ind.dir[i] < 0 ? 1 : -1)
  ].concat(extra || new Array(ST.EXTRA_NAMES.length).fill(0));
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const logit = (p) => Math.log(p / (1 - p));
function predictRaw(w, x) { let z = w[0]; for (let k = 0; k < x.length; k++) z += w[k + 1] * x[k]; return sigmoid(z); }

// ---------- 1) logistic regression ----------
function fit(samples, epochs = 400, lr = 0.5, l2 = 0.002) {
  const d = FEATURES.length; const w = new Array(d + 1).fill(0);
  if (!samples.length) return w;
  const tw = samples.reduce((a, s) => a + (s.w || 1), 0);
  for (let e = 0; e < epochs; e++) {
    const g = new Array(d + 1).fill(0);
    for (const s of samples) {
      const err = (predictRaw(w, s.x) - s.y) * (s.w || 1);
      g[0] += err; for (let k = 0; k < d; k++) g[k + 1] += err * s.x[k];
    }
    for (let k = 0; k <= d; k++) w[k] -= lr * (g[k] / tw + (k ? l2 * w[k] : 0));
  }
  return w;
}

// ---------- 2) gradient-boosted decision trees (log-loss, histogram splits) ----------
const GB = { depth: 3, eta: 0.08, lambda: 2, minLeaf: 40, subsample: 0.8, maxRounds: 220 };
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function makeEdges(X, f, maxBins = 32) {
  const v = X.map((x) => x[f]).sort((a, b) => a - b), e = [];
  for (let q = 1; q < maxBins; q++) { const t = v[Math.floor((q / maxBins) * (v.length - 1))]; if (!e.length || t > e[e.length - 1]) e.push(t); }
  return e;
}
function binOf(v, e) { let lo = 0, hi = e.length; while (lo < hi) { const m = (lo + hi) >> 1; if (v <= e[m]) hi = m; else lo = m + 1; } return lo; }
function treeOut(node, x) { while (node.f !== undefined) node = x[node.f] <= node.t ? node.l : node.r; return node.v; }
function gbPredictZ(gb, x) { let z = gb.base; for (const t of gb.trees) z += treeOut(t, x); return z; }
// Train boosted trees. If `val` is given, returns the validation log-loss after every round (for early stopping).
function gbFit(train, rounds, val, seed = 7) {
  const d = FEATURES.length, n = train.length, X = train.map((s) => s.x), y = train.map((s) => s.y), w = train.map((s) => s.w || 1);
  const edges = [], B = [];
  for (let f = 0; f < d; f++) { edges.push(makeEdges(X, f)); B.push(Uint8Array.from(X.map((x) => binOf(x[f], edges[f])))); }
  const tw = w.reduce((a, b) => a + b, 0), mean = Math.min(0.98, Math.max(0.02, w.reduce((a, v, i) => a + v * y[i], 0) / tw));
  const base = logit(mean), F = new Float64Array(n).fill(base), g = new Float64Array(n), h = new Float64Array(n);
  const vF = val ? new Float64Array(val.length).fill(base) : null, vLoss = [], trees = [], gain = new Array(d).fill(0), rand = rng(seed);
  function build(rows, depth) {
    let G = 0, H = 0, W = 0; for (const i of rows) { G += g[i]; H += h[i]; W += w[i]; }
    const leaf = { v: (-G / (H + GB.lambda)) * GB.eta };
    if (depth >= GB.depth || W < 2 * GB.minLeaf) return leaf;
    const parent = (G * G) / (H + GB.lambda);
    let best = null;
    for (let f = 0; f < d; f++) {
      const nb = edges[f].length + 1, hg = new Float64Array(nb), hh = new Float64Array(nb), hw = new Float64Array(nb), bf = B[f];
      for (const i of rows) { const b = bf[i]; hg[b] += g[i]; hh[b] += h[i]; hw[b] += w[i]; }
      let GL = 0, HL = 0, WL = 0;
      for (let k = 0; k < nb - 1; k++) {
        GL += hg[k]; HL += hh[k]; WL += hw[k];
        const WR = W - WL; if (WL < GB.minLeaf || WR < GB.minLeaf) continue;
        const GR = G - GL, HR = H - HL;
        const gn = (GL * GL) / (HL + GB.lambda) + (GR * GR) / (HR + GB.lambda) - parent;
        if (!best || gn > best.gain) best = { f, k, gain: gn };
      }
    }
    if (!best || best.gain <= 1e-9) return leaf;
    gain[best.f] += best.gain;
    const L = [], R = []; const bf = B[best.f]; for (const i of rows) (bf[i] <= best.k ? L : R).push(i);
    return { f: best.f, t: edges[best.f][best.k], k: best.k, l: build(L, depth + 1), r: build(R, depth + 1) };
  }
  const outBin = (node, i) => { while (node.f !== undefined) node = B[node.f][i] <= node.k ? node.l : node.r; return node.v; };
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < n; i++) { const p = sigmoid(F[i]); g[i] = (p - y[i]) * w[i]; h[i] = Math.max(1e-6, p * (1 - p)) * w[i]; }
    const rows = []; for (let i = 0; i < n; i++) if (rand() < GB.subsample) rows.push(i);
    const tree = build(rows, 0); trees.push(tree);
    for (let i = 0; i < n; i++) F[i] += outBin(tree, i);
    if (val) {
      let L = 0, Wv = 0;
      for (let j = 0; j < val.length; j++) { vF[j] += treeOut(tree, val[j].x); const p = Math.min(1 - 1e-6, Math.max(1e-6, sigmoid(vF[j]))), wv = val[j].w || 1; L -= wv * (val[j].y ? Math.log(p) : Math.log(1 - p)); Wv += wv; }
      vLoss.push(L / Wv);
    }
  }
  const strip = (nd) => (nd.f === undefined ? { v: Math.round(nd.v * 1e6) / 1e6 } : { f: nd.f, t: nd.t, l: strip(nd.l), r: strip(nd.r) });
  return { base, trees: trees.map(strip), vLoss, gain };
}

// ---------- 3) isotonic calibration (pool-adjacent-violators) ----------
function isoFit(p, y, w) {
  const idx = p.map((_, i) => i).sort((a, b) => p[a] - p[b]);
  const blocks = [];
  for (const i of idx) {
    blocks.push({ sw: w[i], swy: w[i] * y[i], swp: w[i] * p[i] });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
      if (a.swy / a.sw <= b.swy / b.sw) break;
      a.sw += b.sw; a.swy += b.swy; a.swp += b.swp; blocks.pop();
    }
  }
  return { x: blocks.map((b) => b.swp / b.sw), y: blocks.map((b) => Math.min(0.995, Math.max(0.005, b.swy / b.sw))) };
}
function isoApply(iso, v) {
  if (!iso || !iso.x || !iso.x.length) return v;
  const { x, y } = iso; if (v <= x[0]) return y[0]; if (v >= x[x.length - 1]) return y[y.length - 1];
  let lo = 0, hi = x.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (x[m] <= v) lo = m; else hi = m; }
  const t = (v - x[lo]) / (x[hi] - x[lo] || 1); return y[lo] + t * (y[hi] - y[lo]);
}

// ---------- probability helpers ----------
const brier = (p, list) => { let s = 0, W = 0; list.forEach((q, i) => { const w = q.w || 1; s += w * (p[i] - q.y) ** 2; W += w; }); return W ? s / W : null; };
// Wilson lower bound: the win rate we can be ~95% sure is at least this high, given `wins` out of `n`
function wilsonLow(wins, n, z = 1.96) { if (!n) return 0; const ph = wins / n, d = 1 + (z * z) / n; return (ph + (z * z) / (2 * n) - z * Math.sqrt((ph * (1 - ph) + (z * z) / (4 * n)) / n)) / d; }

function rawPredict(m, x) {
  if (!m) return null;
  const pl = m.w && m.w.length === x.length + 1 ? predictRaw(m.w, x) : null;
  const pg = m.gb ? sigmoid(gbPredictZ(m.gb, x)) : null;
  if (m.type === 'boosted') return pg;
  if (m.type === 'ensemble') return pl == null || pg == null ? (pl ?? pg) : (pl + pg) / 2;
  return pl;
}

// Train all candidates on older days, judge them on the newest `holdDays`, calibrate, pick the best, then refit on everything.
function train(samples, holdDays = 5) {
  const days = [...new Set(samples.map((s) => s.day))].sort();
  const testDays = new Set(days.slice(-holdDays));
  const trainSet = samples.filter((s) => !testDays.has(s.day)), testSet = samples.filter((s) => testDays.has(s.day));
  const enough = trainSet.length >= 300 && testSet.length >= 60;
  // wins / losses in multiples of risk, for expected-profit maths
  const winsS = samples.filter((s) => s.y === 1 && s.r != null), lossS = samples.filter((s) => s.y === 0 && s.r != null);
  const avgWinR = winsS.length ? winsS.reduce((a, s) => a + s.r, 0) / winsS.length : 1.25;
  const avgLossR = lossS.length ? -lossS.reduce((a, s) => a + s.r, 0) / lossS.length : 1;
  const baseRate = testSet.length ? Math.round((testSet.filter((s) => s.y === 1).length / testSet.length) * 100) : null;
  const live = samples.filter((s) => s.live);
  const common = { avgWinR: Math.round(avgWinR * 100) / 100, avgLossR: Math.round(avgLossR * 100) / 100, baseRate, trainedOn: samples.length,
    liveSamples: live.length, liveWins: live.filter((s) => s.y === 1).length, days: days.length, testDays: [...testDays], at: new Date().toISOString() };

  if (!enough) { // too little data for a fair contest: plain logistic regression
    const w = fit(samples);
    return Object.assign({ type: 'logistic', w, cutoff: 0.6, check: null, verified: false, candidates: [], weights: Object.fromEntries(FEATURES.map((f, k) => [f, Math.round(w[k + 1] * 100) / 100])) }, common);
  }
  // logistic on older days
  const w0 = fit(trainSet);
  // boosted trees: early stopping on the last 2 older days, then refit on all older days
  const trDays = [...new Set(trainSet.map((s) => s.day))].sort(), esDays = new Set(trDays.slice(-2));
  const inner = trainSet.filter((s) => !esDays.has(s.day)), es = trainSet.filter((s) => esDays.has(s.day));
  let rounds = 80;
  if (inner.length >= 200 && es.length >= 40) { const t = gbFit(inner, GB.maxRounds, es); rounds = Math.max(10, t.vLoss.indexOf(Math.min(...t.vLoss)) + 1); }
  const gb0 = gbFit(trainSet, rounds);
  // predictions on the unseen days
  const cand = {
    logistic: testSet.map((s) => predictRaw(w0, s.x)),
    boosted: testSet.map((s) => sigmoid(gbPredictZ(gb0, s.x)))
  };
  cand.ensemble = cand.logistic.map((p, i) => (p + cand.boosted[i]) / 2);
  // honest calibration: fit on half the unseen days, apply to the other half (and swap)
  const tDays = [...testDays].sort(), half = new Set(tDays.filter((_, i) => i % 2 === 0));
  const idxA = [], idxB = []; testSet.forEach((s, i) => (half.has(s.day) ? idxA : idxB).push(i));
  const crossCal = (p) => {
    const out = p.slice();
    for (const [fitIdx, useIdx] of [[idxA, idxB], [idxB, idxA]]) {
      if (fitIdx.length < 20) continue;
      const iso = isoFit(fitIdx.map((i) => p[i]), fitIdx.map((i) => testSet[i].y), fitIdx.map((i) => testSet[i].w || 1));
      for (const i of useIdx) out[i] = isoApply(iso, p[i]);
    }
    return out;
  };
  const candidates = Object.entries(cand).map(([name, p]) => {
    const pc = crossCal(p);
    return { name, brier: Math.round(brier(p, testSet) * 10000) / 10000, brierCal: Math.round(brier(pc, testSet) * 10000) / 10000, pCal: pc };
  });
  const naive = Math.round(brier(testSet.map(() => testSet.filter((s) => s.y === 1).length / testSet.length), testSet) * 10000) / 10000;
  candidates.sort((a, b) => a.brierCal - b.brierCal);
  const best = candidates[0];
  // cut-off: lowest calibrated win chance (>= 60%) whose picks really won >= 60% on unseen days
  let cutoff = 0.6, check = null;
  for (let c = 0.6; c <= 0.9; c += 0.025) {
    const sel = testSet.filter((_, i) => best.pCal[i] >= c);
    if (sel.length < 15) break;
    const wins = sel.filter((s) => s.y === 1).length, rate = wins / sel.length;
    check = { cutoff: Math.round(c * 1000) / 1000, n: sel.length, wins, rate: Math.round(rate * 100), low: Math.round(wilsonLow(wins, sel.length) * 100) };
    cutoff = c;
    if (rate >= 0.6) break;
  }
  // final model: refit on all data, calibrate with the unseen-day predictions
  const iso = isoFit(cand[best.name], testSet.map((s) => s.y), testSet.map((s) => s.w || 1));
  const m = { type: best.name, cutoff: Math.round(cutoff * 1000) / 1000, check, verified: !!(check && check.rate >= 60), iso };
  if (best.name !== 'boosted') m.w = fit(samples);
  let gbAll = null;
  if (best.name !== 'logistic') { gbAll = gbFit(samples, rounds); m.gb = { base: gbAll.base, trees: gbAll.trees }; }
  const imp = gbAll ? gbAll.gain : gb0.gain, tot = imp.reduce((a, b) => a + b, 0) || 1;
  m.importance = FEATURES.map((f, k) => [f, Math.round((imp[k] / tot) * 1000) / 10]).sort((a, b) => b[1] - a[1]).slice(0, 6);
  m.candidates = candidates.map(({ name, brier: b, brierCal }) => ({ name, brier: b, brierCal })); m.naiveBrier = naive; m.rounds = rounds;
  if (m.w) m.weights = Object.fromEntries(FEATURES.map((f, k) => [f, Math.round(m.w[k + 1] * 100) / 100]));
  return Object.assign(m, common);
}

// Calibrated probability that a trade with features x makes money after charges
function predict(model, x) {
  if (!model || !Array.isArray(x) || x.length !== FEATURES.length) return null;
  const p = rawPredict(model, x);
  if (p == null || !isFinite(p)) return null;
  return model.iso ? isoApply(model.iso, p) : p;
}

// Lessons saved by v23 and earlier had 24 inputs; v24 adds the 'Supertrend confirmed reversal' flag and ADX.
// Insert neutral values so old lessons keep teaching the model.
function upgradeX(x) {
  if (!Array.isArray(x)) return x;
  if (x.length === FEATURES.length - 2) { const y = x.slice(); y.splice(19, 0, 0); y.push(0); return y; }
  return x;
}

module.exports = { upgradeX, FEATURES, features, train, predict, wilsonLow, _t: { fit, gbFit, isoFit, isoApply, gbPredictZ, brier } };
