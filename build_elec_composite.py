"""
$ELEC composite pricing algorithm
----------------------------------
Turns the 7-hub 2yr dataset into a single hourly $ELEC price using:

1. Resample every hub to hourly (ERCOT is 15-min -> mean per hour).
2. Winsorize each hub's price against ITS OWN trailing 30-day (720h) 1st/99th
   percentile band, computed from the PAST only (shifted, no lookahead).
   Early observations (<24h of history) pass through unclipped.
3. Weight each hub inversely to its trailing 30-day realized variance
   (computed on the winsorized series, also shifted to avoid lookahead).
   Hubs with no valid weight yet fall back to equal weighting.
4. At each hour, renormalize weights across whatever hubs have data that
   hour, and take the weighted average -> elec_price.
5. Flag is_provisional = True when fewer than 5 of 7 hubs contributed.
6. Also compute a naive_avg (straight mean of raw, unwinsorized prices)
   for comparison.

Writes:
  - elec_composite_hourly table in x402_7hub_2yr.db
  - elec_composite_hourly.csv in this directory
"""
import sqlite3
import pandas as pd
import numpy as np

DB_PATH = "x402_7hub_2yr.db"
HUBS = ["ERCOT_HB_HUBAVG", "PJM_WEST", "CAISO_NP15", "MISO_INDIANA", "NYISO_ZONEJ", "ISONE_MASSHUB", "SPP_SOUTH"]
WINDOW = 24 * 30  # 30 days in hours
MIN_PERIODS_WINSOR = 24       # need at least 1 day of history to start clipping
MIN_PERIODS_VOL = 48          # need at least 2 days of history to start weighting by vol
PROVISIONAL_THRESHOLD = 5     # need >=5 of 7 hubs to be "full confidence"

con = sqlite3.connect(DB_PATH)
raw = pd.read_sql_query("SELECT hub, interval_start_utc, price_usd_mwh FROM hub_prices", con)
con.close()

raw["interval_start_utc"] = pd.to_datetime(raw["interval_start_utc"], utc=True)
raw["hour"] = raw["interval_start_utc"].dt.floor("h")

# Step 1: resample each hub to hourly mean
hourly = raw.groupby(["hour", "hub"])["price_usd_mwh"].mean().unstack("hub")
hourly = hourly.reindex(columns=HUBS)

full_index = pd.date_range(hourly.index.min(), hourly.index.max(), freq="h", tz="UTC")
hourly = hourly.reindex(full_index)
hourly.index.name = "hour_utc"

# Step 2: winsorize each hub against its own trailing 30d percentile band (shifted)
winsorized = pd.DataFrame(index=hourly.index, columns=HUBS, dtype=float)
bounds_log = {}
for hub in HUBS:
    s = hourly[hub]
    lower = s.rolling(WINDOW, min_periods=MIN_PERIODS_WINSOR).quantile(0.01).shift(1)
    upper = s.rolling(WINDOW, min_periods=MIN_PERIODS_WINSOR).quantile(0.99).shift(1)
    clipped = s.clip(lower=lower, upper=upper)
    # where no bound exists yet (start of series), keep raw value
    clipped = clipped.where(lower.notna() & upper.notna(), s)
    winsorized[hub] = clipped
    bounds_log[hub] = (lower, upper)

# Step 3: trailing 30d volatility (std) on winsorized series, shifted (no lookahead)
rolling_std = pd.DataFrame(index=hourly.index, columns=HUBS, dtype=float)
for hub in HUBS:
    rolling_std[hub] = winsorized[hub].rolling(WINDOW, min_periods=MIN_PERIODS_VOL).std().shift(1)

# inverse-variance weights; fallback to NaN (-> equal weight later) when no vol estimate yet
EPS = 1e-6
inv_var = 1.0 / (rolling_std.pow(2) + EPS)
inv_var = inv_var.where(rolling_std.notna())  # NaN where we don't have a vol estimate yet

# Step 4: per-hour renormalized weighted average, only over hubs with valid winsorized price
results = []
for ts in hourly.index:
    prices = winsorized.loc[ts]
    valid = prices.notna()
    n_valid = int(valid.sum())
    if n_valid == 0:
        results.append((ts, np.nan, 0, True, np.nan))
        continue

    w = inv_var.loc[ts].copy()
    # fallback: any valid hub missing a vol-based weight gets equal weight among the "no-weight" group
    w_valid = w[valid]
    if w_valid.isna().all():
        # no hub has a vol estimate yet -> pure equal weight
        weights = pd.Series(1.0, index=w_valid.index)
    else:
        # hubs missing a vol estimate get the median weight of the hubs that do have one
        fallback = w_valid.dropna().median() if w_valid.notna().any() else 1.0
        weights = w_valid.fillna(fallback)

    weights = weights / weights.sum()
    elec_price = float((prices[valid] * weights).sum())

    naive_avg = float(hourly.loc[ts][valid.reindex(hourly.columns, fill_value=False)].mean())

    is_provisional = n_valid < PROVISIONAL_THRESHOLD
    results.append((ts, elec_price, n_valid, is_provisional, naive_avg))

out = pd.DataFrame(results, columns=["hour_utc", "elec_price", "contracts_included", "is_provisional", "naive_avg"])
out["hour_utc"] = out["hour_utc"].dt.tz_localize(None)
out["elec_price"] = out["elec_price"].round(2)
out["naive_avg"] = out["naive_avg"].round(2)

# write to db
con = sqlite3.connect(DB_PATH)
out.to_sql("elec_composite_hourly", con, if_exists="replace", index=False)
con.close()

out.to_csv("elec_composite_hourly.csv", index=False)

print(f"Rows: {len(out)}")
print(f"NaN elec_price rows: {out['elec_price'].isna().sum()}")
print(f"Provisional hours: {out['is_provisional'].sum()} ({out['is_provisional'].mean()*100:.1f}%)")
print(out.describe())
print("\nFirst 5:")
print(out.head())
print("\nLast 5:")
print(out.tail())
