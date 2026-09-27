// Checks js/treeshap.js against exact Shapley values computed by brute force
// over all feature subsets, using the same path-dependent conditional
// expectation (node covers). Also checks that SHAP values add up to the
// prediction and that interaction rows add up to the SHAP values.
// Run: node tests/validate_treeshap.js
const Boost = require('../js/boost.js');
const TreeShap = require('../js/treeshap.js');

// conditional expectation of one tree given the features in S are known
function condExp(t, x, S, n = 0) {
  if (t.left[n] === -1) return t.value[n];
  const f = t.feature[n];
  if (S.has(f)) return condExp(t, x, S, x[f] <= t.threshold[n] ? t.left[n] : t.right[n]);
  return (t.cover[t.left[n]] * condExp(t, x, S, t.left[n]) + t.cover[t.right[n]] * condExp(t, x, S, t.right[n])) / t.cover[n];
}
const v = (model, x, S) => model.base + model.trees.reduce((s, t) => s + condExp(t, x, S), 0);
const fact = k => (k <= 1 ? 1 : k * fact(k - 1));

function bruteShap(model, x, M) {
  const phi = new Array(M).fill(0);
  for (let i = 0; i < M; i++) {
    const others = [...Array(M).keys()].filter(j => j !== i);
    for (let mask = 0; mask < 1 << others.length; mask++) {
      const S = new Set(others.filter((_, b) => mask & (1 << b)));
      const wgt = fact(S.size) * fact(M - S.size - 1) / fact(M);
      phi[i] += wgt * (v(model, x, new Set([...S, i])) - v(model, x, S));
    }
  }
  return phi;
}

(async () => {
  const rand = Boost.rng(42), n = 600, M = 5;
  const X = Array.from({ length: n }, () => [Math.floor(rand() * 6), rand() < 0.4 ? 1 : 0, rand() * 10, Math.floor(rand() * 3), rand()]);
  const y = X.map(r => 0.5 * r[0] - 1.2 * r[1] + 0.8 * r[1] * (r[2] > 5 ? 1 : 0) + 0.1 * r[2] + (rand() - 0.5));
  const w = X.map(() => 0.5 + rand());
  const model = await Boost.fit(X, y, w, { nTrees: 40, depth: 4, lr: 0.1, seed: 7 });
  let maxErr = 0, maxAdd = 0, maxInt = 0;
  for (let r = 0; r < 25; r++) {
    const x = X[r];
    const { phi, base } = TreeShap.shapRow(model, x);
    const bf = bruteShap(model, x, M);
    phi.forEach((p, i) => { maxErr = Math.max(maxErr, Math.abs(p - bf[i])); });
    maxAdd = Math.max(maxAdd, Math.abs(base + phi.reduce((s, p) => s + p, 0) - Boost.predict(model, x)));
    const I = TreeShap.interactionRow(model, x);
    I.forEach((row, i) => { maxInt = Math.max(maxInt, Math.abs(row.reduce((s, q) => s + q, 0) - phi[i])); });
  }
  console.log(`largest difference from brute-force Shapley values: ${maxErr.toExponential(2)}`);
  console.log(`largest additivity error (base + sum of SHAP minus prediction): ${maxAdd.toExponential(2)}`);
  console.log(`largest interaction row-sum error: ${maxInt.toExponential(2)}`);
  const ok = maxErr < 1e-9 && maxAdd < 1e-9 && maxInt < 1e-9;
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})();
