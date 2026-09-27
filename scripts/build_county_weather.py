"""Build data/county_weather.csv (and county_weather_dictionary.csv)
for a window of years, default 2014-2023.

Three public sources, each optional:

  storm   NOAA Storm Events database: event-days, deaths and damage by
          county, grouped into heat, cold, winter storm, tornado, hail and
          thunderstorm wind, flood, tropical, wildfire and drought.
  climdiv NOAA nClimDiv county monthly temperature: warming relative to the
          1991-2020 normal and counts of unusually hot and cold months.
  fema    OpenFEMA disaster declarations by county.
  perception
          Variables matched to the SPEER weather perception items (Q15):
          the 12 months before the survey compared with the preceding years,
          for precipitation, heat, winter cold and drought, from nClimDiv,
          Storm Events and the US Drought Monitor.

Uses only the Python standard library.

Usage:
    python scripts/build_county_weather.py                  # all sources, 2014-2023
    python scripts/build_county_weather.py --start 2019 --end 2023
    python scripts/build_county_weather.py --sources climdiv fema

Downloads are cached in scripts/cache/ so reruns are quick.
"""
import argparse
import csv
import gzip
import io
import json
import os
import re
import urllib.parse
import urllib.request
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")
OUT_DIR = os.path.join(HERE, "..", "data")

STORM_DIR = "https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/"
CLIMDIV_DIR = "https://www.ncei.noaa.gov/pub/data/cirs/climdiv/"
ZONE_PAGE = "https://www.weather.gov/gis/ZoneCounty"
ZONE_BASE = "https://www.weather.gov/source/gis/Shapefiles/County/"
FEMA_API = "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries"

STATE_ABBR = {
    "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE",
    "11": "DC", "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA",
    "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN",
    "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM",
    "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI",
    "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA",
    "54": "WV", "55": "WI", "56": "WY",
}
# nClimDiv numbers states alphabetically (contiguous US), Alaska = 50
NCDC_TO_FIPS = {
    "01": "01", "02": "04", "03": "05", "04": "06", "05": "08", "06": "09", "07": "10", "08": "12",
    "09": "13", "10": "16", "11": "17", "12": "18", "13": "19", "14": "20", "15": "21", "16": "22",
    "17": "23", "18": "24", "19": "25", "20": "26", "21": "27", "22": "28", "23": "29", "24": "30",
    "25": "31", "26": "32", "27": "33", "28": "34", "29": "35", "30": "36", "31": "37", "32": "38",
    "33": "39", "34": "40", "35": "41", "36": "42", "37": "44", "38": "45", "39": "46", "40": "47",
    "41": "48", "42": "49", "43": "50", "44": "51", "45": "53", "46": "54", "47": "55", "48": "56",
    "50": "02",
}

STORM_GROUPS = {
    "heat": {"Heat", "Excessive Heat"},
    "cold": {"Cold/Wind Chill", "Extreme Cold/Wind Chill", "Frost/Freeze"},
    "winter": {"Winter Storm", "Blizzard", "Ice Storm", "Heavy Snow", "Lake-Effect Snow"},
    "tornado": {"Tornado"},
    "hail_wind": {"Hail", "Thunderstorm Wind"},
    "flood": {"Flash Flood", "Flood", "Coastal Flood"},
    "tropical": {"Hurricane", "Hurricane (Typhoon)", "Tropical Storm", "Tropical Depression", "Storm Surge/Tide"},
    "wildfire": {"Wildfire"},
    "drought": {"Drought"},
}
STORM_LABEL = {
    "heat": "Heat and Excessive Heat", "cold": "Cold/Wind Chill, Extreme Cold and Frost/Freeze",
    "winter": "Winter Storm, Blizzard, Ice Storm and heavy snow", "tornado": "Tornado",
    "hail_wind": "Hail and Thunderstorm Wind", "flood": "Flash Flood, Flood and Coastal Flood",
    "tropical": "hurricane, tropical storm and storm surge", "wildfire": "Wildfire", "drought": "Drought",
}
FEMA_GROUPS = {
    "severe_storm": {"Severe Storm", "Severe Storm(s)", "Coastal Storm"},
    "flood": {"Flood"},
    "hurricane": {"Hurricane", "Typhoon", "Tropical Storm"},
    "fire": {"Fire"},
    "winter": {"Severe Ice Storm", "Snowstorm", "Winter Storm", "Freezing"},
    "tornado": {"Tornado"},
}


