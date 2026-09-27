"""Build data/county_weather.csv (and county_weather_dictionary.csv)
for a window of years, default 2014-2023.

Three public sources, each optional:

  storm   NOAA Storm Events database: event-days, deaths and damage by
          county, grouped into heat, cold, winter storm, tornado, hail and
          thunderstorm wind, flood, tropical, wildfire and drought.
  climdiv NOAA nClimDiv county monthly temperature: warming relative to the
          1991-2020 normal and counts of unusually hot and cold months.
  fema    OpenFEMA disaster declarations by county.

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


def storm_events(start, end, zone_file):
    print("Storm Events")
    idx = listing(STORM_DIR)
    zones = zone_to_counties(zone_file)
    days = defaultdict(lambda: defaultdict(set))   # county -> group -> set of dates
    deaths = defaultdict(float)
    damage = defaultdict(float)
    unmatched_zones = set()
    for year in range(start, end + 1):
        files = sorted(re.findall(rf"StormEvents_details-ftp_v1\.0_d{year}_c\d{{8}}\.csv\.gz", idx))
        if not files:
            print(f"  no details file for {year}, skipped")
            continue
        raw = gzip.decompress(fetch(STORM_DIR + files[-1], files[-1], binary=True)).decode("latin-1")
        for r in csv.DictReader(io.StringIO(raw)):
            et = r["EVENT_TYPE"].strip()
            group = next((g for g, s in STORM_GROUPS.items() if et in s), None)
            st = r["STATE_FIPS"].strip().zfill(2)
            cz = r["CZ_FIPS"].strip().zfill(3)
            if r["CZ_TYPE"] == "C":
                counties = {st + cz}
            elif r["CZ_TYPE"] == "Z":
                key = STATE_ABBR.get(st, "") + cz
                counties = zones.get(key, set())
                if not counties:
                    unmatched_zones.add(key)
                    continue
            else:
                continue  # marine zones
            date = f"{r['BEGIN_YEARMONTH']}{r['BEGIN_DAY'].zfill(2)}"
            d = sum(float(r[k] or 0) for k in ("DEATHS_DIRECT", "DEATHS_INDIRECT"))
            dmg = parse_damage(r["DAMAGE_PROPERTY"]) + parse_damage(r["DAMAGE_CROPS"])
            share = 1 / len(counties)  # zone totals are split evenly across the zone's counties
            for c in counties:
                if group:
                    days[c][group].add(date)
                deaths[c] += d * share
                damage[c] += dmg * share
        print(f"  {year} read")
    if unmatched_zones:
        print(f"  {len(unmatched_zones)} forecast zones had no county match (zone boundaries change over time)")
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
        data[fips][year] = [None if v <= -99 else v for v in vals]
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


# ---------------- main ----------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=int, default=2014)
    ap.add_argument("--end", type=int, default=2023)
    ap.add_argument("--sources", nargs="+", default=["storm", "climdiv", "fema"], choices=["storm", "climdiv", "fema"])
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

    counties = sorted(set().union(*[t.keys() for t in tables]))
    cols = list(desc.keys())
    # counties absent from Storm Events or FEMA had no events: those counts are 0, not missing
    zero_fill = [c for c in cols if c.startswith("se_") or c.startswith("fema_")]
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
