"""Compares SPEER's JavaScript TreeSHAP with the Python shap package.

The trees fitted by js/boost.js are handed to shap.TreeExplainer in shap's
custom tree format, and shap's SHAP values, interaction values and expected
value are compared with those computed in JavaScript.

Run from the repo root:
    node tests/export_model.js
    pip install shap numpy
    python tests/validate_against_shap.py
"""
import json
import os

import numpy as np
import shap

here = os.path.dirname(os.path.abspath(__file__))
d = json.load(open(os.path.join(here, "js_model.json")))
m = d["model"]

trees = []
for t in m["trees"]:
    left, right = np.array(t["left"]), np.array(t["right"])
    trees.append({
        "children_left": left, "children_right": right, "children_default": left.copy(),
        "features": np.array(t["feature"]), "thresholds": np.array(t["threshold"], float),
        "values": np.array(t["value"], float).reshape(-1, 1),
        "node_sample_weight": np.array(t["cover"], float),
    })
model = {"trees": trees, "base_offset": m["base"], "tree_output": "raw_value", "objective": "squared_error",
         "input_dtype": np.float64, "internal_dtype": np.float64}

explainer = shap.TreeExplainer(model, feature_perturbation="tree_path_dependent")
X = np.array(d["rows"], float)
sv = explainer.shap_values(X)
iv = explainer.shap_interaction_values(X)

e_shap = float(np.abs(sv - np.array(d["phi"])).max())
e_int = float(np.abs(iv - np.array(d["inter"])).max())
e_base = float(abs(np.ravel(explainer.expected_value)[0] - d["base"]))
print(f"shap {shap.__version__}")
print(f"largest SHAP value difference:        {e_shap:.2e}")
print(f"largest interaction value difference: {e_int:.2e}")
print(f"expected value difference:            {e_base:.2e}")
ok = max(e_shap, e_int, e_base) < 1e-9
print("PASS" if ok else "FAIL")
raise SystemExit(0 if ok else 1)
