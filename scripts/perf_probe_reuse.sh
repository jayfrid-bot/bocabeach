#!/usr/bin/env bash
# Time to first byte on an already-open connection (docs/benchmarks/2026-10-18-perf/edge-cache.md).
# A browser pays the TCP + TLS set-up once and then reuses the connection; this measures that
# second-and-later request: one network round trip plus the server's own time. Each round is
# ONE curl run that fetches every path in turn over one connection, so network jitter hits all
# paths alike. A static file (/icon-192.png, served by Cloudflare without running the Worker) is
# the floor: a path that matches it costs the server next to nothing.
# Usage: scripts/perf_probe_reuse.sh [base-url] [rounds]
set -euo pipefail
BASE="${1:-https://app.isitbeachday.com}"
ROUNDS="${2:-20}"
PATHS=(/icon-192.png / /siesta-key /jupiter /boca-raton /api/conditions/boca-raton /api/conditions/siesta-key /api/conditions/jupiter)
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
# A first request opens the connection; it is not counted. --next keeps the connection open and
# gives every path its own output line.
args=(-s -H "Accept-Encoding: br" -o /dev/null -w "warmup %{time_starttransfer}\n" "$BASE/icon-192.png")
for p in "${PATHS[@]}"; do args+=(--next -s -H "Accept-Encoding: br" -o /dev/null -w "$p %{time_starttransfer} %{num_connects}\n" "$BASE$p"); done
for _ in $(seq "$ROUNDS"); do curl "${args[@]}" >> "$tmp"; done
printf "%-30s %7s %7s %7s %7s %s\n" path min p25 p50 p90 new_conns
for p in "${PATHS[@]}"; do
  awk -v p="$p" '$1==p {print $2*1000, $3}' "$tmp" | sort -n | awk -v p="$p" '
    {a[NR]=$1; c+=$2} END {printf "%-30s %5.0fms %5.0fms %5.0fms %5.0fms %d\n", p, a[1], a[int(NR*0.25)+1], a[int((NR+1)/2)], a[int(NR*0.9)], c}'
done
