// Fits weighted linear and logistic models with js/stats.js on simulated data
// and writes data and results to tests/js_regression.json for
// tests/validate_regression.py.
const fs = require('fs'), path = require('path');
const Stats = require('../js/stats.js');
let a = 12345; const rand = () => { a = (a * 16807) % 2147483647; return (a - 1) / 2147483646; };
const norm = () => Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand());
const n = 800, X = [], y = [], yb = [], w = [], cl = [];
for (let i = 0; i < n; i++) {
  const x1 = norm(), x2 = rand() < 0.4 ? 1 : 0, x3 = Math.floor(rand() * 5);
  X.push([1, x1, x2, x3]);
  y.push(1 + 0.5 * x1 - 0.3 * x2 + 0.1 * x3 + norm() * (1 + x2));
  yb.push(0.2 + 0.8 * x1 - 0.5 * x2 + (Math.log(rand()) - Math.log(rand())) > 0 ? 1 : 0);
  w.push(0.5 + 1.5 * rand()); cl.push(Math.floor(rand() * 60));
}
const out = { X, y, yb, w, cl, ols: {}, logit: {} };
for (const se of ['classical', 'hc1', 'hc3', 'cluster']) {
  const r = Stats.ols(X, y, w, { se, clusters: cl });
  out.ols[se] = { beta: r.beta, se: r.se, r2: r.r2 };
  const l = Stats.logit(X, yb, w, { se, clusters: cl });
  out.logit[se] = { beta: l.beta, se: l.se };
}
out.logit.hc3_unweighted = { se: Stats.logit(X, yb, null, { se: 'hc3' }).se };
fs.writeFileSync(path.join(__dirname, 'js_regression.json'), JSON.stringify(out));
console.log('wrote tests/js_regression.json');
