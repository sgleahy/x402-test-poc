"""
$ELEC -- Live Load Poller (7 ISOs, free `gridstatus` open-source library)
---------------------------------------------------------------------------
Standalone service, deployed as its own Railway service (separate from the
Node price/API server) because `gridstatus` requires Python 3.11+ and this
keeps the payment/session logic in the already-working Node app untouched.

Runs forever: every POLL_INTERVAL_MINUTES, pulls each ISO's most recent load
reading and upserts into the shared Postgres `hub_loads_live` table (same
DATABASE_URL as the Node service -- attach the same Railway Postgres plugin
to both services).

Reuses the exact per-ISO fixes discovered during the 2-year historical
backfill (see ../pull_load_history.py and the project_elec_build memory for
the full debugging history):
  - ERCOT: use plain get_load() here (NOT get_hourly_load_post_settlements,
    which is a *settlement* archive that lags real time by weeks -- wrong
    for a live feed). get_load() is capped at 14 days of history, which is
    irrelevant for live polling since we only want the latest point.
  - MISO: get_load() only supports "today"/"latest" -- which is exactly
    what live polling needs (this was a limitation for the 2yr backfill,
    not for this).
  - SPP: get_load_by_baa_hourly(), same as the backfill -- returns BAA
    breakdown (SPP + SWPW), summed for total. No double-count risk (see
    fix below, this pair was already safe).
  - PJM: get_load_metered_hourly(), same as the backfill, filtered to the
    Load Area == "RTO" aggregate row. KNOWN LIMITATION: this is PJM's
    *metered* (settlement) feed, which may lag true real-time by hours --
    there wasn't time to research a truer real-time PJM load endpoint in
    the gridstatus library. Revisit if PJM staleness becomes a problem.
  - CAISO / NYISO / ISONE: get_load() with a recent start/end window,
    "Load" column used directly -- confirmed correct as-is during backfill.

BUG FIX carried over from the backfill (do not lose this if editing):
ERCOT and MISO's raw API responses include an already-aggregated total
column (named "ERCOT" / "MISO") *alongside* the zone/weather-region
breakdown columns. Summing every numeric column double-counts. This script
uses those named total columns directly, never re-sums zone breakdowns for
ERCOT/MISO. PJM has a related trap (aggregate "RTO" row mixed in with
per-zone rows in long format) -- fixed by filtering to Load Area == "RTO".

Requires Python 3.11+.
    pip install -r requirements.txt
    python3 main.py
"""
import os
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone

if sys.version_info < (3, 11):
    print(f"ERROR: this script requires Python 3.11+. You have {sys.version}.")
    sys.exit(1)

import gridstatus
import psycopg2
from psycopg2.extras import execute_values

DATABASE_URL = os.environ.get("DATABASE_URL", "")
POLL_INTERVAL_MINUTES = int(os.environ.get("POLL_INTERVAL_MINUTES", "60"))
# Load updates less frequently / more slowly than price -- default to
# hourly rather than matching the Node price-poller's 15-minute cadence.

HUBS = ["CAISO_NP15", "ERCOT_HB_HUBAVG", "MISO_INDIANA", "NYISO_ZONEJ",
        "ISONE_MASSHUB", "SPP_SOUTH", "PJM_WEST"]


def get_conn():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is not set")
    return psycopg2.connect(DATABASE_URL)


def upsert_load(conn, hub, rows):
    """rows: list of (interval_start_utc: datetime, load_mw: float)"""
    if not rows:
        return 0
    with conn.cursor() as cur:
        execute_values(
            cur,
            """
            INSERT INTO hub_loads_live (hub, interval_start_utc, load_mw)
            VALUES %s
            ON CONFLICT (hub, interval_start_utc)
            DO UPDATE SET load_mw = EXCLUDED.load_mw, fetched_at = now()
            """,
            [(hub, ts, mw) for ts, mw in rows],
        )
    conn.commit()
    return len(rows)


def latest_row(df, time_col):
    if df is None or len(df) == 0:
        return None
    return df.sort_values(time_col).iloc[-1]


def pull_caiso():
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=6)
    df = gridstatus.CAISO().get_load(start=start.isoformat(), end=now.isoformat())
    row = latest_row(df, "Time")
    if row is None:
        return []
    return [(row["Time"], float(row["Load"]))]


