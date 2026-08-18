/**
 * Shared hub metadata for the 7-hub $ELEC composite. Source of truth for
 * both the GridStatus.io hosted-API price poller (price-poller.ts) and the
 * Python load-poller (../load-poller/main.py -- keep in sync manually,
 * Python can't import this file).
 *
 * dataset/location/priceField values confirmed working against the
 * GridStatus.io v1 API during the 2-year historical backfill
 * (pull_2yr_history.sh, build_7hub_db.py) -- see project_elec_build memory
 * for the "confirmed location strings" discovery notes.
 */
export interface HubConfig {
  hub: string;
  dataset: string;
  location: string;
  priceField: "lmp" | "spp";
  /** day-ahead datasets publish once/day -- need a wider poll lookback than real-time ones */
  isDayAhead: boolean;
  /**
   * Max expected publish lag for this hub's price dataset, in hours. Used as
   * BOTH the price-poller's lookback window (price-poller.ts) AND the
   * composite's staleness cutoff for counting this hub as "available"
   * (composite.ts) -- these two have to agree, otherwise the poller can
   * successfully fetch and store a row that the composite then immediately
   * rejects as stale.
   *
   * ERCOT's 15-min feed is genuinely real-time (6h is generous headroom).
   * CAISO/NYISO/SPP are day-ahead publications -- the *correct* current
   * price can legitimately be up to ~a day old relative to "now", so 48h.
   * ISONE ("_final"), MISO ("_ex_post_final"), and PJM (name says
   * "real_time_hourly" but GridStatus.io's own dataset page confirms it
   * "is published daily with a day of lag time") are all settled/finalized
   * feeds despite their real-time-sounding names -- confirmed empirically
   * (all three showed zero rows ever stored under the old 6h lookback) and
   * via GridStatus.io's docs for PJM specifically. 30h covers a day of lag
   * plus buffer.
   */
  maxLagHours: number;
}

export const HUBS: HubConfig[] = [
  { hub: "ERCOT_HB_HUBAVG", dataset: "ercot_spp_real_time_15_min", location: "HB_HUBAVG", priceField: "spp", isDayAhead: false, maxLagHours: 6 },
  { hub: "PJM_WEST", dataset: "pjm_lmp_real_time_hourly", location: "WESTERN HUB", priceField: "lmp", isDayAhead: false, maxLagHours: 30 },
  { hub: "CAISO_NP15", dataset: "caiso_lmp_day_ahead_hourly", location: "TH_NP15_GEN-APND", priceField: "lmp", isDayAhead: true, maxLagHours: 48 },
  { hub: "MISO_INDIANA", dataset: "miso_lmp_real_time_hourly_ex_post_final", location: "INDIANA.HUB", priceField: "lmp", isDayAhead: false, maxLagHours: 3 },
  { hub: "NYISO_ZONEJ", dataset: "nyiso_lmp_day_ahead_hourly", location: "N.Y.C.", priceField: "lmp", isDayAhead: true, maxLagHours: 48 },
  { hub: "ISONE_MASSHUB", dataset: "isone_lmp_real_time_hourly_final", location: ".H.INTERNAL_HUB", priceField: "lmp", isDayAhead: false, maxLagHours: 30 },
  { hub: "SPP_SOUTH", dataset: "spp_lmp_day_ahead_hourly", location: "SPPSOUTH_HUB", priceField: "lmp", isDayAhead: true, maxLagHours: 48 },
];

export const HUB_NAMES = HUBS.map((h) => h.hub);
