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
}

export const HUBS: HubConfig[] = [
  { hub: "ERCOT_HB_HUBAVG", dataset: "ercot_spp_real_time_15_min", location: "HB_HUBAVG", priceField: "spp", isDayAhead: false },
  { hub: "PJM_WEST", dataset: "pjm_lmp_real_time_hourly", location: "WESTERN HUB", priceField: "lmp", isDayAhead: false },
  { hub: "CAISO_NP15", dataset: "caiso_lmp_day_ahead_hourly", location: "TH_NP15_GEN-APND", priceField: "lmp", isDayAhead: true },
  { hub: "MISO_INDIANA", dataset: "miso_lmp_real_time_hourly_ex_post_final", location: "INDIANA.HUB", priceField: "lmp", isDayAhead: false },
  { hub: "NYISO_ZONEJ", dataset: "nyiso_lmp_day_ahead_hourly", location: "N.Y.C.", priceField: "lmp", isDayAhead: true },
  { hub: "ISONE_MASSHUB", dataset: "isone_lmp_real_time_hourly_final", location: ".H.INTERNAL_HUB", priceField: "lmp", isDayAhead: false },
  { hub: "SPP_SOUTH", dataset: "spp_lmp_day_ahead_hourly", location: "SPPSOUTH_HUB", priceField: "lmp", isDayAhead: true },
];

export const HUB_NAMES = HUBS.map((h) => h.hub);
