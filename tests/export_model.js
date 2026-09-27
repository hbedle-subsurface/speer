// Fits a small boosted model on simulated data with js/boost.js, computes SHAP
// values and interaction values with js/treeshap.js, and writes everything to
// tests/js_model.json for tests/validate_against_shap.py.
const fs = require('fs'), path = require('path');
const Boost = require('../js/boost.js'), TreeShap = require('../js/treeshap.js');
(async () => {
  const rand = Boost.rng(3), n = 500;
  const X = Array.from({ length: n }, () => [Math.floor(rand() * 6), rand() < 0.4 ? 1 : 0, rand() * 10, Math.floor(rand() * 3), rand(), rand() * 2]);
  const y = X.map(r => 0.5 * r[0] - 1.2 * r[1] + 0.8 * r[1] * (r[2] > 5 ? 1 : 0) + 0.1 * r[2] + (rand() - 0.5));
  const w = X.map(() => 0.5 + rand());
  const model = await Boost.fit(X, y, w, { nTrees: 60, depth: 4, lr: 0.1, seed: 5 });
  const rows = X.slice(0, 30);
  const out = { model, rows, phi: rows.map(x => TreeShap.shapRow(model, x).phi), inter: rows.map(x => TreeShap.interactionRow(model, x)), base: TreeShap.shapRow(model, rows[0]).base };
  fs.writeFileSync(path.join(__dirname, 'js_model.json'), JSON.stringify(out));
  console.log('wrote tests/js_model.json');
})();