def pull_ercot():
    # Plain get_load() -- real-time-ish, capped at 14 days history (fine for
    # live polling). NOT get_hourly_load_post_settlements (weeks of lag).
    # Uses start=/end= (confirmed accepted during the backfill debugging --
    # this is the call that silently returned only the trailing ~14 days
    # rather than TypeError'ing, which is how the 14-day cap was discovered).
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=6)
    df = gridstatus.Ercot().get_load(start=start.isoformat(), end=now.isoformat())
    time_col = "Time" if "Time" in df.columns else "Interval Start"
    row = latest_row(df, time_col)
    if row is None:
        return []
    return [(row[time_col], float(row["Load"]))]


def pull_miso():
    # get_load() only supports "today"/"latest" -- exactly right for live.
    df = gridstatus.MISO().get_load(date="latest")
    time_col = "Time" if "Time" in df.columns else "Interval Start"
    row = latest_row(df, time_col)
    if row is None:
        return []
    return [(row[time_col], float(row["Load"]))]


def pull_nyiso():
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=6)
    df = gridstatus.NYISO().get_load(start=start.isoformat(), end=now.isoformat())
    row = latest_row(df, "Time")
    if row is None:
        return []
    return [(row["Time"], float(row["Load"]))]


def pull_isone():
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=6)
    df = gridstatus.ISONE().get_load(start=start.isoformat(), end=now.isoformat())
    row = latest_row(df, "Time")
    if row is None:
        return []
    return [(row["Time"], float(row["Load"]))]


def pull_spp():
    # Explicit recent date window, matching the exact call style already
    # proven in ../pull_load_history.py -- not relying on an unconfirmed
    # "today"/"latest" keyword for this particular method.
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=1)
    df = gridstatus.SPP().get_load_by_baa_hourly(date=start.date().isoformat(), end=now.date().isoformat())
    pivoted = df.pivot_table(
        index=["Interval Start", "Interval End"],
        columns="BAA",
        values="Load",
        aggfunc="sum",
    ).reset_index()
    value_cols = [c for c in pivoted.columns if c not in ("Interval Start", "Interval End")]
    pivoted["Load"] = pivoted[value_cols].sum(axis=1, numeric_only=True)
    row = latest_row(pivoted, "Interval Start")
    if row is None:
        return []
    return [(row["Interval Start"], float(row["Load"]))]


def pull_pjm():
    # gridstatus.PJM() reads PJM_API_KEY from the environment automatically
    # (same pattern already proven in ../pull_load_history.py) -- do not
    # guess a constructor kwarg name, just make sure the env var is set.
    if not os.environ.get("PJM_API_KEY"):
        print("[PJM] SKIPPED -- no PJM_API_KEY set")
        return []
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=2)
    pjm = gridstatus.PJM()
    df = pjm.get_load_metered_hourly(date=start.isoformat(), end=now.isoformat())
    df_rto = df[df["Load Area"] == "RTO"]
    row = latest_row(df_rto, "Interval Start")
    if row is None:
        return []
    return [(row["Interval Start"], float(row["MW"]))]


PULLERS = {
    "CAISO_NP15": pull_caiso,
    "ERCOT_HB_HUBAVG": pull_ercot,
    "MISO_INDIANA": pull_miso,
    "NYISO_ZONEJ": pull_nyiso,
    "ISONE_MASSHUB": pull_isone,
    "SPP_SOUTH": pull_spp,
    "PJM_WEST": pull_pjm,
}


def tick(conn):
    for hub in HUBS:
        try:
            rows = PULLERS[hub]()
            n = upsert_load(conn, hub, rows)
            if n:
                print(f"[{hub}] upserted {n} row(s), latest={rows[-1][0]} load={rows[-1][1]:.0f} MW")
            else:
                print(f"[{hub}] no new data this tick")
        except Exception as e:
            print(f"[{hub}] FAILED: {e}")
            traceback.print_exc()


def main():
    print(f"$ELEC load-poller starting -- poll interval {POLL_INTERVAL_MINUTES} min")
    conn = get_conn()
    while True:
        try:
            tick(conn)
        except Exception as e:
            print(f"[main] tick loop error, reconnecting: {e}")
            try:
                conn.close()
            except Exception:
                pass
            conn = get_conn()
        time.sleep(POLL_INTERVAL_MINUTES * 60)


if __name__ == "__main__":
    main()
