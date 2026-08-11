#!/usr/bin/env python3
"""
$ELEC — 7-Hub 2-Year SQLite Builder
------------------------------------------------------------------------------
Reads the 8 JSON files produced by pull_2yr_history.sh (7 hubs, ERCOT split
into 2 chunks) and builds a single combined SQLite database
(x402_7hub_2yr.db) with one normalized table: hub_prices.

DO NOT RUN THIS until pull_2yr_history.sh has been run and the JSON files
exist in this same directory.

FIELD NAME NOTES (discovered during Step 1 API confirmation, 2026-08-03):
  - ERCOT (ercot_spp_real_time_15_min)              -> price field is "spp"
  - PJM   (pjm_lmp_real_time_hourly)                -> price field is "lmp"
  - CAISO (caiso_lmp_day_ahead_hourly)              -> price field is "lmp"
      (NOTE: despite the "spp"-style naming convention used by some other
      GridStatus CAISO datasets like caiso_lmp_real_time_5_min, the
      day-ahead-hourly CAISO dataset used here returns "lmp", not "spp".)
  - MISO  (miso_lmp_real_time_hourly_ex_post_final) -> price field is "lmp"
  - NYISO (nyiso_lmp_day_ahead_hourly)              -> price field is "lmp"
  - ISONE (isone_lmp_real_time_hourly_final)        -> price field is "lmp"
  - SPP   (spp_lmp_day_ahead_hourly)                -> price field is "lmp"

  So ERCOT is the ONLY hub in this set of 7 that uses "spp" — all six others
  use "lmp". This differs from the original assumption that ERCOT/CAISO-style
  datasets share "spp"; that only held for CAISO's real-time-5-min dataset,
  not the day-ahead-hourly dataset used here.

CONFIRMED LOCATION STRINGS (see pull_2yr_history.sh comments for the ones
that required discovery — CAISO, MISO, ISONE, SPP locations were NOT the
initial guesses):
  ERCOT  HB_HUBAVG          (dataset: ercot_spp_real_time_15_min)
  PJM    WESTERN HUB        (dataset: pjm_lmp_real_time_hourly)
  CAISO  TH_NP15_GEN-APND   (dataset: caiso_lmp_day_ahead_hourly)
  MISO   INDIANA.HUB        (dataset: miso_lmp_real_time_hourly_ex_post_final)
  NYISO  N.Y.C.             (dataset: nyiso_lmp_day_ahead_hourly)
  ISONE  .H.INTERNAL_HUB    (dataset: isone_lmp_real_time_hourly_final)
  SPP    SPPSOUTH_HUB       (dataset: spp_lmp_day_ahead_hourly)
"""

import json
import os
import sqlite3
from datetime import datetime

OUTPUT_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(OUTPUT_DIR, "x402_7hub_2yr.db")

# ---------------------------------------------------------------------------
# Hub config: maps hub label -> (list of source JSON files, price field name,
# granularity label)
# ---------------------------------------------------------------------------
HUBS = {
    "ERCOT_HB_HUBAVG": {
        "files": ["ercot_hubavg_2yr_part1.json", "ercot_hubavg_2yr_part2.json"],
        "price_field": "spp",
        "granularity": "real_time_15min",
    },
    "PJM_WEST": {
        "files": ["pjm_west_2yr.json"],
        "price_field": "lmp",
        "granularity": "real_time_hourly",
    },
    "CAISO_NP15": {
        "files": ["caiso_np15_2yr.json"],
        "price_field": "lmp",
        "granularity": "day_ahead_hourly",
    },
    "MISO_INDIANA": {
        "files": ["miso_indiana_2yr.json"],
        "price_field": "lmp",
        "granularity": "real_time_hourly",
    },
    "NYISO_ZONEJ": {
        "files": ["nyiso_zonej_2yr.json"],
        "price_field": "lmp",
        "granularity": "day_ahead_hourly",
    },
    "ISONE_MASSHUB": {
        "files": ["isone_masshub_2yr.json"],
        "price_field": "lmp",
        "granularity": "real_time_hourly",
    },
    "SPP_SOUTH": {
        "files": ["spp_south_2yr.json"],
        "price_field": "lmp",
        "granularity": "day_ahead_hourly",
    },
}

