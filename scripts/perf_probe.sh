#!/usr/bin/env bash
# Repeatable load-time probe for Is It Beach Day (see docs/benchmarks/2026-10-18-perf/).
# Measures, per URL, N cold-ish requests from this machine: time to first byte and total,
# plus the compressed transfer size. Usage: scripts/perf_probe.sh [base-url] [runs]
set -euo pipefail
BASE="${1:-https://app.isitbeachday.com}"
RUNS="${2:-5}"
PATHS=(/ /siesta-key /jupiter /api/conditions/boca-raton /api/conditions/siesta-key /api/conditions/jupiter)
printf "%-32s %8s %8s %8s %10s\n" path ttfb_p50 ttfb_max total_p50 bytes_br
for p in "${PATHS[@]}"; do
  ttfbs=(); totals=(); bytes=0
  for _ in $(seq "$RUNS"); do
    read -r t1 t2 b < <(curl -s -o /dev/null -H "Accept-Encoding: br" -w "%{time_starttransfer} %{time_total} %{size_download}\n" "$BASE$p")
    ttfbs+=("$t1"); totals+=("$t2"); bytes="$b"
  done
  med() { printf "%s\n" "$@" | sort -n | awk '{a[NR]=$1} END{print a[int((NR+1)/2)]}'; }
  mx() { printf "%s\n" "$@" | sort -n | tail -1; }
  printf "%-32s %7.0fms %7.0fms %7.0fms %10s\n" "$p" "$(echo "$(med "${ttfbs[@]}")*1000" | bc)" "$(echo "$(mx "${ttfbs[@]}")*1000" | bc)" "$(echo "$(med "${totals[@]}")*1000" | bc)" "$bytes"
done
