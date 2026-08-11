"""
$ELEC -- Load-Weighted Composite Price Builder
------------------------------------------------
Per user's explicit pivot: weight each hub's price by that ISO's total
system-wide load (not hub-specific load), renormalized hour-by-hour across
whichever ISOs have valid data.

IMPORTANT bug fixes applied here (found while auditing the raw load CSVs):
  - ERCOT: the "Load" column in ercot_load_2yr.csv double-counts (it's
    sum-of-zones PLUS the already-aggregated "ERCOT" column). Real total
    load is the "ERCOT" column alone.
  - MISO: same double-counting bug. Real total load is the "MISO" column
    alone, not "Load".
  - PJM: get_load_metered_hourly() returns one row per zone PER HOUR plus
    an aggregate row where Load Area == "RTO" that IS the real total.
    Must filter to Load Area == "RTO", not sum all zone rows (that would
    double count too).
  - SPP: "Load" = SPP + SWPW (two distinct non-overlapping BAAs) -- this
    one was fine as computed.
  - CAISO / NYISO / ISONE: "Load" column from get_load() is correct as-is.

Output: elec_composite_loadweighted_hourly table in x402_7hub_2yr.db,
plus elec_loadweighted_hourly.csv
"""
import pandas as pd
import sqlite3

ISO_TO_HUB = {
    "CAISO": "CAISO_NP15",
    "ERCOT": "ERCOT_HB_HUBAVG",
    "MISO": "MISO_INDIANA",
    "NYISO": "NYISO_ZONEJ",
    "ISONE": "ISONE_MASSHUB",
    "SPP": "SPP_SOUTH",
    "PJM": "PJM_WEST",
}

def hourly_load(df, time_col, load_col, tz_naive_utc=True):
    df = df.copy()
    df[time_col] = pd.to_datetime(df[time_col], utc=True)
    df = df.set_index(time_col)
    hourly = df[load_col].resample("h").mean()
    return hourly

print("Loading + fixing raw load CSVs...")

loads = {}

# CAISO -- 5-min, "Time" column, "Load" is correct as-is
df = pd.read_csv("caiso_load_2yr.csv")
loads["CAISO"] = hourly_load(df, "Time", "Load")
print(f"  CAISO: {len(loads['CAISO'])} hourly points")

# ERCOT -- hourly already; use "ERCOT" column (real total), not "Load" (2x bug)
df = pd.read_csv("ercot_load_2yr.csv")
loads["ERCOT"] = hourly_load(df, "Interval Start", "ERCOT")
print(f"  ERCOT: {len(loads['ERCOT'])} hourly points (using 'ERCOT' col, not buggy 'Load')")

# MISO -- hourly already; use "MISO" column (real total), not "Load" (2x bug)
df = pd.read_csv("miso_load_2yr.csv")
loads["MISO"] = hourly_load(df, "Interval Start", "MISO")
print(f"  MISO: {len(loads['MISO'])} hourly points (using 'MISO' col, not buggy 'Load')")

# NYISO -- 5-min, "Time" column, "Load" correct as-is
df = pd.read_csv("nyiso_load_2yr.csv")
loads["NYISO"] = hourly_load(df, "Time", "Load")
print(f"  NYISO: {len(loads['NYISO'])} hourly points")

# ISONE -- 5-min, "Time" column, "Load" correct as-is
df = pd.read_csv("isone_load_2yr.csv")
loads["ISONE"] = hourly_load(df, "Time", "Load")
print(f"  ISONE: {len(loads['ISONE'])} hourly points")

# SPP -- hourly already, "Load" = SPP + SWPW, correct as-is
df = pd.read_csv("spp_load_2yr.csv")
loads["SPP"] = hourly_load(df, "Interval Start", "Load")
print(f"  SPP: {len(loads['SPP'])} hourly points")

# PJM -- hourly already, long format (one row per zone per hour). Filter to
# the "RTO" aggregate row only -- that IS the real system total.
df = pd.read_csv("pjm_load_2yr.csv")
df_rto = df[df["Load Area"] == "RTO"]
loads["PJM"] = hourly_load(df_rto, "Interval Start", "MW")
print(f"  PJM: {len(loads['PJM'])} hourly points (RTO total row only, {df_rto['Interval Start'].min()} -> {df_rto['Interval Start'].max()})")

# ---- Build wide load table, hub-named columns -------------------------------
load_df = pd.DataFrame({ISO_TO_HUB[iso]: s for iso, s in loads.items()})
load_df.index.name = "hour_utc"
print(f"\nLoad table shape: {load_df.shape}, range {load_df.index.min()} -> {load_df.index.max()}")
print("Non-null counts per hub:")
print(load_df.count())

# ---- Pull hourly price data from hub_prices ----------------------------------
con = sqlite3.connect("x402_7hub_2yr.db")
price_df = pd.read_sql("SELECT hub, interval_start_utc, price_usd_mwh FROM hub_prices", con)
price_df["interval_start_utc"] = pd.to_datetime(price_df["interval_start_utc"], utc=True)
price_df["hour_utc"] = price_df["interval_start_utc"].dt.floor("h")
price_hourly = price_df.groupby(["hour_utc", "hub"])["price_usd_mwh"].mean().unstack("hub")
print(f"\nPrice table shape: {price_hourly.shape}, range {price_hourly.index.min()} -> {price_hourly.index.max()}")

# ---- Align on common hourly index --------------------------------------------
common_idx = price_hourly.index.intersection(load_df.index)
price_hourly = price_hourly.reindex(common_idx).sort_index()
load_df = load_df.reindex(common_idx).sort_index()

hubs = list(ISO_TO_HUB.values())

# ---- Compute load-weighted composite, renormalizing across available hubs ---
valid = price_hourly[hubs].notna() & load_df[hubs].notna() & (load_df[hubs] > 0)
weights_raw = load_df[hubs].where(valid, 0.0)
weight_sum = weights_raw.sum(axis=1)
weights_norm = weights_raw.div(weight_sum, axis=0)

elec_price = (weights_norm[hubs] * price_hourly[hubs].fillna(0)).sum(axis=1)
elec_price[weight_sum == 0] = pd.NA

n_hubs_available = valid.sum(axis=1)
naive_avg = price_hourly[hubs].mean(axis=1)

out = pd.DataFrame({
    "hour_utc": common_idx,
    "elec_price_loadweighted": elec_price.values,
    "naive_avg_price": naive_avg.values,
    "n_hubs_available": n_hubs_available.values,
})
for h in hubs:
    out[f"weight_{h}"] = weights_norm[h].values
    out[f"price_{h}"] = price_hourly[h].values
    out[f"load_{h}"] = load_df[h].values

out = out.dropna(subset=["elec_price_loadweighted"])
out["hour_utc"] = out["hour_utc"].astype(str)

print(f"\nFinal output: {len(out)} hourly rows")
print(out[["hour_utc", "elec_price_loadweighted", "naive_avg_price", "n_hubs_available"]].head())
print(out[["hour_utc", "elec_price_loadweighted", "naive_avg_price", "n_hubs_available"]].tail())

# distribution of hub coverage
print("\nHours by n_hubs_available:")
print(out["n_hubs_available"].value_counts().sort_index())

# ---- Save ---------------------------------------------------------------------
out.to_sql("elec_composite_loadweighted_hourly", con, if_exists="replace", index=False)
con.commit()
con.close()

out.to_csv("elec_loadweighted_hourly.csv", index=False)
print("\nSaved elec_composite_loadweighted_hourly table + elec_loadweighted_hourly.csv")
