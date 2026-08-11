"""
$ELEC -- add winsorization on top of the load-weighted composite.
--------------------------------------------------------------------
Per-hub outlier capping: each hub's raw price is capped to its own trailing
30-day 1st/99th percentile band (shifted by 1 hour, no lookahead) before
being fed into the load-weighted average. Load weights themselves are
untouched (load isn't the thing spiking).

Reads the already-built elec_composite_loadweighted_hourly table (has raw
per-hub price + load-share weight columns), adds:
  - price_<hub>_winsorized: capped price
  - elec_price_final: load-weighted average of winsorized prices
  - n_capped: how many of the 7 hubs got capped that hour
"""
import pandas as pd
import sqlite3

HUBS = ["CAISO_NP15", "ERCOT_HB_HUBAVG", "MISO_INDIANA", "NYISO_ZONEJ",
        "ISONE_MASSHUB", "SPP_SOUTH", "PJM_WEST"]

WINDOW = 24 * 30      # 30 days in hours
MIN_PERIODS = 24      # need at least 1 day of history before winsorizing kicks in

con = sqlite3.connect("x402_7hub_2yr.db")
df = pd.read_sql("SELECT * FROM elec_composite_loadweighted_hourly", con)
df["hour_utc"] = pd.to_datetime(df["hour_utc"])
df = df.set_index("hour_utc").sort_index()

n_capped = pd.Series(0, index=df.index)

for hub in HUBS:
    price_col = f"price_{hub}"
    s = df[price_col]
    lower = s.rolling(WINDOW, min_periods=MIN_PERIODS).quantile(0.01).shift(1)
    upper = s.rolling(WINDOW, min_periods=MIN_PERIODS).quantile(0.99).shift(1)
    capped = s.clip(lower=lower, upper=upper)
    # where we don't yet have enough trailing history, fall back to raw (no capping)
    capped = capped.where(lower.notna() & upper.notna(), s)
    was_capped = (s != capped) & s.notna()
    n_capped = n_capped.add(was_capped.astype(int), fill_value=0)
    df[f"price_{hub}_winsorized"] = capped

# load-weighted average using winsorized prices, same weights as before
weight_cols = {h: f"weight_{h}" for h in HUBS}
wsum_check = df[[weight_cols[h] for h in HUBS]].sum(axis=1)

elec_final = pd.Series(0.0, index=df.index)
for h in HUBS:
    elec_final += df[weight_cols[h]].fillna(0) * df[f"price_{h}_winsorized"].fillna(0)

df["elec_price_final"] = elec_final.where(wsum_check > 0)
df["n_capped"] = n_capped.astype(int)

print("Capping summary:")
print(df["n_capped"].value_counts().sort_index())
print()
print("Hours where >=1 hub was capped:", (df["n_capped"] > 0).sum(), "of", len(df))
print()

comp = df[["elec_price_loadweighted", "elec_price_final", "naive_avg_price", "n_capped"]].copy()
print("Biggest differences (load-weighted vs final winsorized):")
comp["diff"] = (comp["elec_price_loadweighted"] - comp["elec_price_final"]).abs()
print(comp.sort_values("diff", ascending=False).head(15))

print()
print("Overall stats:")
print(df[["elec_price_loadweighted", "elec_price_final", "naive_avg_price"]].describe())
print()
print("Correlation elec_price_final vs naive_avg_price:", df["elec_price_final"].corr(df["naive_avg_price"]))
print("Correlation elec_price_final vs elec_price_loadweighted (pre-winsor):", df["elec_price_final"].corr(df["elec_price_loadweighted"]))

# save
out = df.reset_index()
out["hour_utc"] = out["hour_utc"].astype(str)
out.to_sql("elec_composite_final", con, if_exists="replace", index=False)
con.commit()
con.close()

out.to_csv("elec_final_hourly.csv", index=False)
print("\nSaved elec_composite_final table + elec_final_hourly.csv")