# ---------------------------------------------------------------------------
# DB setup
# ---------------------------------------------------------------------------
def init_db(path):
    if os.path.exists(path):
        os.remove(path)
    con = sqlite3.connect(path)
    cur = con.cursor()
    cur.execute(
        """
        CREATE TABLE hub_prices (
          hub TEXT NOT NULL,
          interval_start_utc TEXT NOT NULL,
          interval_end_utc TEXT NOT NULL,
          price_usd_mwh REAL NOT NULL,
          granularity TEXT NOT NULL,
          PRIMARY KEY (hub, interval_start_utc)
        )
        """
    )
    con.commit()
    return con


def load_hub_rows(hub_name, cfg):
    """Read all source JSON files for a hub, dedupe by interval_start_utc,
    and return a list of row tuples ready for insertion."""
    price_field = cfg["price_field"]
    granularity = cfg["granularity"]

    rows_by_start = {}
    missing_files = []

    for fname in cfg["files"]:
        fpath = os.path.join(OUTPUT_DIR, fname)
        if not os.path.exists(fpath):
            missing_files.append(fname)
            continue

        with open(fpath, "r") as f:
            payload = json.load(f)

        records = payload.get("data", [])
        for rec in records:
            start = rec.get("interval_start_utc")
            end = rec.get("interval_end_utc")
            price = rec.get(price_field)

            if start is None or price is None:
                continue

            # Dedup: last write wins for a given interval_start_utc within
            # this hub (mirrors the working ERCOT loader's pattern).
            rows_by_start[start] = (hub_name, start, end, float(price), granularity)

    if missing_files:
        print(f"  [{hub_name}] WARNING: missing source file(s): {', '.join(missing_files)}")

    return list(rows_by_start.values()), missing_files


def summarize(hub_name, rows):
    if not rows:
        print(f"  [{hub_name}] 0 rows — nothing to summarize")
        return None

    starts = [r[1] for r in rows]
    prices = [r[3] for r in rows]

    lo_start = min(starts)
    hi_start = max(starts)
    n = len(prices)
    p_min = min(prices)
    p_max = max(prices)
    p_avg = sum(prices) / n

    print(
        f"  [{hub_name}] {n:,} rows | {lo_start} -> {hi_start} | "
        f"min ${p_min:.2f}  max ${p_max:.2f}  avg ${p_avg:.2f} /MWh"
    )
    return {"rows": n, "min": p_min, "max": p_max, "avg": p_avg,
             "start": lo_start, "end": hi_start}


def main():
    print(f"Building {DB_PATH} ...")
    con = init_db(DB_PATH)
    cur = con.cursor()

    grand_total_rows = 0
    per_hub_stats = {}
    all_missing = []

    for hub_name, cfg in HUBS.items():
        rows, missing = load_hub_rows(hub_name, cfg)
        all_missing.extend(missing)

        if rows:
            cur.executemany(
                """
                INSERT OR REPLACE INTO hub_prices
                (hub, interval_start_utc, interval_end_utc, price_usd_mwh, granularity)
                VALUES (?, ?, ?, ?, ?)
                """,
                rows,
            )
            con.commit()

        stats = summarize(hub_name, rows)
        if stats:
            per_hub_stats[hub_name] = stats
            grand_total_rows += stats["rows"]

    print("\n" + "=" * 70)
    print(f"GRAND TOTAL: {grand_total_rows:,} rows across {len(per_hub_stats)} hub(s)")
    if all_missing:
        print(f"Missing source files (re-run pull_2yr_history.sh to fix): {sorted(set(all_missing))}")
    print(f"Database saved to: {DB_PATH}")
    print("=" * 70)

    con.close()


if __name__ == "__main__":
    main()
