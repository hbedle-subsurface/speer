// Gradient-boosted regression trees (squared-error loss) for SPEER's SHAP tab.
// Splits use second-order gain with L2 leaf regularization, in the manner of
// XGBoost (Chen and Guestrin, 2016), on features pre-binned to at most 64 bins.
// Each node stores its cover (the sum of training weights reaching it), which
// TreeSHAP needs. Pure functions, no dependencies; runs in the browser or Node.
//
// Tree layout (arrays indexed by node, root = 0):
//   left, right   child node indices, -1 for a leaf
//   feature       split feature index (-1 for a leaf)
//   threshold     rows with x[feature] <= threshold go left
//   value         leaf output (already multiplied by the learning rate)
//   cover         sum of sample weights of training rows at the node

const Boost = (() => {

  // small seeded generator (mulberry32) so fits are reproducible
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // bin each feature: distinct values if there are few, else weighted-free quantiles
  function makeBins(X, maxBins) {
    const M = X[0].length;
    return Array.from({ length: M }, (_, j) => {
      const vals = X.map(r => r[j]).sort((a, b) => a - b);
      const distinct = [...new Set(vals)];
      let uppers;
      if (distinct.length <= maxBins) uppers = distinct;
      else {
        const u = [];
        for (let b = 1; b <= maxBins; b++) u.push(vals[Math.min(vals.length - 1, Math.floor(b * vals.length / maxBins) - 1)]);
        uppers = [...new Set(u)];
        if (uppers[uppers.length - 1] !== distinct[distinct.length - 1]) uppers.push(distinct[distinct.length - 1]);
      }
      return uppers; // bin b holds values <= uppers[b] and > uppers[b-1]
    });
  }

  function binIndex(uppers, v) {
    let lo = 0, hi = uppers.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (v <= uppers[mid]) hi = mid; else lo = mid + 1; }
    return lo;
  }

  function predictTree(t, x) {
    let n = 0;
    while (t.left[n] !== -1) n = x[t.feature[n]] <= t.threshold[n] ? t.left[n] : t.right[n];
    return t.value[n];
  }

  function predict(model, x) {
    let s = model.base;
    for (const t of model.trees) s += predictTree(t, x);
    return s;
  }

  // X: rows of numbers (no missing), y: targets, w: sample weights (or null)
  // opts: nTrees, depth, lr, lambda, minChildWeight, subsample, seed, onProgress(fraction)
  async function fit(X, y, w, opts = {}) {
    const o = { nTrees: 300, depth: 3, lr: 0.05, lambda: 1, minChildWeight: 5, subsample: 0.8, seed: 1, maxBins: 64, ...opts };
    const n = X.length, M = X[0].length, rand = rng(o.seed);
    const wt = w ? w.slice() : new Array(n).fill(1);
    const bins = makeBins(X, o.maxBins);
    const B = X.map(r => r.map((v, j) => binIndex(bins[j], v)));
    const sw = wt.reduce((s, v) => s + v, 0);
    const base = y.reduce((s, v, i) => s + wt[i] * v, 0) / sw;
    const pred = new Array(n).fill(base);
    const trees = [];

    for (let m = 0; m < o.nTrees; m++) {
      const g = pred.map((p, i) => wt[i] * (p - y[i])), h = wt;
      let rows = [];
      for (let i = 0; i < n; i++) if (o.subsample >= 1 || rand() < o.subsample) rows.push(i);
      if (!rows.length) rows = [...Array(n).keys()];
      const t = { left: [], right: [], feature: [], threshold: [], value: [], cover: [] };
      const grow = (idx, d) => {
        const id = t.left.length;
        t.left.push(-1); t.right.push(-1); t.feature.push(-1); t.threshold.push(0); t.value.push(0);
        let G = 0, H = 0;
        for (const i of idx) { G += g[i]; H += h[i]; }
        t.cover.push(H);
        let best = null;
        if (d < o.depth && H >= 2 * o.minChildWeight) {
          const parent = G * G / (H + o.lambda);
          for (let j = 0; j < M; j++) {
            const nb = bins[j].length; if (nb < 2) continue;
            const Gb = new Float64Array(nb), Hb = new Float64Array(nb);
            for (const i of idx) { Gb[B[i][j]] += g[i]; Hb[B[i][j]] += h[i]; }
            let GL = 0, HL = 0;
            for (let b = 0; b < nb - 1; b++) {
              GL += Gb[b]; HL += Hb[b];
              const GR = G - GL, HR = H - HL;
              if (HL < o.minChildWeight || HR < o.minChildWeight) continue;
              const gain = GL * GL / (HL + o.lambda) + GR * GR / (HR + o.lambda) - parent;
              if (gain > 1e-12 && (!best || gain > best.gain)) best = { gain, j, b };
            }
          }
        }
        if (!best) { t.value[id] = -o.lr * G / (H + o.lambda); return id; }
        t.feature[id] = best.j; t.threshold[id] = bins[best.j][best.b];
        const L = [], R = [];
        for (const i of idx) (B[i][best.j] <= best.b ? L : R).push(i);
        t.left[id] = grow(L, d + 1);
        t.right[id] = grow(R, d + 1);
        return id;
      };
      grow(rows, 0);
      // covers for TreeSHAP describe the full training sample, not just this tree's subsample
      recover(t, X, wt);
      trees.push(t);
      for (let i = 0; i < n; i++) pred[i] += predictTree(t, X[i]);
      if (o.onProgress && m % 10 === 9) await o.onProgress((m + 1) / o.nTrees);
    }
    return { base, trees, nFeatures: M, opts: o };
  }

  function recover(t, X, w) {
    t.cover.fill(0);
    X.forEach((x, i) => {
      let n = 0; t.cover[0] += w[i];
      while (t.left[n] !== -1) { n = x[t.feature[n]] <= t.threshold[n] ? t.left[n] : t.right[n]; t.cover[n] += w[i]; }
    });
  }

  function r2(model, X, y, w) {
    const wt = w || new Array(X.length).fill(1), sw = wt.reduce((s, v) => s + v, 0);
    const m = y.reduce((s, v, i) => s + wt[i] * v, 0) / sw;
    let sse = 0, sst = 0;
    X.forEach((x, i) => { sse += wt[i] * (y[i] - predict(model, x)) ** 2; sst += wt[i] * (y[i] - m) ** 2; });
    return 1 - sse / sst;
  }

  return { fit, predict, predictTree, r2, rng };
})();

if (typeof module !== 'undefined') module.exports = Boost;
