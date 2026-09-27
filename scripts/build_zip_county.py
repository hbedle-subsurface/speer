"""Build data/zip_county.csv from the Census 2020 ZCTA-to-county
relationship file.

Each ZCTA (the Census area approximating a ZIP code) is assigned to the
county holding the largest share of its land area. The output keeps that
share and the number of counties the ZCTA touches, so Speer can report how
many respondents live in ZIPs that cross a county line.

Usage:
    python scripts/build_zip_county.py
    python scripts/build_zip_county.py --file tab20_zcta520_county20_natl.txt   # local copy
"""
import argparse
import csv
import io
import os
import urllib.request

URL = ("https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/"
       "tab20_zcta520_county20_natl.txt")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "zip_county.csv")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", help="local copy of the Census relationship file")
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()

    if args.file:
        text = open(args.file, encoding="utf-8-sig").read()
    else:
        print(f"Downloading {URL}")
        with urllib.request.urlopen(URL) as r:
            text = r.read().decode("utf-8-sig")

    reader = csv.DictReader(io.StringIO(text), delimiter="|")
    parts = {}  # zcta -> list of (county, land_part)
    totals = {}
    for row in reader:
        z = (row.get("GEOID_ZCTA5_20") or "").strip()
        c = (row.get("GEOID_COUNTY_20") or "").strip()
        if not z or not c:
            continue  # county rows with no ZCTA
        part = float(row.get("AREALAND_PART") or 0)
        parts.setdefault(z, []).append((c, part))
        totals[z] = float(row.get("AREALAND_ZCTA5_20") or 0)

    rows = []
    for z, lst in parts.items():
        lst.sort(key=lambda t: -t[1])
        total = totals[z] or sum(p for _, p in lst)
        share = lst[0][1] / total if total else 1.0
        rows.append((z, lst[0][0], round(share, 4), len(lst)))
    rows.sort()

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["zip", "county_fips", "land_share", "n_counties"])
        w.writerows(rows)
    split = sum(1 for r in rows if r[3] > 1)
    print(f"Wrote {len(rows):,} ZCTAs to {args.out} ({split:,} touch more than one county)")


if __name__ == "__main__":
    main()
