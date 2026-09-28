// SPEER statistics: weighted least squares, weighted logistic regression,
// heteroskedasticity-robust (HC1) and county-clustered standard errors,
// p-values, and Moran's I on county mean residuals.
// No external dependencies. Matrices are arrays of row arrays.

const Stats = (() => {

  // ---------- small linear algebra ----------
  function zeros(r, c) { return Array.from({ length: r }, () => new Array(c).fill(0)); }

  function invert(A) {
    const n = A.length;
    const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
    const scale = Math.max(1e-300, ...A.map((r, i) => Math.abs(r[i])));
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      if (Math.abs(M[piv][col]) < 1e-10 * scale) return null; // singular: collinear predictors
      [M[col], M[piv]] = [M[piv], M[col]];
      const p = M[col][col];
      for (let j = 0; j < 2 * n; j++) M[col][j] /= p;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col];
        if (f === 0) continue;
        for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[col][j];
      }
    }
    return M.map(row => row.slice(n));
  }

  function matVec(A, v) { return A.map(row => row.reduce((s, a, j) => s + a * v[j], 0)); }

  // X'WX with per-row weight vector w
  function xtwx(X, w) {
    const k = X[0].length, out = zeros(k, k);
    for (let i = 0; i < X.length; i++) {
      const xi = X[i], wi = w[i];
      for (let a = 0; a < k; a++) {
        const va = wi * xi[a];
        if (va === 0) continue;
        for (let b = a; b < k; b++) out[a][b] += va * xi[b];
      }
    }
    for (let a = 0; a < k; a++) for (let b = 0; b < a; b++) out[a][b] = out[b][a];
    return out;
  }

  function xtwy(X, w, y) {
    const k = X[0].length, out = new Array(k).fill(0);
    for (let i = 0; i < X.length; i++) for (let a = 0; a < k; a++) out[a] += w[i] * X[i][a] * y[i];
    return out;
  }

  // Sandwich covariance: bread * meat * bread.
  // score_i = w_i * e_i * x_i ; clusters (optional) sum scores within cluster.
  function sandwich(X, w, e, bread, clusters, isLogit) {
    const n = X.length, k = X[0].length;
    const meat = zeros(k, k);
    let G = n;
    if (clusters) {
      const sums = new Map();
      for (let i = 0; i < n; i++) {
        let s = sums.get(clusters[i]);
        if (!s) { s = new Array(k).fill(0); sums.set(clusters[i], s); }
        const f = w[i] * e[i];
        for (let a = 0; a < k; a++) s[a] += f * X[i][a];
      }
      G = sums.size;
      for (const s of sums.values())
        for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) meat[a][b] += s[a] * s[b];
    } else {
      for (let i = 0; i < n; i++) {
        const f = w[i] * e[i];
        for (let a = 0; a < k; a++) {
          const fa = f * X[i][a];
          for (let b = 0; b < k; b++) meat[a][b] += fa * f * X[i][b];
        }
      }
    }
    // small-sample corrections (Stata-style)
    const c = clusters ? (G / (G - 1)) * (isLogit ? 1 : (n - 1) / (n - k))
      : (isLogit ? n / (n - 1) : n / (n - k));
    const BM = bread.map(row => meat[0].map((_, j) => row.reduce((s, v, t) => s + v * meat[t][j], 0)));
    const V = BM.map(row => bread[0].map((_, j) => row.reduce((s, v, t) => s + v * bread[t][j], 0)));
    return { V: V.map(r => r.map(v => v * c)), G };
  }

  // HC3: scores divided by (1 - leverage). glmW (logit) supplies p(1-p) for the leverage.
  function hc3(X, w, e, bread, glmW) {
    const n = X.length, k = X[0].length, meat = zeros(k, k);
    for (let i = 0; i < n; i++) {
      const xi = X[i], Bx = matVec(bread, xi);
      const h = w[i] * (glmW ? glmW[i] : 1) * xi.reduce((s, v, a) => s + v * Bx[a], 0);
      const f = w[i] * e[i] / Math.max(1 - h, 1e-8);
      for (let a = 0; a < k; a++) { const fa = f * xi[a]; for (let b = 0; b < k; b++) meat[a][b] += fa * f * xi[b]; }
    }
    const BM = bread.map(row => meat[0].map((_, j) => row.reduce((s, v, t) => s + v * meat[t][j], 0)));
    return BM.map(row => bread[0].map((_, j) => row.reduce((s, v, t) => s + v * bread[t][j], 0)));
  }

  // symmetric eigenvalues by cyclic Jacobi rotation
  function eigSym(A) {
    const n = A.length, M = A.map(r => r.slice());
    for (let sweep = 0; sweep < 100; sweep++) {
      let off = 0;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += M[p][q] ** 2;
      if (off < 1e-22) break;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
        if (Math.abs(M[p][q]) < 1e-300) continue;
        const th = (M[q][q] - M[p][p]) / (2 * M[p][q]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1), sn = t * c;
        for (let r = 0; r < n; r++) { const a = M[r][p], b = M[r][q]; M[r][p] = c * a - sn * b; M[r][q] = sn * a + c * b; }
        for (let r = 0; r < n; r++) { const a = M[p][r], b = M[q][r]; M[p][r] = c * a - sn * b; M[q][r] = sn * a + c * b; }
      }
    }
    return M.map((r, i) => r[i]);
  }

  // variance inflation factors (unweighted, as statsmodels) and condition number of X with its constant
  function collinearity(X) {
    const k = X[0].length, ones = new Array(X.length).fill(1), vif = [];
    for (let j = 1; j < k; j++) {
      const others = X.map(r => r.filter((_, c) => c !== j));
      const yj = X.map(r => r[j]);
      const B = invert(xtwx(others, ones));
      if (!B) { vif.push(Infinity); continue; }
      const b = matVec(B, xtwy(others, ones, yj));
      const m = yj.reduce((s, v) => s + v, 0) / yj.length;
      let sse = 0, sst = 0;
      others.forEach((r, i) => { const f = r.reduce((s, v, c) => s + v * b[c], 0); sse += (yj[i] - f) ** 2; sst += (yj[i] - m) ** 2; });
      vif.push(sst > 0 ? 1 / Math.max(sse / sst, 1e-12) : Infinity);
    }
    const ev = eigSym(xtwx(X, ones)).map(v => Math.max(v, 0));
    const cond = Math.sqrt(Math.max(...ev) / Math.max(Math.min(...ev), 1e-300));
    return { vif, cond };
  }

  // linear prediction x'b with its standard error sqrt(x'Vx)
  function predict(x, beta, V) {
    const eta = x.reduce((s, v, i) => s + v * beta[i], 0);
    const Vx = matVec(V, x);
    return { eta, se: Math.sqrt(Math.max(0, x.reduce((s, v, i) => s + v * Vx[i], 0))) };
  }

  // ---------- distributions ----------
  function logGamma(x) {
    const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
      -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x, tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (let j = 0; j < 6; j++) ser += g[j] / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  }

  function betacf(a, b, x) {
    const MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
    let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d; let h = d;
    for (let m = 1; m <= MAXIT; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; const del = d * c; h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }

  function ibeta(x, a, b) {
    if (x <= 0) return 0; if (x >= 1) return 1;
    const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
  }

  // two-sided p for Student t
  function pT(t, df) {
    if (!isFinite(t)) return NaN;
    return ibeta(df / (df + t * t), df / 2, 0.5);
  }

  // upper-tail p for an F statistic with d1, d2 degrees of freedom
  function pF(F, d1, d2) {
    if (!(F > 0)) return 1;
    return ibeta(d2 / (d2 + d1 * F), d2 / 2, d1 / 2);
  }

  function erfc(x) {
    const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
    const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
      t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
      t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? r : 2 - r;
  }
  function pZ(z) { return erfc(Math.abs(z) / Math.SQRT2); }

  // two-sided 95% critical value: Student t (df) or normal (df null)
  function crit95(df) {
    if (!df) return 1.959964;
    let lo = 0, hi = 50;
    for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (pT(m, df) > 0.05) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }
  function ciFrom(beta, se, df) {
    const c = crit95(df);
    return beta.map((b, i) => [b - c * se[i], b + c * se[i]]);
  }

  // ---------- models ----------
  // weights are normalized to mean 1 so they act as relative survey weights
  function normWeights(w, n) {
    if (!w) return new Array(n).fill(1);
    const m = w.reduce((s, v) => s + v, 0) / n;
    return w.map(v => v / m);
  }

  // opts: { se: 'hc1' | 'hc3' | 'cluster' | 'classical', clusters: [...] }
  function ols(X, y, wRaw, opts = {}) {
    const se_ = opts.se || 'hc1', clusters = se_ === 'cluster' ? opts.clusters : null, classical = se_ === 'classical';
    const n = X.length, k = X[0].length;
    if (n <= k) return { error: `Only ${n} complete rows for ${k} coefficients.` };
    const w = normWeights(wRaw, n);
    const bread = invert(xtwx(X, w));
    if (!bread) return { error: 'The predictors are collinear (one is an exact combination of others). Remove a predictor or a category.' };
    const beta = matVec(bread, xtwy(X, w, y));
    const fitted = X.map(r => r.reduce((s, v, j) => s + v * beta[j], 0));
    const resid = y.map((v, i) => v - fitted[i]);
    const sw = w.reduce((s, v) => s + v, 0);
    const ybar = y.reduce((s, v, i) => s + w[i] * v, 0) / sw;
    const sst = y.reduce((s, v, i) => s + w[i] * (v - ybar) ** 2, 0);
    const sse = resid.reduce((s, v, i) => s + w[i] * v * v, 0);
    let V, G = null;
    if (classical) {
      const s2 = resid.reduce((s, e, i) => s + w[i] * e * e, 0) / (n - k);
      V = bread.map(r => r.map(v => v * s2));
    } else if (se_ === 'hc3') {
      V = hc3(X, w, resid, bread, null);
    } else ({ V, G } = sandwich(X, w, resid, bread, clusters));
    const df = (clusters && !classical) ? G - 1 : n - k;
    const se = V.map((r, i) => Math.sqrt(Math.max(r[i], 0)));
    const stat = beta.map((b, i) => b / se[i]);
    return {
      kind: 'ols', n, k, beta, se, stat, df,
      p: stat.map(t => pT(t, df)),
      fitted, resid, r2: 1 - sse / sst,
      adjR2: 1 - (sse / (n - k)) / (sst / (n - 1)),
      rmse: Math.sqrt(sse / sw), clusters: clusters ? G : null, seKind: se_, V, w,
      ci: ciFrom(beta, se, df),
    };
  }

  function logit(X, y, wRaw, opts = {}) {
    const se_ = opts.se || 'hc1', clusters = se_ === 'cluster' ? opts.clusters : null, classical = se_ === 'classical';
    const n = X.length, k = X[0].length;
    if (n <= k) return { error: `Only ${n} complete rows for ${k} coefficients.` };
    const w = normWeights(wRaw, n);
    let beta = new Array(k).fill(0), p = new Array(n).fill(0.5), ll = -Infinity, bread = null, converged = false;
    for (let iter = 0; iter < 60; iter++) {
      const eta = X.map(r => r.reduce((s, v, j) => s + v * beta[j], 0));
      p = eta.map(e => 1 / (1 + Math.exp(-e)));
      const W = p.map((pi, i) => w[i] * Math.max(pi * (1 - pi), 1e-12));
      bread = invert(xtwx(X, W));
      if (!bread) return { error: 'The predictors are collinear, or one predictor separates the outcome perfectly. Remove a predictor or a category.' };
      const grad = new Array(k).fill(0);
      for (let i = 0; i < n; i++) for (let a = 0; a < k; a++) grad[a] += w[i] * (y[i] - p[i]) * X[i][a];
      const step = matVec(bread, grad);
      beta = beta.map((b, j) => b + step[j]);
      const newLL = y.reduce((s, yi, i) => {
        const e = X[i].reduce((t, v, j) => t + v * beta[j], 0);
        return s + w[i] * (yi * e - Math.log1p(Math.exp(e)));
      }, 0);
      if (Math.abs(newLL - ll) < 1e-9 * (1 + Math.abs(newLL))) { ll = newLL; converged = true; break; }
      ll = newLL;
    }
    const eta = X.map(r => r.reduce((s, v, j) => s + v * beta[j], 0));
    p = eta.map(e => 1 / (1 + Math.exp(-e)));
    bread = invert(xtwx(X, p.map((pi, i) => w[i] * Math.max(pi * (1 - pi), 1e-12))));
    const resid = y.map((v, i) => v - p[i]);
    let V, G = null;
    if (classical) V = bread;
    else if (se_ === 'hc3') V = hc3(X, w, resid, bread, p.map(pi => pi * (1 - pi)));
    else ({ V, G } = sandwich(X, w, resid, bread, clusters, true));
    const se = V.map((r, i) => Math.sqrt(Math.max(r[i], 0)));
    const stat = beta.map((b, i) => b / se[i]);
    const sw = w.reduce((s, v) => s + v, 0);
    const pbar = y.reduce((s, v, i) => s + w[i] * v, 0) / sw;
    const ll0 = sw * (pbar * Math.log(pbar) + (1 - pbar) * Math.log(1 - pbar));
    return {
      kind: 'logit', n, k, beta, se, stat, df: null,
      p: stat.map(pZ), fitted: p, resid,
      pseudoR2: 1 - ll / ll0, converged, clusters: clusters ? G : null, seKind: se_, V, w,
      ci: ciFrom(beta, se, null),
    };
  }

  // ---------- spatial ----------
  // values: Map fips -> value ; neighbors: Map fips -> [fips]
  function moransI(values, neighbors, nPerm = 999) {
    const ids = [...values.keys()].filter(id => (neighbors.get(id) || []).some(nb => values.has(nb)));
    const n = ids.length;
    if (n < 8) return { error: `Only ${n} counties with data have a neighboring county with data.` };
    const idx = new Map(ids.map((id, i) => [id, i]));
    const nb = ids.map(id => (neighbors.get(id) || []).filter(x => idx.has(x)).map(x => idx.get(x)));
    const x = ids.map(id => values.get(id));
    const I = (vals) => {
      const m = vals.reduce((s, v) => s + v, 0) / n;
      const z = vals.map(v => v - m);
      const den = z.reduce((s, v) => s + v * v, 0);
      let num = 0;
      for (let i = 0; i < n; i++) {
        const lag = nb[i].reduce((s, j) => s + z[j], 0) / nb[i].length; // row-standardized
        num += z[i] * lag;
      }
      return num / den; // sum of row-standardized weights = n
    };
    const obs = I(x);
    let ge = 0;
    const perm = x.slice();
    for (let r = 0; r < nPerm; r++) {
      for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
      if (I(perm) >= obs) ge++;
    }
    const excluded = values.size - n;
    return { I: obs, expected: -1 / (n - 1), p: (ge + 1) / (nPerm + 1), n, excluded, nPerm };
  }

  return { ols, logit, moransI, pT, pZ, pF, invert, collinearity, predict, crit95 };
})();

if (typeof module !== 'undefined') module.exports = Stats;
