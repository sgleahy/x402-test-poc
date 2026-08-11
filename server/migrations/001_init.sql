-- $ELEC live backend schema (Railway Postgres)
-- Run once against the DATABASE_URL Railway provisions for this service.
-- psql "$DATABASE_URL" -f migrations/001_init.sql

CREATE TABLE IF NOT EXISTS hub_prices_live (
  hub TEXT NOT NULL,
  interval_start_utc TIMESTAMPTZ NOT NULL,
  price_usd_mwh DOUBLE PRECISION NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (hub, interval_start_utc)
);
CREATE INDEX IF NOT EXISTS idx_hub_prices_live_hub_time
  ON hub_prices_live (hub, interval_start_utc DESC);

CREATE TABLE IF NOT EXISTS hub_loads_live (
  hub TEXT NOT NULL,
  interval_start_utc TIMESTAMPTZ NOT NULL,
  load_mw DOUBLE PRECISION NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (hub, interval_start_utc)
);
CREATE INDEX IF NOT EXISTS idx_hub_loads_live_hub_time
  ON hub_loads_live (hub, interval_start_utc DESC);

CREATE TABLE IF NOT EXISTS elec_composite_live (
  hour_utc TIMESTAMPTZ PRIMARY KEY,
  elec_price DOUBLE PRECISION NOT NULL,
  n_hubs_available INTEGER NOT NULL,
  n_hubs_capped INTEGER NOT NULL,
  detail JSONB,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_elec_composite_live_hour
  ON elec_composite_live (hour_utc DESC);
