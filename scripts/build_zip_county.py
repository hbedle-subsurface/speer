"""Build data/zip_county.csv, the ZIP code to county lookup used by SPEER.

A copy of the output is already in data/, so this script is only needed to
rebuild or check it.

Sources, all public copies of Census and USPS-derived files kept on GitHub:
  - Census 2020 ZCTA-to-county relationship (which counties each 2020 ZCTA
    touches), from the zctaCrosswalk R package (MarketBridge/zctaCrosswalk).
  - Census 2010 ZCTA-to-county relationship with population counts for each
    ZCTA-county piece, from jjchern/zcta.
  - ZIP code to ZCTA crosswalk (John Snow, Inc., via jjchern/zcta), which maps
    PO box and single-business ZIP codes to the ZCTA that contains them.

Each ZIP goes to one county. A ZCTA that lies in one county goes to that
county. A ZCTA split between counties goes to the county holding the largest
share of its 2010 population; when a 2020 ZCTA has no 2010 population figures
it goes to the first county listed and its share is left blank.

Usage:
    pip install pyreadr
    python scripts/build_zip_county.py
"""
import csv
import os
import tarfile
import tempfile
import urllib.request
from collections import defaultdict

import pyreadr

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "zip_county.csv")
# Alaska's Valdez-Cordova Census Area (02261) was split in 2019; the county
# outlines in data/ still show it as one area
MERGE = {"02063": "02261", "02066": "02261"}
REPOS = {
    "zctaCrosswalk": "https://codeload.github.com/MarketBridge/zctaCrosswalk/tar.gz/main",
    "zcta": "https://codeload.github.com/jjchern/zcta/tar.gz/master",
}


def read_rda(tmp, repo_key, member_suffix):
    path = os.path.join(tmp, repo_key + ".tgz")
    if not os.path.exists(path):
        print(f"Downloading {REPOS[repo_key]}")
        urllib.request.urlretrieve(REPOS[repo_key], path)
    with tarfile.open(path) as t:
        m = next(m for m in t.getmembers() if m.name.endswith(member_suffix))
        out = os.path.join(tmp, os.path.basename(m.name))
        with open(out, "wb") as f:
            f.write(t.extractfile(m).read())
    return next(iter(pyreadr.read_r(out).values()))


def main():
    tmp = tempfile.mkdtemp()
    rel20 = read_rda(tmp, "zctaCrosswalk", "data/zcta_crosswalk.rda")
    rel10 = read_rda(tmp, "zcta", "data/zcta_county_rel_10.rda")
    zipz = read_rda(tmp, "zcta", "data/zipzcta.rda")

    counties20 = defaultdict(set)
    for z, c in zip(rel20["zcta"], rel20["county_fips"]):
        c = str(c).zfill(5)
        counties20[str(z).zfill(5)].add(MERGE.get(c, c))
    pop10 = {(str(z).zfill(5), str(c).zfill(5)): float(p)
             for z, c, p in zip(rel10["zcta5"], rel10["geoid"], rel10["zpoppct"])}

    zcta_county = {}
    for z, cs in counties20.items():
        cs = sorted(cs)
        if len(cs) == 1:
            zcta_county[z] = (cs[0], 1.0, 1)
            continue
        known = {c: pop10[(z, c)] for c in cs if (z, c) in pop10}
        if known:
            best = max(known, key=known.get)
            zcta_county[z] = (best, round(known[best] / 100, 4), len(cs))
        else:
            zcta_county[z] = (cs[0], None, len(cs))

    rows = dict(zcta_county)
    added = 0
    for zp, zc in zip(zipz["zip"], zipz["zcta"]):
        zp, zc = str(zp).zfill(5), str(zc).zfill(5)
        if zp not in rows and zc in zcta_county:
            rows[zp] = zcta_county[zc]
            added += 1

    os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
    with open(OUT, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["zip", "county_fips", "pop_share", "n_counties"])
        for z in sorted(rows):
            c, s, n = rows[z]
            w.writerow([z, c, "" if s is None else s, n])
    split = sum(1 for v in zcta_county.values() if v[2] > 1)
    print(f"Wrote {len(rows):,} ZIP codes to {OUT}: {len(zcta_county):,} ZCTAs "
          f"({split:,} split between counties) and {added:,} further ZIPs mapped through their ZCTA")


if __name__ == "__main__":
    main()