# ---------------- helpers ----------------
def fetch(url, name=None, binary=False):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name or re.sub(r"[^\w.-]", "_", url.split("//")[-1])[-150:])
    if not os.path.exists(path):
        print(f"  downloading {url}")
        req = urllib.request.Request(url, headers={"User-Agent": "speer-county-weather/1.0"})
        with urllib.request.urlopen(req, timeout=180) as r, open(path, "wb") as f:
            f.write(r.read())
    data = open(path, "rb").read()
    return data if binary else data.decode("utf-8", errors="replace")


def listing(url):
    # directory listings change daily, so they are not cached
    req = urllib.request.Request(url, headers={"User-Agent": "speer-county-weather/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", errors="replace")


def parse_damage(s):
    s = (s or "").strip().upper()
    if not s:
        return 0.0
    mult = {"K": 1e3, "M": 1e6, "B": 1e9}.get(s[-1], 1)
    try:
        return float(s[:-1] if s[-1] in "KMB" else s) * mult
    except ValueError:
        return 0.0


# ---------------- Storm Events ----------------
def zone_to_counties(zone_file):
    if zone_file:
        text = open(zone_file, encoding="utf-8", errors="replace").read()
    else:
        page = listing(ZONE_PAGE)
        names = re.findall(r"bp\d{2}[a-z]{2}\d{2}\.dbx", page)
        if not names:
            raise SystemExit("Could not find the NWS zone-county correlation file. Download the "
                             ".dbx file from https://www.weather.gov/gis/ZoneCounty and pass --zone-file.")
        text = fetch(ZONE_BASE + names[0], names[0])
    m = defaultdict(set)
    for line in text.splitlines():
        p = line.split("|")
        if len(p) < 7:
            continue
        state, zone, fips = p[0].strip(), p[1].strip().zfill(3), p[6].strip().zfill(5)
        if state and zone and fips.isdigit():
            m[state + zone].add(fips)
    return m


_STORM_CACHE = {}
_ZONES = None
_UNMATCHED_ZONES = set()


def storm_year(year, zone_file):
    """Records for one year as (counties, group, date YYYYMMDD, deaths, damage USD)."""
    global _ZONES
    if year in _STORM_CACHE:
        return _STORM_CACHE[year]
    if _ZONES is None:
        _ZONES = zone_to_counties(zone_file)
    idx = listing(STORM_DIR)
    files = sorted(re.findall(rf"StormEvents_details-ftp_v1\.0_d{year}_c\d{{8}}\.csv\.gz", idx))
    if not files:
        print(f"  no Storm Events details file for {year}, skipped")
        _STORM_CACHE[year] = []
        return []
    raw = gzip.decompress(fetch(STORM_DIR + files[-1], files[-1], binary=True)).decode("latin-1")
    recs = []
    for r in csv.DictReader(io.StringIO(raw)):
        et = r["EVENT_TYPE"].strip()
        group = next((g for g, s in STORM_GROUPS.items() if et in s), None)
        st = r["STATE_FIPS"].strip().zfill(2)
        cz = r["CZ_FIPS"].strip().zfill(3)
        if r["CZ_TYPE"] == "C":
            counties = (st + cz,)
        elif r["CZ_TYPE"] == "Z":
            key = STATE_ABBR.get(st, "") + cz
            counties = tuple(_ZONES.get(key, ()))
            if not counties:
                _UNMATCHED_ZONES.add(key)
                continue
        else:
            continue  # marine zones
        date = f"{r['BEGIN_YEARMONTH']}{r['BEGIN_DAY'].zfill(2)}"
        d = sum(float(r[k] or 0) for k in ("DEATHS_DIRECT", "DEATHS_INDIRECT"))
        dmg = parse_damage(r["DAMAGE_PROPERTY"]) + parse_damage(r["DAMAGE_CROPS"])
        recs.append((counties, group, date, d, dmg))
    print(f"  Storm Events {year} read")
    _STORM_CACHE[year] = recs
    return recs


def storm_events(start, end, zone_file):
    print("Storm Events")
    days = defaultdict(lambda: defaultdict(set))   # county -> group -> set of dates
    deaths = defaultdict(float)
    damage = defaultdict(float)
    for year in range(start, end + 1):
        for counties, group, date, d, dmg in storm_year(year, zone_file):
            share = 1 / len(counties)  # zone totals are split evenly across the zone's counties
            for c in counties:
                if group:
                    days[c][group].add(date)
                deaths[c] += d * share
                damage[c] += dmg * share
    if _UNMATCHED_ZONES:
        print(f"  {len(_UNMATCHED_ZONES)} forecast zones had no county match (zone boundaries change over time)")
    out = defaultdict(dict)
    for c in set(days) | set(deaths):
        for g in STORM_GROUPS:
            out[c][f"se_{g}_days"] = len(days[c][g]) if c in days else 0
        out[c]["se_deaths"] = round(deaths[c], 2)
        out[c]["se_damage_musd"] = round(damage[c] / 1e6, 3)
    yrs = f"{start}-{end}"
    desc = {f"se_{g}_days": f"Days with at least one {STORM_LABEL[g]} event reported, {yrs} (NOAA Storm Events)"
            for g in STORM_GROUPS}
    desc["se_deaths"] = f"Direct and indirect deaths in Storm Events reports, all event types, {yrs}"
    desc["se_damage_musd"] = f"Property and crop damage in Storm Events reports, millions of USD (nominal), all event types, {yrs}"
    return out, desc


# ---------------- nClimDiv ----------------
def read_climdiv(kind, idx):
    names = sorted(re.findall(rf"climdiv-{kind}cy-v[\d.]+-\d{{8}}", idx))
    if not names:
        raise SystemExit(f"No climdiv-{kind}cy file found at {CLIMDIV_DIR}")
    text = fetch(CLIMDIV_DIR + names[-1], names[-1])
    data = defaultdict(dict)  # fips -> year -> [12 monthly values]
    for line in text.splitlines():
        if len(line) < 11:
            continue
        st = NCDC_TO_FIPS.get(line[0:2])
        if not st:
            continue
        fips, year = st + line[2:5], int(line[7:11])
        vals = [float(v) for v in line[11:].split()[:12]]
        missing = (lambda v: v < 0) if kind == "pcpn" else (lambda v: v <= -99)  # -9.99 / -99.99 flags
        data[fips][year] = [None if missing(v) else v for v in vals]
    return data


def pct(sorted_vals, q):
    if not sorted_vals:
        return None
    k = (len(sorted_vals) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)


def climdiv(start, end):
    print("nClimDiv")
    idx = listing(CLIMDIV_DIR)
    tavg, tmax, tmin = (read_climdiv(k, idx) for k in ("tmpc", "tmax", "tmin"))
    base = range(1991, 2021)
    win = range(start, end + 1)
    out = defaultdict(dict)
    for fips in tavg:
        def mean(vals):
            vals = [v for v in vals if v is not None]
            return sum(vals) / len(vals) if vals else None
        norm = mean(v for y in base for v in tavg[fips].get(y, []))
        now = mean(v for y in win for v in tavg[fips].get(y, []))
        if norm is not None and now is not None:
            out[fips]["nc_tavg_anom_f"] = round(now - norm, 3)
        hot = cold = 0
        for m in range(12):
            hi = sorted(tmax[fips][y][m] for y in base if y in tmax.get(fips, {}) and tmax[fips][y][m] is not None)
            lo = sorted(tmin[fips][y][m] for y in base if y in tmin.get(fips, {}) and tmin[fips][y][m] is not None)
            p90, p10 = pct(hi, 0.9), pct(lo, 0.1)
            for y in win:
                v = tmax.get(fips, {}).get(y, [None] * 12)[m]
                if v is not None and p90 is not None and v > p90:
                    hot += 1
                v = tmin.get(fips, {}).get(y, [None] * 12)[m]
                if v is not None and p10 is not None and v < p10:
                    cold += 1
        out[fips]["nc_hot_months"] = hot
        out[fips]["nc_cold_months"] = cold
        s = mean(tmax.get(fips, {}).get(y, [None] * 12)[m] for y in win for m in (5, 6, 7))
        w = mean(tmin.get(fips, {}).get(y, [None] * 12)[m] for y in win for m in (0, 1, 11))
        if s is not None:
            out[fips]["nc_summer_tmax_f"] = round(s, 2)
        if w is not None:
            out[fips]["nc_winter_tmin_f"] = round(w, 2)
    yrs = f"{start}-{end}"
    n = (end - start + 1) * 12
    desc = {
        "nc_tavg_anom_f": f"Mean temperature {yrs} minus the 1991-2020 mean, degrees F (NOAA nClimDiv)",
        "nc_hot_months": f"Months out of {n} in {yrs} with mean daily maximum above the county's 1991-2020 90th percentile for that month",
        "nc_cold_months": f"Months out of {n} in {yrs} with mean daily minimum below the county's 1991-2020 10th percentile for that month",
        "nc_summer_tmax_f": f"Mean June-August daily maximum temperature, {yrs}, degrees F",
        "nc_winter_tmin_f": f"Mean December, January and February daily minimum temperature, {yrs}, degrees F",
    }
    return out, desc


# ---------------- OpenFEMA ----------------
def fema(start, end):
    print("OpenFEMA disaster declarations")
    flt = (f"declarationDate ge '{start}-01-01T00:00:00.000Z' and "
           f"declarationDate lt '{end + 1}-01-01T00:00:00.000Z'")
    sel = "disasterNumber,fipsStateCode,fipsCountyCode,incidentType,declarationDate"
    recs, skip = [], 0
    while True:
        q = urllib.parse.urlencode({"$filter": flt, "$select": sel, "$top": 10000, "$skip": skip})
        data = json.loads(fetch(f"{FEMA_API}?{q}", f"fema_{start}_{end}_{skip}.json"))
        batch = data.get("DisasterDeclarationsSummaries", [])
        recs += batch
        if len(batch) < 10000:
            break
        skip += 10000
    decl = defaultdict(lambda: defaultdict(set))
    for r in recs:
        cty = str(r.get("fipsCountyCode") or "").zfill(3)
        if cty == "000" or r.get("incidentType") == "Biological":
            continue  # statewide records, and the 2020 COVID-19 declarations that cover every county
        f = str(r["fipsStateCode"]).zfill(2) + cty
        decl[f]["all"].add(r["disasterNumber"])
        for g, types in FEMA_GROUPS.items():
            if r.get("incidentType") in types:
                decl[f][g].add(r["disasterNumber"])
    out = defaultdict(dict)
    for f, d in decl.items():
        out[f]["fema_all"] = len(d["all"])
        for g in FEMA_GROUPS:
            out[f][f"fema_{g}"] = len(d[g])
    yrs = f"{start}-{end}"
    desc = {"fema_all": f"FEMA disaster and emergency declarations naming the county, {yrs}, excluding Biological (COVID-19)"}
    names = {"severe_storm": "Severe Storm and Coastal Storm", "flood": "Flood", "hurricane": "Hurricane, Typhoon and Tropical Storm",
             "fire": "Fire", "winter": "Winter Storm, Snowstorm, Severe Ice Storm and Freezing", "tornado": "Tornado"}
    for g in FEMA_GROUPS:
        desc[f"fema_{g}"] = f"FEMA declarations naming the county with incident type {names[g]}, {yrs}"
    return out, desc


# ---------------- matched to the perception questions ----------------
# SPEER Q15 asks whether rain and floods, heat, cold and winter storms, and
# droughts happened more or less often "in the last twelve months, as compared
# to the last few years". Each variable below compares the 12 months ending at
# --perc-end with the mean of the --perc-base-years 12-month blocks before
# them, oriented so that a positive value means "more" in the question's sense.

def month_index(ym):
    y, m = (int(v) for v in ym.split("-"))
    return y * 12 + (m - 1)


def ym_label(i):
    return f"{i // 12}-{i % 12 + 1:02d}"


def usdm_d1(first, last):
    """Weekly percent of county area in D1 or worse, keyed county -> month index -> [values]."""
    start = f"{first % 12 + 1}/1/{first // 12}"
    end = f"{last % 12 + 1}/28/{last // 12}"
    out = defaultdict(lambda: defaultdict(list))
    for st in sorted(set(STATE_ABBR.values())):
        url = (f"https://usdmdataservices.unl.edu/api/CountyStatistics/GetDroughtSeverityStatisticsByAreaPercent"
               f"?aoi={st}&startdate={start}&enddate={end}&statisticsType=1")
        text = fetch(url, f"usdm_{st}_{first}_{last}.csv")
        for r in csv.DictReader(io.StringIO(text)):
            f = (r.get("FIPS") or "").strip().zfill(5)
            md = (r.get("MapDate") or "").strip()
            try:
                v = float(r.get("D1"))
            except (TypeError, ValueError):
                continue
            if len(md) >= 6 and f.strip("0"):
                out[f][int(md[:4]) * 12 + int(md[4:6]) - 1].append(v)
    return out


def perception(perc_end, base_years, zone_file):
    print("Perception-matched variables")
    E = month_index(perc_end)
    recent = range(E - 11, E + 1)
    blocks = [range(E - 12 * b - 11, E - 12 * b + 1) for b in range(1, base_years + 1)]
    first = blocks[-1][0]
    base_months = [m for blk in blocks for m in blk]
    win = f"{ym_label(recent[0])} to {ym_label(E)}"
    base = f"{ym_label(first)} to {ym_label(recent[0] - 1)}"
    out = defaultdict(dict)

    def mean(vals):
        vals = [v for v in vals if v is not None]
        return sum(vals) / len(vals) if vals else None

    # nClimDiv monthly precipitation and temperature
    idx = listing(CLIMDIV_DIR)
    pcp, tmax, tmin = (read_climdiv(k, idx) for k in ("pcpn", "tmax", "tmin"))
    get = lambda d, f, m: d.get(f, {}).get(m // 12, [None] * 12)[m % 12]
    for f in pcp:
        r_tot = [get(pcp, f, m) for m in recent]
        b_tot = [[get(pcp, f, m) for m in blk] for blk in blocks]
        if None not in r_tot and all(None not in t for t in b_tot):
            b_mean = sum(sum(t) for t in b_tot) / len(b_tot)
            if b_mean > 0:
                out[f]["pc_precip_pct"] = round(100 * (sum(r_tot) / b_mean - 1), 2)
        r, bm = mean(get(tmax, f, m) for m in recent), mean(get(tmax, f, m) for m in base_months)
        if r is not None and bm is not None:
            out[f]["pc_tmax_warmer_f"] = round(r - bm, 3)
        winter = lambda months: [m for m in months if m % 12 in (11, 0, 1)]
        r, bm = mean(get(tmin, f, m) for m in winter(recent)), mean(get(tmin, f, m) for m in winter(base_months))
        if r is not None and bm is not None:
            out[f]["pc_winter_colder_f"] = round(bm - r, 3)  # positive = recent winter colder

    # Storm Events event-days by group, recent window minus baseline block mean
    groups = {"flood": ["flood"], "heat": ["heat"], "coldwinter": ["cold", "winter"], "drought": ["drought"]}
    counts = defaultdict(lambda: defaultdict(set))  # (county, group) -> block -> dates
    for year in range(first // 12, E // 12 + 1):
        for counties, group, date, _, _ in storm_year(year, zone_file):
            m = int(date[:4]) * 12 + int(date[4:6]) - 1
            if m < first or m > E:
                continue
            blk = 0 if m >= recent[0] else (recent[0] - 1 - m) // 12 + 1
            for name, gs in groups.items():
                if group in gs:
                    for c in counties:
                        counts[(c, name)][blk].add(date)
    for (c, name), by in counts.items():
        out[c][f"pc_{name}_days_more"] = round(len(by.get(0, ())) - sum(len(by.get(b, ())) for b in range(1, base_years + 1)) / base_years, 2)

    # US Drought Monitor
    try:
        d1 = usdm_d1(first, E)
        for f, by in d1.items():
            r = mean(v for m in recent for v in by.get(m, []))
            bm = mean(v for m in base_months for v in by.get(m, []))
            if r is not None and bm is not None:
                out[f]["pc_drought_area_more"] = round(r - bm, 2)
    except Exception as e:  # the drought service is separate from NOAA; keep the rest if it fails
        print(f"  US Drought Monitor download failed ({e}); pc_drought_area_more left out")

    desc = {
        "pc_precip_pct": f"Precipitation {win} as percent above (+) or below (-) the mean 12-month total for {base} (nClimDiv); matches WxPerc_RainFlood",
        "pc_flood_days_more": f"Flood event-days {win} minus the mean per 12 months for {base} (Storm Events); matches WxPerc_RainFlood",
        "pc_tmax_warmer_f": f"Mean daily maximum temperature {win} minus {base}, degrees F (nClimDiv); matches WxPerc_HotHeat",
        "pc_heat_days_more": f"Heat event-days {win} minus the mean per 12 months for {base} (Storm Events); matches WxPerc_HotHeat",
        "pc_winter_colder_f": f"December-February mean daily minimum in {base} minus the winter in {win}, degrees F; positive means the recent winter was colder; matches WxPerc_ColdWinter",
        "pc_coldwinter_days_more": f"Cold and winter storm event-days {win} minus the mean per 12 months for {base} (Storm Events); matches WxPerc_ColdWinter",
        "pc_drought_days_more": f"Drought event-days {win} minus the mean per 12 months for {base} (Storm Events); matches WxPerc_Droughts",
        "pc_drought_area_more": f"Mean weekly percent of county area in D1 or worse drought, {win} minus {base} (US Drought Monitor); matches WxPerc_Droughts",
    }
    return out, desc


# ---------------- main ----------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=int, default=2014)
    ap.add_argument("--end", type=int, default=2023)
    ap.add_argument("--sources", nargs="+", default=["storm", "climdiv", "fema", "perception"],
                    choices=["storm", "climdiv", "fema", "perception"])
    ap.add_argument("--perc-end", default="2024-07",
                    help="last full month before the survey, YYYY-MM (SPEER fieldwork began August 16, 2024)")
    ap.add_argument("--perc-base-years", type=int, default=5,
                    help="number of 12-month blocks before the recent year used as 'the last few years'")
    ap.add_argument("--zone-file", help="local NWS zone-county correlation file (bpDDmmYY.dbx)")
    ap.add_argument("--out-dir", default=OUT_DIR)
    args = ap.parse_args()

    tables, desc = [], {}
    if "storm" in args.sources:
        t, d = storm_events(args.start, args.end, args.zone_file); tables.append(t); desc.update(d)
    if "climdiv" in args.sources:
        t, d = climdiv(args.start, args.end); tables.append(t); desc.update(d)
    if "fema" in args.sources:
        t, d = fema(args.start, args.end); tables.append(t); desc.update(d)
    if "perception" in args.sources:
        t, d = perception(args.perc_end, args.perc_base_years, args.zone_file); tables.append(t); desc.update(d)

    counties = sorted(set().union(*[t.keys() for t in tables]))
    cols = list(desc.keys())
    # counties absent from Storm Events or FEMA had no events: those counts are 0, not missing
    zero_fill = [c for c in cols if c.startswith("se_") or c.startswith("fema_") or
                 (c.startswith("pc_") and c.endswith("_days_more"))]
    os.makedirs(args.out_dir, exist_ok=True)
    out = os.path.join(args.out_dir, "county_weather.csv")
    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["fips"] + cols)
        for c in counties:
            merged = {}
            for t in tables:
                merged.update(t.get(c, {}))
            w.writerow([c] + [merged.get(k, 0 if k in zero_fill else "") for k in cols])
    with open(os.path.join(args.out_dir, "county_weather_dictionary.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["variable", "description"])
        w.writerows(desc.items())
    print(f"Wrote {len(counties):,} counties and {len(cols)} variables to {out}")


if __name__ == "__main__":
    main()
