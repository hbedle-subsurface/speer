# SPEER

SPEER is a browser tool for survey data with respondent locations. It fits a regression of a survey answer on respondent characteristics, averages the residuals by US county, maps them, and compares the county residuals with each county's weather and disaster record.

It was built for work on energy preferences and acceptance (solar, wind and other sources) in the 2024 SPEER survey (collected August 16 to October 16, 2024), with socioeconomic predictors at the respondent level and weather exposure over the preceding ten years (2014–2023) at the county level.

The survey file is read by the browser tab and never leaves the computer. No survey data should be committed to this repository.

## Workflow in the tool

1. **Load the survey.** Drag in a CSV with one row per respondent. Codes such as 98 or 99 (refused, don't know) can be listed so they are treated as missing. Blank cells, `NA`, `.` and SPSS's `#NULL!` are always missing.
2. **Place respondents in counties.** Choose a ZIP code column or a county FIPS column. ZIP codes are matched through `data/zip_county.csv`, which ships with the repo. An optional state column is checked against each placement. Respondent locations are only ever used at the county level; the tool has no option to place people by coordinates.
3. **County weather record.** `data/county_weather.csv` loads automatically. Any CSV with a `fips` column and numeric county variables can be loaded in its place.
4. **Fit the respondent model.** Choose the outcome and predictors. Each predictor is entered either as a number (one slope) or as a category (one coefficient per answer, compared with the most common answer). Survey weights are optional.

The map opens on a smoothed residual surface that fills in unsampled counties (see Smoothing below). It can also show the raw weighted mean residual in each county that has at least the chosen number of respondents. The color range is set with a slider and does not rescale when the minimum count changes, so the same color means the same residual throughout a session. The map can also show respondent counts or any weather variable.

The lower right panel plots county mean residuals against one weather variable and fits a county-level regression on all ticked weather variables, weighted by the number of respondents in each county.

## SPEER coding notes

The SPEER energy items run in different directions. `NRG_Solar`, `NRG_Wind` and `NRG_Nuclear` are coded 1 = very favorable to 6 = very unfavorable, and `NRG_HC` 1 = strongly agree to 6 = strongly disagree that hydrocarbons should stay in the energy mix. The `_l` versions reverse these (7 minus the answer), so higher values mean more favorable toward solar, wind and nuclear, and more agreement that hydrocarbons should continue. `NRG_CC` (carbon capture research) is already coded 1 = strongly oppose to 6 = strongly favor. A positive county residual means respondents there scored higher on whichever coding is chosen than the model predicts.

## Methods

**Models.** Linear outcomes are fitted by weighted least squares. Yes/no outcomes are fitted by weighted logistic regression (iteratively reweighted least squares), with the answers counted as yes chosen in the tool. Survey weights are rescaled to a mean of 1. Rows with a missing value in any selected column are dropped.

**Standard errors.** Robust (HC1) standard errors are the default. Clustering by county is also available, and is the appropriate choice when county weather variables are added to the respondent model, because every respondent in a county then shares the same weather values. Small-sample corrections follow Stata's conventions. The linear model and its robust and clustered standard errors were checked against statsmodels.

**Residuals.** For the linear model the residual is observed minus fitted. For the logistic model it is the observed 0 or 1 minus the predicted probability. A positive county mean residual means respondents there scored higher on the outcome than their socioeconomic profile predicts.

**Two ways to bring in weather.** The first is two-stage: fit the socioeconomic model, then regress county mean residuals on weather variables. The second adds the weather variables directly to the respondent model as county-level predictors, with county-clustered standard errors. The two-stage approach shows the geography of what the socioeconomic model leaves unexplained. The one-stage approach gives weather coefficients that are adjusted for the socioeconomic predictors at the same time.

**Small counties.** Many counties hold only one or two respondents in a national sample, and their mean residuals are dominated by individual variation. The minimum-respondents slider removes them from the map, the Moran's I test and the county model.

**Smoothing.** Most counties hold no respondents, so the default map layer is a Gaussian kernel smooth. Each county's value is the survey-weighted mean of respondent residuals, with each respondent further weighted by exp(-d²/2h²), where d is the distance between the centroid of the respondent's county and the centroid of the county being filled, and h is the smoothing distance set with the slider (25 to 400 km; respondents beyond 3h are ignored). The kernel-weighted respondent count is reported for each county, and counties where it falls below the minimum are hatched. A short distance keeps local detail but leaves gaps; a long distance fills the map but blends neighboring regions together, so a pattern that persists across several distances is more robust than one that appears at only one. The smoothed values are for display. Moran's I and the county weather model use the raw county means, since smoothing creates spatial correlation by construction. The downloaded county table includes both.

**Spatial clustering.** Moran's I is computed on county mean residuals using row-standardized weights between counties that share a border, with a 999-permutation p-value. Counties with no qualifying neighbor are left out and counted. A significant positive I means counties with similar residuals are next to each other, a sign that something regional is missing from the respondent model.

## Building the county tables

Both scripts use only the Python standard library.

```
python scripts/build_county_weather.py                  # 2014-2023 by default
python scripts/build_county_weather.py --start 2019 --end 2023
python scripts/build_county_weather.py --perc-end 2024-07 --perc-base-years 3
```

`data/zip_county.csv` is already in the repo; `build_zip_county.py` rebuilds it (it needs `pip install pyreadr`). It combines the Census 2020 ZCTA-to-county relationship, the Census 2010 relationship file's population counts for each ZCTA-county piece, and the John Snow, Inc. ZIP-to-ZCTA crosswalk, using public copies of these files in the zctaCrosswalk (MarketBridge) and zcta (jjchern) repositories on GitHub. Each ZIP code is assigned to one county: a ZCTA inside one county goes to that county, and a ZCTA split between counties goes to the county holding the largest share of its 2010 population. PO box and single-business ZIP codes, which have no ZCTA, are assigned through the ZCTA that contains them. The file covers 41,063 ZIP codes. About 10,000 ZCTAs touch more than one county, though in most of them nearly all residents are in one; the tool reports how many respondents live in ZIPs where the assigned county holds less than 90% of the population.

`build_county_weather.py` writes `data/county_weather.csv` and `data/county_weather_dictionary.csv`, whose descriptions appear in the tool. Downloads are cached in `scripts/cache/`. The variables are:

| Prefix | Source | Variables |
|---|---|---|
| `se_` | NOAA Storm Events database | days with heat, cold, winter storm, tornado, hail and thunderstorm wind, flood, tropical, wildfire and drought events; deaths; damage in millions of nominal USD |
| `nc_` | NOAA nClimDiv county temperature | mean temperature anomaly relative to 1991–2020; months with unusually high maximum or low minimum temperature relative to the county's own 1991–2020 record; summer maximum and winter minimum temperature |
| `fema_` | OpenFEMA Disaster Declarations Summaries | declarations naming the county, all types and by incident type |
| `pc_` | nClimDiv, Storm Events, US Drought Monitor | the 12 months before the survey compared with the preceding years, matched to the SPEER perception items (below) |

### Measured counterparts to the perception items

SPEER Q15 (`WxPerc_*`) asks whether four kinds of events happened more or less often in the area around the respondent "in the last twelve months, as compared to the last few years", on a scale from 1 (definitely less frequently) to 5 (definitely more frequently). The `pc_` variables measure the same comparison for each county: the 12 months ending at `--perc-end` (default July 2024, the last full month before fieldwork began on August 16, 2024) against the mean of the `--perc-base-years` 12-month blocks before that (default 5, so August 2018 to July 2023). Every `pc_` variable is oriented so that a positive value means more of the event recently, the same direction as a high `WxPerc` answer.

| Survey item | Measured counterparts |
|---|---|
| `WxPerc_RainFlood` | `pc_precip_pct` (percent change in 12-month precipitation), `pc_flood_days_more` (change in flood event-days) |
| `WxPerc_HotHeat` | `pc_tmax_warmer_f` (change in mean daily maximum temperature), `pc_heat_days_more` (change in heat event-days) |
| `WxPerc_ColdWinter` | `pc_winter_colder_f` (how much colder the December–February minimum was than in the baseline winters), `pc_coldwinter_days_more` (change in cold and winter storm event-days) |
| `WxPerc_Droughts` | `pc_drought_area_more` (change in mean percent of county area in D1 or worse), `pc_drought_days_more` (change in drought event-days) |

In SPEER, a `WxPerc` item can be chosen as the outcome and its measured counterparts added as county predictors with county-clustered standard errors, which tests how closely perception follows the measured record once the socioeconomic predictors are held constant. The residual map then shows where people perceived more or less change than both their characteristics and their county's measured weather predict. Q16 (`WxFut_*`) asks about the next five years and has no measured counterpart.

Some properties of these sources that bear on interpretation:

- Heat and cold events in Storm Events are mostly reported by NWS forecast zone, not by county. The script maps zones to counties with the current NWS zone–county correlation file, and splits zone deaths and damage evenly across the zone's counties. Zone boundaries have changed over the years, and the script reports how many zones it could not match.
- Storm Events reporting practice differs between NWS offices, especially for heat, so neighboring counties served by different offices can show different counts for similar conditions.
- The nClimDiv hot and cold month counts are measured against each county's own history, so they describe how unusual recent years were for that place. The summer and winter temperature variables describe how hot or cold the place is in absolute terms.
- FEMA declarations reflect state requests and federal decisions as well as the hazard itself. Statewide records and the 2020 Biological (COVID-19) declarations are excluded.
- Connecticut's planning regions replaced its counties in 2022. The county map, the ZIP file and nClimDiv all use the older eight counties.

## Testing

`sample/synthetic_survey.csv` is an invented survey of 4,000 respondents with a `county_fips` column. It exists only to try the tool, and its answers do not describe any real population.

## Files

```
index.html, css/, js/          the tool (js/stats.js holds the regression and Moran's I code)
data/counties-albers-10m.json  county outlines from us-atlas 3.0.1
data/zip_county.csv            ZIP code to county lookup (rebuilt by scripts/build_zip_county.py)
data/county_weather*.csv       built by scripts/build_county_weather.py
vendor/                        d3 7.9.0, topojson-client 3.1.0, Papa Parse 5.7.0, with licenses
```

## License and citation

SPEER is shared under the Creative Commons Attribution-ShareAlike 4.0 International license (CC BY-SA 4.0). Please cite it as:

Bedle, H. (2026). *SPEER: survey regression residuals by county.* University of Oklahoma. https://hbedle-subsurface.github.io/SPEER/

Contact: Heather Bedle, hbedle@ou.edu, ORCID 0000-0003-3010-0195.
