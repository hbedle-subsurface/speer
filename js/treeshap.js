// Path-dependent TreeSHAP (Lundberg, Erion and Lee, 2018; Lundberg et al., 2020),
// ported from the reference algorithm in the shap package. For an ensemble
// {base, trees} from boost.js it returns exact Shapley values of the model's
// prediction for one row, with node covers standing in for the data
// distribution (shap's feature_perturbation="tree_path_dependent"), and
// SHAP interaction values by conditioning on each feature in turn.
// Split rule matches boost.js: x[feature] <= threshold goes left.

const TreeShap = (() => {

  function extendPath(P, d, zeroFrac, oneFrac, feat) {
    P.feat[d] = feat; P.zero[d] = zeroFrac; P.one[d] = oneFrac;
    P.pw[d] = d === 0 ? 1 : 0;
    for (let i = d - 1; i >= 0; i--) {
      P.pw[i + 1] += oneFrac * P.pw[i] * (i + 1) / (d + 1);
      P.pw[i] = zeroFrac * P.pw[i] * (d - i) / (d + 1);
    }
  }

  function unwindPath(P, d, k) {
    const one = P.one[k], zero = P.zero[k];
    let next = P.pw[d];
    for (let i = d - 1; i >= 0; i--) {
      if (one !== 0) {
        const tmp = P.pw[i];
        P.pw[i] = next * (d + 1) / ((i + 1) * one);
        next = tmp - P.pw[i] * zero * (d - i) / (d + 1);
      } else {
        P.pw[i] = P.pw[i] * (d + 1) / (zero * (d - i));
      }
    }
    for (let i = k; i < d; i++) { P.feat[i] = P.feat[i + 1]; P.zero[i] = P.zero[i + 1]; P.one[i] = P.one[i + 1]; }
  }

  function unwoundSum(P, d, k) {
    const one = P.one[k], zero = P.zero[k];
    let next = P.pw[d], total = 0;
    for (let i = d - 1; i >= 0; i--) {
      if (one !== 0) {
        const tmp = next * (d + 1) / ((i + 1) * one);
        total += tmp;
        next = P.pw[i] - tmp * zero * (d - i) / (d + 1);
      } else {
        total += (P.pw[i] / zero) / ((d - i) / (d + 1));
      }
    }
    return total;
  }

  const copy = P => ({ feat: P.feat.slice(), zero: P.zero.slice(), one: P.one.slice(), pw: P.pw.slice() });

  function recurse(t, x, phi, node, d, parent, pZero, pOne, pFeat, cond, condFeat, condFrac) {
    if (condFrac === 0) return;
    const P = copy(parent);
    if (cond === 0 || condFeat !== pFeat) extendPath(P, d, pZero, pOne, pFeat);
    const split = t.feature[node];
    if (t.left[node] === -1) {
      for (let i = 1; i <= d; i++) {
        const w = unwoundSum(P, d, i);
        phi[P.feat[i]] += w * (P.one[i] - P.zero[i]) * t.value[node] * condFrac;
      }
      return;
    }
    const L = t.left[node], R = t.right[node];
    const hot = x[split] <= t.threshold[node] ? L : R, cold = hot === L ? R : L;
    const cover = t.cover[node];
    const hotZero = t.cover[hot] / cover, coldZero = t.cover[cold] / cover;
    let inZero = 1, inOne = 1;
    let k = 0;
    while (k <= d) { if (P.feat[k] === split) break; k++; }
    if (k !== d + 1) { inZero = P.zero[k]; inOne = P.one[k]; unwindPath(P, d, k); d -= 1; }
    let hotCond = condFrac, coldCond = condFrac;
    if (cond > 0 && split === condFeat) { coldCond = 0; d -= 1; }
    else if (cond < 0 && split === condFeat) { hotCond *= hotZero; coldCond *= coldZero; d -= 1; }
    recurse(t, x, phi, hot, d + 1, P, hotZero * inZero, inOne, split, cond, condFeat, hotCond);
    recurse(t, x, phi, cold, d + 1, P, coldZero * inZero, 0, split, cond, condFeat, coldCond);
  }

  function emptyPath(maxLen) {
    return { feat: new Array(maxLen).fill(-1), zero: new Array(maxLen).fill(0), one: new Array(maxLen).fill(0), pw: new Array(maxLen).fill(0) };
  }

  function treeDepth(t, n = 0) { return t.left[n] === -1 ? 0 : 1 + Math.max(treeDepth(t, t.left[n]), treeDepth(t, t.right[n])); }

  // expected value of one tree under its covers
  function expected(t, n = 0) {
    if (t.left[n] === -1) return t.value[n];
    return (t.cover[t.left[n]] * expected(t, t.left[n]) + t.cover[t.right[n]] * expected(t, t.right[n])) / t.cover[n];
  }

  // SHAP values for one row: returns { phi: [M], base }
  // cond/condFeat: 0 for ordinary values; +1/-1 fix feature condFeat as present/absent
  function shapRow(model, x, cond = 0, condFeat = -1) {
    const M = model.nFeatures, phi = new Array(M + 1).fill(0);
    if (!model._depth) model._depth = Math.max(...model.trees.map(t => treeDepth(t)));
    const len = model._depth + 2;
    for (const t of model.trees) recurse(t, x, phi, 0, 0, emptyPath(len), 1, 1, -1, cond, condFeat, 1);
    if (model._base == null) model._base = model.base + model.trees.reduce((s, t) => s + expected(t), 0);
    return { phi: phi.slice(0, M), base: model._base };
  }

  // SHAP interaction values for one row: M x M matrix whose rows sum to phi
  function interactionRow(model, x) {
    const M = model.nFeatures, main = shapRow(model, x).phi;
    const I = Array.from({ length: M }, () => new Array(M).fill(0));
    for (let j = 0; j < M; j++) {
      const on = shapRow(model, x, 1, j).phi, off = shapRow(model, x, -1, j).phi;
      for (let k = 0; k < M; k++) I[j][k] = (on[k] - off[k]) / 2;
      let off_ = 0;
      for (let k = 0; k < M; k++) if (k !== j) off_ += I[j][k];
      I[j][j] = main[j] - off_;
    }
    return I;
  }

  return { shapRow, interactionRow };
})();

if (typeof module !== 'undefined') module.exports = TreeShap;
