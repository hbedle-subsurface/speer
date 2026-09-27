"""Compares SPEER's weighted regression code (js/stats.js) with statsmodels.

Linear models are compared with statsmodels WLS, logistic models with a
binomial GLM using the survey weights (rescaled to mean 1) as var_weights.
Classical, HC1, HC3 and county-clustered standard errors are checked
(logistic HC3 without weights, against the standard HC3 formula written out
in numpy, since statsmodels' GLM results do not apply the leverage
adjustment for HC3). The
logistic HC1 and cluster corrections follow Stata's logit conventions, so
those two are compared after rescaling statsmodels' uncorrected versions.

Run from the repo root:
    node tests/export_regression.js
    pip install statsmodels numpy
    python tests/validate_regression.py
"""
import json
import os

import warnings

import numpy as np
import statsmodels.api as sm

warnings.filterwarnings("ignore")

here = os.path.dirname(os.path.abspath(__file__))
d = json.load(open(os.path.join(here, "js_regression.json")))
X, y, yb, w, cl = (np.array(d[k], float) for k in ("X", "y", "yb", "w", "cl"))
n, k = X.shape
G = len(np.unique(cl))
worst = 0.0

def check(label, a, b):
    global worst
    e = float(np.max(np.abs(np.array(a) - np.array(b))))
    worst = max(worst, e)
    print(f"{label:<28}{e:.2e}")

wls = sm.WLS(y, X, weights=w)
check("OLS coefficients", d["ols"]["classical"]["beta"], wls.fit().params)
check("OLS classical SE", d["ols"]["classical"]["se"], wls.fit().bse)
check("OLS HC1 SE", d["ols"]["hc1"]["se"], wls.fit(cov_type="HC1").bse)
check("OLS HC3 SE", d["ols"]["hc3"]["se"], wls.fit(cov_type="HC3").bse)
check("OLS clustered SE", d["ols"]["cluster"]["se"], wls.fit(cov_type="cluster", cov_kwds={"groups": cl}).bse)
check("OLS R2", [d["ols"]["classical"]["r2"]], [wls.fit().rsquared])

glm = sm.GLM(yb, X, family=sm.families.Binomial(), var_weights=w / w.mean())
check("Logit coefficients", d["logit"]["classical"]["beta"], glm.fit().params)
check("Logit classical SE", d["logit"]["classical"]["se"], glm.fit().bse)
hc0 = glm.fit(cov_type="HC0").bse
check("Logit HC1 SE (n/(n-1))", d["logit"]["hc1"]["se"], hc0 * np.sqrt(n / (n - 1)))
# statsmodels' GLM results do not apply the leverage adjustment for HC3, so the
# logistic HC3 check uses the standard formula directly: scores divided by
# (1 - h), with h the diagonal of the GLM hat matrix
fit1 = sm.GLM(yb, X, family=sm.families.Binomial()).fit()
p = fit1.fittedvalues
Wd = p * (1 - p)
B = np.linalg.inv(X.T @ (Wd[:, None] * X))
h = Wd * np.einsum("ij,jk,ik->i", X, B, X)
sc = ((yb - p) / (1 - h))[:, None] * X
hc3 = np.sqrt(np.diag(B @ (sc.T @ sc) @ B))
check("Logit HC3 SE (unweighted)", d["logit"]["hc3_unweighted"]["se"], hc3)
clu = glm.fit(cov_type="cluster", cov_kwds={"groups": cl.astype(int), "use_correction": False}).bse
check("Logit clustered SE", d["logit"]["cluster"]["se"], clu * np.sqrt(G / (G - 1)))
print("PASS" if worst < 1e-6 else "FAIL")
raise SystemExit(0 if worst < 1e-6 else 1)
