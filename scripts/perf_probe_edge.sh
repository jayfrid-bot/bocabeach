#!/usr/bin/env bash
# Edge-cache probe (docs/benchmarks/2026-10-18-perf/edge-cache.md). Like scripts/perf_probe.sh, but
# splits each request's time to first byte into the connection set-up (TCP + TLS, paid once per
# new connection) and the rest (one round trip + the server's own time), and counts the
# x-edge-cache answers (HIT / STALE / MISS / none). Each request is a new connection, as in
# perf_probe.sh. Usage: scripts/perf_probe_edge.sh [base-url] [runs]
set -euo pipefail
BASE="${1:-https://app.isitbeachday.com}"
RUNS="${2:-10}"
PATHS=(/ /siesta-key /jupiter /boca-raton /api/conditions/boca-raton /api/conditions/siesta-key /api/conditions/jupiter)
med() { printf "%s\n" "$@" | sort -n | awk '{a[NR]=$1} END{print a[int((NR+1)/2)]}'; }
ms() { echo "$1*1000" | bc; }
printf "%-30s %8s %8s %9s %9s  %s\n" path ttfb_p50 ttfb_max setup_p50 after_p50 edge
for p in "${PATHS[@]}"; do
  ttfbs=(); setups=(); afters=(); states=()
  for _ in $(seq "$RUNS"); do
    out=$(curl -s -o /dev/null -D - -H "Accept-Encoding: br" -w "## %{time_appconnect} %{time_starttransfer}\n" "$BASE$p")
    read -r tls ttfb < <(printf "%s\n" "$out" | awk '/^##/{print $2, $3}')
    state=$(printf "%s\n" "$out" | awk 'tolower($1)=="x-edge-cache:"{gsub("\r","",$2); print $2}')
    ttfbs+=("$ttfb"); setups+=("$tls"); afters+=("$(echo "$ttfb-$tls" | bc)"); states+=("${state:--}")
  done
  counts=$(printf "%s\n" "${states[@]}" | sort | uniq -c | awk '{printf "%s=%s ", $2, $1}')
  printf "%-30s %7.0fms %7.0fms %8.0fms %8.0fms  %s\n" "$p" \
    "$(ms "$(med "${ttfbs[@]}")")" "$(ms "$(printf "%s\n" "${ttfbs[@]}" | sort -n | tail -1)")" \
    "$(ms "$(med "${setups[@]}")")" "$(ms "$(med "${afters[@]}")")" "$counts"
done
