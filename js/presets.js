// Defaults for predictor sets, display labels and answer scales. The public
// repo ships these empty. A survey's own settings go in a project file
// (JSON) loaded in step 1, which stays on the user's computer:
//
// {
//   "name": "My survey",
//   "presets": [
//     { "name": "Standard controls", "note": "Reference groups: ...", "weight": "Weight",
//       "predictors": [ { "col": "age", "label": "Age", "kind": "number" },
//                       { "col": "party", "label": "Party", "kind": "category" } ] },
//     { "name": "Standard controls + attitudes", "extends": "Standard controls",
//       "predictors": [ { "col": "trust", "label": "Trust", "kind": "number" } ] }
//   ],
//   "default": "Standard controls",       (set applied when a survey loads)
//   "baseline": "Standard controls",      (set that fitted models are compared with)
//   "labels": { "age": "Age" },
//   "scales": { "support_solar": { "low": "very unfavorable", "high": "very favorable" } }
// }
window.SPEER_PRESETS = [];
window.SPEER_LABELS = {};
window.SPEER_SCALES = {};
