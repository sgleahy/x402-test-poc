"""
$ELEC -- 2-Year Load History Pull (7 ISOs, gridstatus open-source library)
---------------------------------------------------------------------------
v3 -- after two rounds of fixes:
  - ERCOT: plain get_load() only supports last 14 days. Switched to
    get_hourly_load_post_settlements(), ERCOT's actual historical archive
    (no auth, no day limit). Returns weather-zone breakdown; we sum for total.
  - SPP: get_load() was chunking by 5-MINUTE intervals -> 210,240 requests
    for 2 years (7+ hours). Switched to get_load_by_baa_hourly(), which
    chunks by DAY -> 731 requests. Returns by-BAA breakdown; we sum for total.
  - MISO: get_load() only supports "today". Uses get_zonal_load_hourly()
    instead, which supports date ranges. Returns zonal breakdown; we sum.
  - CAISO / NYISO / ISONE: unchanged, these already work.
  - If you were hitting SSL certificate errors, run "Install Certificates.command"
    from your Python install folder in Applications first.

Requires Python 3.11+. Run locally:
    pip install gridstatus
    python3 pull_load_history.py
"""
import sys
import os

if sys.version_info < (3, 11):
    print(f"ERROR: this script requires Python 3.11+. You have {sys.version}.")
    sys.exit(1)

import pandas as pd
import gridstatus

START = "2024-08-05"
END = "2026-08-05"


def save(df, outfile, label):
    df.to_csv(outfile, index=False)
    print(f"[{label}] saved {outfile} ({len(df)} rows)")


def sum_zone_columns(df, id_cols, label):
    """Sum all non-id numeric columns into a single 'Load' column."""
    value_cols = [c for c in df.columns if c not in id_cols]
    df["Load"] = df[value_cols].sum(axis=1, numeric_only=True)
    print(f"[{label}] summed {len(value_cols)} zone/BAA columns into total Load")
    return df


# ---- CAISO: start/end with string dates ------------------------------------
outfile = "caiso_load_2yr.csv"
if os.path.exists(outfile):
    print(f"[CAISO] {outfile} already exists, skipping.")
else:
    print("[CAISO] pulling load...")
    try:
        df = gridstatus.CAISO().get_load(start=START, end=END)
        save(df, outfile, "CAISO")
    except Exception as e:
        print(f"[CAISO] FAILED: {e}")

# ---- ERCOT: use the real historical archive, not the 14-day-limited get_load
outfile = "ercot_load_2yr.csv"
if os.path.exists(outfile) and os.path.getsize(outfile) > 1_000_000:
    print(f"[ERCOT] {outfile} looks complete already, skipping.")
else:
    print("[ERCOT] pulling load from historical archive (by year)...")
    try:
        df = gridstatus.Ercot().get_hourly_load_post_settlements(date=START, end=END)
        id_cols = [c for c in df.columns if not pd.api.types.is_numeric_dtype(df[c])]
        df = sum_zone_columns(df, id_cols, "ERCOT")
        save(df, outfile, "ERCOT")
    except Exception as e:
        print(f"[ERCOT] FAILED: {e}")

# ---- MISO: get_zonal_load_hourly instead of get_load -----------------------
outfile = "miso_load_2yr.csv"
if os.path.exists(outfile):
    print(f"[MISO] {outfile} already exists, skipping.")
else:
    print("[MISO] pulling zonal hourly load (will sum zones for total)...")
    try:
        df = gridstatus.MISO().get_zonal_load_hourly(date=START, end=END)
        id_cols = [c for c in df.columns if not pd.api.types.is_numeric_dtype(df[c])]
        df = sum_zone_columns(df, id_cols, "MISO")
        save(df, outfile, "MISO")
    except Exception as e:
        print(f"[MISO] FAILED: {e}")

# ---- NYISO / ISONE: already succeeded, skip if present ---------------------
for label, iso_cls, outfile in [
    ("NYISO", gridstatus.NYISO, "nyiso_load_2yr.csv"),
    ("ISONE", gridstatus.ISONE, "isone_load_2yr.csv"),
]:
    if os.path.exists(outfile):
        print(f"[{label}] {outfile} already exists, skipping.")
    else:
        print(f"[{label}] pulling load...")
        try:
            df = iso_cls().get_load(start=START, end=END)
            save(df, outfile, label)
        except Exception as e:
            print(f"[{label}] FAILED: {e}")

# ---- SPP: get_load_by_baa_hourly (daily chunks, not 5-min) -----------------
outfile = "spp_load_2yr.csv"
if os.path.exists(outfile):
    print(f"[SPP] {outfile} already exists, skipping.")
else:
    print("[SPP] pulling hourly load by BAA (day-by-day, ~731 requests)...")
    try:
        df = gridstatus.SPP().get_load_by_baa_hourly(date=START, end=END)
        # long format: one row per (Interval Start, BAA) -- pivot and sum
        pivoted = df.pivot_table(
            index=["Interval Start", "Interval End"],
            columns="BAA",
            values="Load",
            aggfunc="sum",
        ).reset_index()
        id_cols = ["Interval Start", "Interval End"]
        pivoted = sum_zone_columns(pivoted, id_cols, "SPP")
        save(pivoted, outfile, "SPP")
    except Exception as e:
        print(f"[SPP] FAILED: {e}")

# ---- PJM: needs the free API key. Chunked into 6-month pieces because
# get_load_metered_hourly() sends the whole range as ONE request (no
# automatic splitting), and PJM's API 400s on a 2-year-wide request.
outfile = "pjm_load_2yr.csv"
if os.path.exists(outfile):
    print(f"[PJM] {outfile} already exists, skipping.")
elif not os.getenv("PJM_API_KEY"):
    print("[PJM] SKIPPED -- no PJM_API_KEY set in this session.")
else:
    print("[PJM] pulling hourly metered load in 6-month chunks...")
    chunk_starts = pd.date_range(START, END, freq="6MS", inclusive="left")
    chunk_bounds = list(chunk_starts) + [pd.Timestamp(END)]
    chunks = []
    pjm = gridstatus.PJM()
    for i in range(len(chunk_bounds) - 1):
        c_start, c_end = chunk_bounds[i], chunk_bounds[i + 1]
        print(f"  [PJM] chunk {i + 1}/{len(chunk_bounds) - 1}: {c_start.date()} -> {c_end.date()}")
        try:
            df_chunk = pjm.get_load_metered_hourly(date=c_start, end=c_end)
            chunks.append(df_chunk)
            print(f"  [PJM] chunk {i + 1} ok ({len(df_chunk)} rows)")
        except Exception as e:
            print(f"  [PJM] chunk {i + 1} FAILED: {e}")

    if chunks:
        df = pd.concat(chunks, ignore_index=True)
        save(df, outfile, "PJM")
    else:
        print("[PJM] FAILED: no chunks succeeded.")

print("\nDone.")
