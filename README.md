# SPEER

SPEER is a browser tool for survey data with respondent locations. It fits a regression of a survey answer on respondent characteristics, averages the residuals by US county, maps them, and compares the county residuals with each county's weather and disaster record.

It was built for work on public views of energy (solar, wind and other sources) in a national survey, with socioeconomic predictors at the respondent level and weather exposure over the preceding years at the county level.

The survey file, its codebook and any project settings are read by the browser tab and never leave the computer. None of them belong in this repository: it holds only the tool, public county data and synthetic test data.

## Workflow in the tool

1. **Load the survey.** Drag in a CSV or Excel file (first sheet) with one row per respondent. A computed column (A minus B, A plus B, A times B, A mean-centered or A standardized) can be added in the browser, for example the difference between two related items. Codes such as 98 or 99 (refused, don't know) can be listed so they are treated as missing. Blank cells, `NA`, `.` and SPSS's `#NULL!` are always missing.
2. **Place respondents in counties.** Choose a ZIP code column or a county FIPS column. ZIP codes are matched through `data/zip_county.csv`, which ships with the repo. An optional state column is checked against each placement. Respondent locations are only ever used at the county level; the tool has no option to place people by coordinates.
3. **County weather record.** `data/county_weather.csv` loads automatically. Any CSV with a `fips` column and numeric county variables can be loaded in its place.
4. **Fit the respondent model.** Choose the outcome and predictors. A predictor set fills in a standard list of predictors, with display labels and the survey weight, in one step. Sets come from a project settings file loaded in step 1 (see Project files), and any set of ticked predictors can also be saved in the browser (column names only). A set loads automatically when the survey file contains most of its columns, or the set named as the default in the project settings loads first.

   A baseline set can be chosen for comparison (the project settings can name one). When the current predictors include all of the baseline's, the baseline is refitted on exactly the same respondents, and the Model tab reports the R² of both models (McFadden pseudo R² for logistic models), the change, and a joint Wald test that the added terms are all zero, using the current model's covariance matrix (so it follows the chosen standard errors). The test matches statsmodels' `wald_test` on the same models. Results appear as a coefficient table with 95% confidence intervals and a bar chart of t values colored by p-value band, and the table can be downloaded as CSV. Each predictor is entered either as a number (one slope) or as a category (one coefficient per answer, compared with the most common answer). Survey weights are optional.

The map opens on a smoothed residual surface that fills in unsampled counties (see Smoothing below). It can also show the raw weighted mean residual in each county that has at least the chosen number of respondents. The color range is set with a slider and does not rescale when the minimum count changes, so the same color means the same residual throughout a session. The map can also show respondent counts or any weather variable.

Below the map, a short reading of the current view is written from the model and the map settings: what red and blue mean for the chosen outcome (using the answer labels from the codebook or project settings, where they are loaded), how large the color range is relative to the answer scale, how the smoothing works at the current distance, how many respondents the colored counties draw on, and notes when the settings make the map easy to over-read (a low minimum, a very long or very short smoothing distance). The legend is labeled "lower than predicted" and "higher than predicted", and the Moran's I result is followed by a plain statement of what it means.

A second panel, "Average residual by state or region", plots the unsmoothed weighted mean residual for each state, Census division or Census region with a 95% interval (the standard error of a weighted mean), in the map's colors. Groups below a minimum number of respondents (default 20) are left out and listed. This view shows which parts of the map pattern rest on enough respondents to stand apart from zero.

The lower right panel plots county mean residuals against one weather variable and fits a county-level regression on all ticked weather variables, weighted by the number of respondents in each county.

## Project files

A survey's own details are kept out of this repository and loaded in step 1 from files on the user's computer. There are two kinds, and either or both can be dropped in at once:

- **Codebook (CSV)** with the columns `column, question, block, text, item, options`, one row per data column, options written as `1=Label; 2=Label`. It ties each column to the question as it was asked.
- **Project settings (JSON)** with predictor sets, display labels for columns, and words for the low and high ends of answer scales. The format is described at the top of `js/presets.js`, which ships empty.

With "Remember in this browser" ticked, the files are kept in that browser's local storage so they reload with the page; "Forget" removes them. They are never sent anywhere. `.gitignore` excludes spreadsheet files, codebook CSVs and project JSON files so they are not committed by accident from a local copy of the repo (uploads through the github.com web page do not check `.gitignore`).

With a codebook loaded:

- **Questions tab.** Every question, searchable and grouped by survey block, with its full wording, answer options and the weighted distribution of answers in the loaded file. From a question, it can be made the outcome, added as a predictor, sent to the group comparison, or added as a SHAP candidate.
- **Outcome.** The question wording and the answer scale appear under the outcome in step 4 and in the Model tab.
- **Map reading.** The outcome's question text and the labels of the lowest and highest answers describe what red and blue mean.
- **Tooltips.** Hovering over a column name in the predictor, group and SHAP lists shows the question.
- **Group labels.** Choosing a grouping column fills in its answer labels.

Data files are often recoded after export, so a column's codes can differ from the questionnaire's. For each question the tool compares the values in the file with the codebook codes and, where they differ, says so and does not apply the answer labels. Columns with the suffixes `_d`, `_s`, `_r`, `_l` or `_c` that are not in the codebook point back to the question they come from.

## Analysis tabs

Below the map, the results are arranged in tabs.

- **Questions.** The codebook browser described above.
- **Model.** The outcome's distribution and summary statistics, the respondent model as a chart of t values or of coefficients with 95% intervals, colored by p-value band, the coefficient table, and collinearity diagnostics (variance inflation factors and the condition number, computed unweighted as in statsmodels).
- **Interaction.** Adds a moderator, a second variable (optionally mean-centered) and their product to the current model, lists the key terms, and plots the predicted outcome across the second variable for each level of the moderator (each category, 0 and 1 for a dummy, or the mean and ±1 SD for a continuous moderator), with the other predictors held at their weighted means and 95% intervals from the model's covariance matrix. For a logistic model the lines are predicted probabilities.
- **Group comparison.** The weighted percent of respondents at or above (or at or below) a cut-off on one or more items, by group, as clustered bars on a fixed 0–100% axis. Group labels such as `1=Democrat, 2=Independent, 3=Republican` can be typed in; party labels take blue, gray and red.
- **Correlations.** Pearson correlations among the outcome and the current predictors on complete rows.
- **SHAP.** A boosted tree model of the outcome, or of the respondent model's residuals, with SHAP values for each feature, SHAP interaction values for pairs of features, and a link from any pair to the Interaction tab for a regression test (see below).
- **County and weather.** County mean residuals against the county weather record.

## SHAP

SHAP (SHapley Additive exPlanations; Lundberg and Lee, 2017) divides a model's prediction for each respondent among the features that went into it, so that the contributions add up to the prediction. In SPEER, SHAP is used alongside the regression for two purposes: to look for factors the regression is missing, and to look for interactions worth testing. In both, SHAP points to candidates, and the regression tests them.

### Model and SHAP values

The SHAP tab fits gradient-boosted regression trees (Friedman, 2001) with squared-error loss. Splits are chosen by second-order gain with an L2 penalty on leaf values, as in XGBoost (Chen and Guestrin, 2016), on features binned to at most 64 values; the trees are written for SPEER (`js/boost.js`) and are not XGBoost itself. Settings are the number of trees (default 200), depth (3), learning rate (0.05), row subsample per tree (0.8), minimum child weight (10) and the L2 penalty (1). Survey weights, if used, are the sample weights in fitting. A random share of respondents (default 20%) is held out, and R² is reported on both the held-out and the training rows. Each run uses its own seed for the holdout split and the row subsampling, and the default of three runs shows how much the results move between fits.

SHAP values are computed with the path-dependent TreeSHAP algorithm (Lundberg, Erion and Lee, 2018; Lundberg et al., 2020), which gives exact Shapley values for tree ensembles using the share of training data reaching each node (`js/treeshap.js`). This is the default of `shap.TreeExplainer` for tree models without background data (`feature_perturbation="tree_path_dependent"`). Node shares are recomputed from the full training sample after each tree is grown. SHAP interaction values (Lundberg et al., 2020) are computed exactly for a random sample of respondents (default 300), since they take roughly twice the number of features as long as ordinary SHAP values.

### Displays

- **Mean absolute SHAP value** for each feature, averaged over runs, with whiskers for the range across runs, and colored by whether the feature is in the respondent model or is an added candidate.
- **SHAP values for each respondent** (the summary or beeswarm plot), colored by the respondent's value of the feature.
- **Dependence plot** of one feature's SHAP values against its values, colored by a second feature.
- **Interaction matrix** of mean absolute SHAP interaction values (off-diagonal entries doubled, since each pair's interaction is split between two cells), and the ten strongest pairs, each of which can be sent to the Interaction tab.

The SHAP axes in the summary and dependence plots share one fixed range per fit, so the spread of different features can be compared directly.

### Two targets

With the outcome as the target, the trees see the respondent-model predictors and any added candidates, and SHAP shows which features the tree model relies on. With the residuals of the fitted respondent model as the target, the trees see only what the regression left unexplained, so large SHAP values mark features, including county weather variables, that account for variation the regression does not.

### What SHAP does not show

- SHAP values describe the fitted tree model. They are not causal effects, and they describe the data only as well as the model fits it; a low holdout R² means the SHAP values describe a weak model.
- Correlated features share credit, and the division between them can change from fit to fit.
- SHAP values are in the units of the target and are not comparable one-for-one with regression coefficients. There are no standard errors or tests.
- A candidate missing factor or interaction found with SHAP is tested by adding it to the regression.

### Validation

`tests/validate_treeshap.js` checks the JavaScript TreeSHAP against exact Shapley values computed by enumerating every subset of features, and checks that SHAP values add up to the prediction and interaction values add up to SHAP values. `tests/validate_against_shap.py` hands the same trees to the Python `shap` package (version 0.52.0 at the time of writing) and compares SHAP values, interaction values and the expected value. In both, differences are at the level of floating-point rounding (below 10⁻¹⁴).

## Methods

**Models.** Linear outcomes are fitted by weighted least squares. Yes/no outcomes are fitted by weighted logistic regression (iteratively reweighted least squares), with the answers counted as yes chosen in the tool. Survey weights are rescaled to a mean of 1. Rows with a missing value in any selected column are dropped.

**Standard errors.** Robust (HC1) standard errors are the default. HC3 standard errors (MacKinnon and White, 1985) and classical (model-based) standard errors are also available; for linear models these match statsmodels `WLS(...).fit(cov_type='HC3')` and the default `WLS(...).fit()`. Clustering by county is also available, and is the appropriate choice when county weather variables are added to the respondent model, because every respondent in a county then shares the same weather values. Small-sample corrections follow Stata's conventions. These are checked against statsmodels by the scripts in `tests/` (see Tests).

**Residuals.** For the linear model the residual is observed minus fitted. For the logistic model it is the observed 0 or 1 minus the predicted probability. A positive county mean residual means respondents there scored higher on the outcome than their socioeconomic profile predicts.

**Two ways to bring in weather.** The first is two-stage: fit the socioeconomic model, then regress county mean residuals on weather variables. The second adds the weather variables directly to the respondent model as county-level predictors, with county-clustered standard errors. The two-stage approach shows the geography of what the socioeconomic model leaves unexplained. The one-stage approach gives weather coefficients that are adjusted for the socioeconomic predictors at the same time.

**Small counties.** Many counties hold only one or two respondents in a national sample, and their mean residuals are dominated by individual variation. The minimum-respondents slider removes them from the map, the Moran's I test and the county model.

**Smoothing.** Most counties hold no respondents, so the default map layer is a Gaussian kernel smooth. Each county's value is the survey-weighted mean of respondent residuals, with each respondent further weighted by exp(-d²/2h²), where d is the distance between the centroid of the respondent's county and the centroid of the county being filled, and h is the smoothing distance set with the slider (25 to 400 km; respondents beyond 3h are ignored). The kernel-weighted respondent count is reported for each county, and counties where it falls below the minimum are hatched. A short distance keeps local detail but leaves gaps; a long distance fills the map but blends neighboring regions together, so a pattern that persists across several distances is more robust than one that appears at only one. The smoothed values are for display. Moran's I and the county weather model use the raw county means, since smoothing creates spatial correlation by construction. The downloaded county table includes both.

**Spatial clustering.** Moran's I is computed on county mean residuals using row-standardized weights between counties that share a border, with a 999-permutation p-value. Counties with no qualifying neighbor are left out and counted. A significant positive I means counties with similar residuals are next to each other, a sign that something regional is missing from the respondent model.

## Tests

The statistical code is checked against reference implementations. From the repo root, with Node.js and Python installed:

```
node tests/validate_treeshap.js                 # TreeSHAP against brute-force Shapley values
node tests/export_model.js
python tests/validate_against_shap.py           # TreeSHAP against the shap package
node tests/export_regression.js
python tests/validate_regression.py             # regression against statsmodels
```

The regression check covers weighted linear models (coefficients, R², classical, HC1, HC3 and county-clustered standard errors, against statsmodels 0.15.0 WLS) and weighted logistic models (coefficients and classical, HC1 and clustered standard errors against a statsmodels binomial GLM, and HC3 against the standard formula).

## Building the county tables

### On GitHub

The repo includes a GitHub Actions workflow that builds the county weather table on GitHub's servers and commits it to `data/`. In the repo on github.com, open the **Actions** tab, choose **Build county weather table**, press **Run workflow**, adjust the years if needed (and give the last full month before fieldwork to build the perception-matched variables), and run it. The downloads from NOAA, FEMA and the Drought Monitor take a while. When the run finishes, `data/county_weather.csv` and `data/county_weather_dictionary.csv` are in the repo and the tool loads them. If a source is unavailable during the run, the table is written without it and the run log lists what is missing.

If the run fails at the commit step, the repository's workflow permissions are read-only; they are set under Settings, Actions, General, Workflow permissions ("Read and write permissions").

### On a computer

Both scripts use only the Python standard library.

```
python scripts/build_county_weather.py                  # 2014-2023 by default
python scripts/build_county_weather.py --start 2019 --end 2023
python scripts/build_county_weather.py --perc-end 2023-12 --perc-base-years 3   # with perception variables (example month)
```

`data/zip_county.csv` is already in the repo; `build_zip_county.py` rebuilds it (it needs `pip install pyreadr`). It combines the Census 2020 ZCTA-to-county relationship, the Census 2010 relationship file's population counts for each ZCTA-county piece, and the John Snow, Inc. ZIP-to-ZCTA crosswalk, using public copies of these files in the zctaCrosswalk (MarketBridge) and zcta (jjchern) repositories on GitHub. Each ZIP code is assigned to one county: a ZCTA inside one county goes to that county, and a ZCTA split between counties goes to the county holding the largest share of its 2010 population. PO box and single-business ZIP codes, which have no ZCTA, are assigned through the ZCTA that contains them. The file covers 41,063 ZIP codes. About 10,000 ZCTAs touch more than one county, though in most of them nearly all residents are in one; the tool reports how many respondents live in ZIPs where the assigned county holds less than 90% of the population.

`build_county_weather.py` writes `data/county_weather.csv` and `data/county_weather_dictionary.csv`, whose descriptions appear in the tool. Downloads are cached in `scripts/cache/`. The variables are:

| Prefix | Source | Variables |
|---|---|---|
| `se_` | NOAA Storm Events database | days with heat, cold, winter storm, tornado, hail and thunderstorm wind, flood, tropical, wildfire and drought events; deaths; damage in millions of nominal USD |
| `nc_` | NOAA nClimDiv county temperature | mean temperature anomaly relative to 1991–2020; months with unusually high maximum or low minimum temperature relative to the county's own 1991–2020 record; summer maximum and winter minimum temperature |
| `fema_` | OpenFEMA Disaster Declarations Summaries | declarations naming the county, all types and by incident type |
| `pc_` | nClimDiv, Storm Events, US Drought Monitor | the 12 months before the survey compared with the preceding years, for comparison with questions on perceived weather change (below) |

### Measured counterparts to perceived weather change

Some surveys ask whether kinds of weather happened more or less often around the respondent in the last twelve months than in the last few years. The `pc_` variables make the same comparison for each county: the 12 months ending at `--perc-end` (the last full month before fieldwork) against the mean of the `--perc-base-years` 12-month blocks before that (default 5). Every `pc_` variable is oriented so that a positive value means more of the event recently. They are built only when `--perc-end` is given (in the GitHub workflow, the "last full month" box).

| Perceived change in | Measured counterparts |
|---|---|
| Rain and floods | `pc_precip_pct` (percent change in 12-month precipitation), `pc_flood_days_more` (change in flood event-days) |
| Heat | `pc_tmax_warmer_f` (change in mean daily maximum temperature), `pc_heat_days_more` (change in heat event-days) |
| Cold and winter storms | `pc_winter_colder_f` (how much colder the December–February minimum was than in the baseline winters), `pc_coldwinter_days_more` (change in cold and winter storm event-days) |
| Drought | `pc_drought_area_more` (change in mean percent of county area in D1 or worse), `pc_drought_days_more` (change in drought event-days) |

A perception item can be chosen as the outcome and its measured counterparts added as county predictors with county-clustered standard errors, which tests how closely perception follows the measured record once the other predictors are held constant. Questions about the future have no measured counterpart.

## Sample file

`sample/synthetic_survey.csv` is an invented survey of 4,000 respondents with a `county_fips` column. It exists only to try the tool, and its answers do not describe any real population.

## Files

```
index.html, css/, js/          the tool: js/stats.js (regression, standard errors, Moran's I),
                               js/boost.js (boosted trees), js/treeshap.js (TreeSHAP),
                               js/presets.js (empty defaults; format for project settings), js/app.js (interface)
tests/                         validation scripts (see Tests)
data/counties-albers-10m.json  county outlines from us-atlas 3.0.1
data/zip_county.csv            ZIP code to county lookup (rebuilt by scripts/build_zip_county.py)
data/county_weather*.csv       built by scripts/build_county_weather.py
vendor/                        d3 7.9.0, topojson-client 3.1.0, Papa Parse 5.7.0, SheetJS 0.18.5, with licenses
```

## References

Chen, T., and Guestrin, C. (2016). XGBoost: A scalable tree boosting system. *Proceedings of the 22nd ACM SIGKDD International Conference on Knowledge Discovery and Data Mining*, 785–794.

Friedman, J. H. (2001). Greedy function approximation: A gradient boosting machine. *Annals of Statistics*, 29(5), 1189–1232.

Lundberg, S. M., Erion, G. G., and Lee, S.-I. (2018). Consistent individualized feature attribution for tree ensembles. arXiv:1802.03888.

Lundberg, S. M., Erion, G., Chen, H., DeGrave, A., Prutkin, J. M., Nair, B., Katz, R., Himmelfarb, J., Bansal, N., and Lee, S.-I. (2020). From local explanations to global understanding with explainable AI for trees. *Nature Machine Intelligence*, 2, 56–67.

Lundberg, S. M., and Lee, S.-I. (2017). A unified approach to interpreting model predictions. *Advances in Neural Information Processing Systems*, 30.

MacKinnon, J. G., and White, H. (1985). Some heteroskedasticity-consistent covariance matrix estimators with improved finite sample properties. *Journal of Econometrics*, 29(3), 305–325.

Moran, P. A. P. (1950). Notes on continuous stochastic phenomena. *Biometrika*, 37(1/2), 17–23.

## License and citation

SPEER is shared under the Creative Commons Attribution-ShareAlike 4.0 International license (CC BY-SA 4.0). Please cite it as:

Bedle, H. (2026). *SPEER: survey regression residuals by county.* University of Oklahoma. https://hbedle-subsurface.github.io/SPEER/

Contact: Heather Bedle, hbedle@ou.edu, ORCID 0000-0003-3010-0195.
