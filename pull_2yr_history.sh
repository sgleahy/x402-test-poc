#!/bin/bash
# ============================================================================
# $ELEC — 2-Year Historical Pull for 7 Confirmed Hubs (GridStatus.io API)
# ============================================================================
# Run this on a Mac with normal internet access, from inside the
# x402-test-poc/ directory (or adjust OUTPUT_DIR below).
#
# Produces 8 JSON files (7 hubs, ERCOT split into 2 chunks because its
# 15-min granularity over 2 years is ~70,000 rows, over the API's safe
# per-request limit):
#   ercot_hubavg_2yr_part1.json   ercot_hubavg_2yr_part2.json
#   pjm_west_2yr.json
#   caiso_np15_2yr.json
#   miso_indiana_2yr.json
#   nyiso_zonej_2yr.json
#   isone_masshub_2yr.json
#   spp_south_2yr.json
#
# Uses BSD date syntax (macOS). Does NOT work as-is on Linux/GNU date.
# ============================================================================

set -u

# Reads from the GRIDSTATUS_API_KEY environment variable -- never hardcode a
# real key here, this file goes into git. Run as:
#   GRIDSTATUS_API_KEY=your_real_key ./pull_2yr_history.sh
if [ -z "${GRIDSTATUS_API_KEY:-}" ]; then
  echo "ERROR: set GRIDSTATUS_API_KEY first, e.g.:"
  echo "  GRIDSTATUS_API_KEY=your_real_key ./pull_2yr_history.sh"
  exit 1
fi
API_KEY="${GRIDSTATUS_API_KEY}"
BASE="https://api.gridstatus.io/v1/datasets"
OUTPUT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---- Date windows (BSD/macOS date arithmetic) -----------------------------
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TWO_YEARS_AGO=$(date -u -v-730d +%Y-%m-%dT%H:%M:%SZ)
ONE_YEAR_AGO=$(date -u -v-365d +%Y-%m-%dT%H:%M:%SZ)

echo "Window: ${TWO_YEARS_AGO}  ->  ${NOW}"
echo "Output directory: ${OUTPUT_DIR}"
echo ""

# Helper: pull one hub/window and report basic result info.
pull() {
  local label="$1"
  local dataset="$2"
  local location_path="$3"   # already percent-encoded for the URL path segment
  local start="$4"
  local end="$5"
  local limit="$6"
  local outfile="$7"

  echo "  -> ${label} ..."
  curl -sS -G "${BASE}/${dataset}/query/location/${location_path}" \
    --data-urlencode "api_key=${API_KEY}" \
    --data-urlencode "start_time=${start}" \
    --data-urlencode "end_time=${end}" \
    --data-urlencode "limit=${limit}" \
    -o "${OUTPUT_DIR}/${outfile}"

  if [ -s "${OUTPUT_DIR}/${outfile}" ]; then
    local bytes
    bytes=$(wc -c < "${OUTPUT_DIR}/${outfile}" | tr -d ' ')
    echo "     saved ${outfile} (${bytes} bytes)"
  else
    echo "     WARNING: ${outfile} is empty or was not written"
  fi
}

# ---- 1. ERCOT HB_HUBAVG (15-min, ~70k rows/2yr -> split into 2 windows) --
echo "[1/7] ERCOT HB_HUBAVG (real-time 15-min, chunked)"
pull "ERCOT part 1 (2yr ago -> 1yr ago)" \
  "ercot_spp_real_time_15_min" "HB_HUBAVG" \
  "${TWO_YEARS_AGO}" "${ONE_YEAR_AGO}" 40000 \
  "ercot_hubavg_2yr_part1.json"

pull "ERCOT part 2 (1yr ago -> now)" \
  "ercot_spp_real_time_15_min" "HB_HUBAVG" \
  "${ONE_YEAR_AGO}" "${NOW}" 40000 \
  "ercot_hubavg_2yr_part2.json"
echo ""

# ---- 2. PJM Western Hub (hourly) ------------------------------------------
echo "[2/7] PJM Western Hub (real-time hourly)"
pull "PJM Western Hub" \
  "pjm_lmp_real_time_hourly" "WESTERN%20HUB" \
  "${TWO_YEARS_AGO}" "${NOW}" 20000 \
  "pjm_west_2yr.json"
echo ""

# ---- 3. CAISO NP15 Trading Hub (day-ahead hourly) --------------------------
# NOTE: plain "NP15" does NOT resolve on caiso_lmp_day_ahead_hourly.
# The confirmed working location string is "TH_NP15_GEN-APND" (location_type
# = "Trading Hub").
echo "[3/7] CAISO NP15 (day-ahead hourly, location = TH_NP15_GEN-APND)"
pull "CAISO NP15 (TH_NP15_GEN-APND)" \
  "caiso_lmp_day_ahead_hourly" "TH_NP15_GEN-APND" \
  "${TWO_YEARS_AGO}" "${NOW}" 20000 \
  "caiso_np15_2yr.json"
echo ""

# ---- 4. MISO Indiana Hub (real-time hourly ex post final) ------------------
# NOTE: "INDIANA HUB" (space) and "INDIANA_HUB" do NOT resolve. The
# confirmed working location string uses a dot separator: "INDIANA.HUB".
echo "[4/7] MISO Indiana Hub (real-time hourly ex post final, location = INDIANA.HUB)"
pull "MISO Indiana Hub (INDIANA.HUB)" \
  "miso_lmp_real_time_hourly_ex_post_final" "INDIANA.HUB" \
  "${TWO_YEARS_AGO}" "${NOW}" 20000 \
  "miso_indiana_2yr.json"
echo ""

# ---- 5. NYISO Zone J / N.Y.C. (day-ahead hourly) ----------------------------
echo "[5/7] NYISO Zone J (day-ahead hourly, location = N.Y.C.)"
pull "NYISO N.Y.C." \
  "nyiso_lmp_day_ahead_hourly" "N.Y.C." \
  "${TWO_YEARS_AGO}" "${NOW}" 20000 \
  "nyiso_zonej_2yr.json"
echo ""

# ---- 6. ISONE Mass/Internal Hub (real-time hourly final) -------------------
# NOTE: "4000" (the node ID that worked on the 5-min dataset) does NOT
# resolve on isone_lmp_real_time_hourly_final. The confirmed working
# location string is ".H.INTERNAL_HUB" (location_type = "HUB") — this is
# ISO-NE's system-wide Hub price point, commonly referred to as Mass Hub.
echo "[6/7] ISONE Hub (real-time hourly final, location = .H.INTERNAL_HUB)"
pull "ISONE Hub (.H.INTERNAL_HUB)" \
  "isone_lmp_real_time_hourly_final" ".H.INTERNAL_HUB" \
  "${TWO_YEARS_AGO}" "${NOW}" 20000 \
  "isone_masshub_2yr.json"
echo ""

# ---- 7. SPP South Hub (day-ahead hourly) ------------------------------------
# NOTE: "SOUTH HUB", "SOUTH_HUB", "SPP SOUTH HUB" do NOT resolve. The
# confirmed working location string is "SPPSOUTH_HUB" (location_type = "Hub").
echo "[7/7] SPP South Hub (day-ahead hourly, location = SPPSOUTH_HUB)"
pull "SPP South Hub (SPPSOUTH_HUB)" \
  "spp_lmp_day_ahead_hourly" "SPPSOUTH_HUB" \
  "${TWO_YEARS_AGO}" "${NOW}" 20000 \
  "spp_south_2yr.json"
echo ""

echo "Done. 8 JSON files should now be in: ${OUTPUT_DIR}"
echo "Next step: python3 build_7hub_db.py"
