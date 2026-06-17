#!/usr/bin/env python3
"""
Build the static location registries the app resolves against, under
`data/registry/`. Runs OFFLINE of the web app (a one-off / CI build step), does
real network fetches against free public-domain sources, and writes compact,
commit-sized JSON. The web app then resolves a town/beach to its nearest tide
station + buoy by reading these tiny files — so the heavy bulk pulls never touch
Netlify.

Produces:
  data/registry/tide-stations.json  NOAA CO-OPS tide-prediction stations
  data/registry/buoys.json          NDBC buoys + wave/water-temp capability flags
  data/registry/beaches.us.json     USGS GNIS "Beach" features, coastal-filtered
  data/registry/registry.meta.json  build provenance (builtAt, counts, sources)

All sources are free, key-less, public domain. Every fetch is defensive: a
single unreachable source is logged and skipped; the others still write. Mirrors
the stdlib-only, urllib-based, progress-printing style of glm_lightning.py.
"""
import datetime as dt
import io
import json
import math
import os
import re
import sys
import urllib.request
import zipfile

# --- config ----------------------------------------------------------------
TIDES_URL = (
    "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/"
    "stations.json?type=tidepredictions"
)
NDBC_TABLE_URL = "https://www.ndbc.noaa.gov/data/stations/station_table.txt"
NDBC_REALTIME2_URL = "https://www.ndbc.noaa.gov/data/realtime2/"
GNIS_BASE = (
    "https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/"
    "DomesticNames/DomesticNames_{st}_Text.zip"
)

OUT_DIR = os.environ.get(
    "REGISTRY_OUT_DIR",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                 "data", "registry"),
)

# Beach is kept only if within this many km of any tide station (ocean-proximity
# proxy — tide stations sit on the coast). Cheap inland-dropper.
COASTAL_KM = float(os.environ.get("REGISTRY_COASTAL_KM", "5.0"))

# US coastal states/territories, FL first so it is always fully covered. Inland
# states are intentionally excluded — GNIS Beach features there are lakeshores.
COASTAL_STATES = [
    "FL", "GA", "SC", "NC", "VA", "MD", "DE", "NJ", "NY", "CT", "RI", "MA",
    "NH", "ME", "AL", "MS", "LA", "TX", "CA", "OR", "WA", "HI",
]

USER_AGENT = "boca-beach-rats-registry-builder"


# --- net -------------------------------------------------------------------
def _get(url: str, timeout: int = 90) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    return urllib.request.urlopen(req, timeout=timeout).read()


# --- geo (parity with lib/util.ts haversineMiles, in km here) --------------
def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0088  # mean Earth radius (km)
    r = math.radians
    d_lat = r(lat2 - lat1)
    d_lon = r(lon2 - lon1)
    a = (math.sin(d_lat / 2) ** 2
         + math.cos(r(lat1)) * math.cos(r(lat2)) * math.sin(d_lon / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(a))


def round6(n: float) -> float:
    return round(n, 6)


# --- coarse spatial grid for cheap "within COASTAL_KM of a station" tests ---
class CoastGrid:
    """Bucket tide-station coords into ~0.1deg cells so a beach checks only a
    handful of nearby stations instead of all ~3450. Good enough for a 5 km
    proximity test."""

    CELL = 0.1  # degrees (~11 km lat); search the 3x3 block of cells.

    def __init__(self, points: list[tuple[float, float]]):
        self.cells: dict[tuple[int, int], list[tuple[float, float]]] = {}
        for la, lo in points:
            self.cells.setdefault(self._key(la, lo), []).append((la, lo))

    def _key(self, la: float, lo: float) -> tuple[int, int]:
        return (int(math.floor(la / self.CELL)), int(math.floor(lo / self.CELL)))

    def near(self, la: float, lo: float, km: float) -> bool:
        cla, clo = self._key(la, lo)
        for dla in (-1, 0, 1):
            for dlo in (-1, 0, 1):
                for sla, slo in self.cells.get((cla + dla, clo + dlo), ()):
                    if haversine_km(la, lo, sla, slo) <= km:
                        return True
        return False


# --- 1. tide stations ------------------------------------------------------
def parse_tide_stations(raw: bytes) -> list[dict]:
    """Map CO-OPS tidepredictions metadata to {id,name,lat,lon,state}. The API
    field is `lng` -> stored as `lon`."""
    data = json.loads(raw)
    out: list[dict] = []
    for s in data.get("stations", []):
        sid, lat, lng = s.get("id"), s.get("lat"), s.get("lng")
        if sid is None or lat is None or lng is None:
            continue
        out.append({
            "id": str(sid),
            "name": (s.get("name") or "").strip(),
            "lat": round6(float(lat)),
            "lon": round6(float(lng)),
            "state": (s.get("state") or "").strip() or None,
        })
    return out


def build_tide_stations() -> list[dict]:
    print(f"tides: fetching {TIDES_URL}")
    stations = parse_tide_stations(_get(TIDES_URL))
    print(f"tides: parsed {len(stations)} stations")
    return stations


# --- 2. buoys --------------------------------------------------------------
_LOC_RE = re.compile(
    r"([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])"
)


def parse_location(loc: str) -> tuple[float, float] | None:
    """Parse the NDBC LOCATION column, e.g. '25.922 N 89.638 W (...)' to
    decimal (lat, lon). W and S are negative."""
    m = _LOC_RE.search(loc or "")
    if not m:
        return None
    lat = float(m.group(1)) * (-1 if m.group(2) == "S" else 1)
    lon = float(m.group(3)) * (-1 if m.group(4) == "W" else 1)
    return lat, lon


def parse_realtime2_caps(html: bytes) -> dict[str, dict[str, bool]]:
    """From the realtime2 directory listing, flag per-station file presence:
    `<ID>.spec` -> hasWaves, `<ID>.txt` -> hasWaterTemp. Single listing, so no
    per-station HEAD storm."""
    text = html.decode("utf-8", "replace")
    caps: dict[str, dict[str, bool]] = {}
    for sid in re.findall(r'href="([A-Za-z0-9]+)\.spec"', text):
        caps.setdefault(sid.upper(), {"hasWaves": False, "hasWaterTemp": False})
        caps[sid.upper()]["hasWaves"] = True
    for sid in re.findall(r'href="([A-Za-z0-9]+)\.txt"', text):
        caps.setdefault(sid.upper(), {"hasWaves": False, "hasWaterTemp": False})
        caps[sid.upper()]["hasWaterTemp"] = True
    return caps


def parse_buoys(table: bytes, caps: dict[str, dict[str, bool]]) -> list[dict]:
    """Map the pipe-delimited station_table.txt + capability flags to
    {id,name,lat,lon,hasWaves,hasWaterTemp}."""
    out: list[dict] = []
    for line in table.decode("utf-8", "replace").splitlines():
        if not line or line.startswith("#"):
            continue
        cols = line.split("|")
        if len(cols) < 7:
            continue
        sid = cols[0].strip()
        if not sid:
            continue
        coord = parse_location(cols[6])
        if coord is None:
            continue
        lat, lon = coord
        cap = caps.get(sid.upper(), {})
        out.append({
            "id": sid,
            "name": (cols[4] or "").strip(),
            "lat": round6(lat),
            "lon": round6(lon),
            "hasWaves": bool(cap.get("hasWaves", False)),
            "hasWaterTemp": bool(cap.get("hasWaterTemp", False)),
        })
    return out


def build_buoys() -> list[dict]:
    print(f"buoys: fetching {NDBC_TABLE_URL}")
    table = _get(NDBC_TABLE_URL)
    print(f"buoys: fetching realtime2 listing {NDBC_REALTIME2_URL}")
    caps = parse_realtime2_caps(_get(NDBC_REALTIME2_URL))
    buoys = parse_buoys(table, caps)
    waves = sum(1 for b in buoys if b["hasWaves"])
    wtemp = sum(1 for b in buoys if b["hasWaterTemp"])
    print(f"buoys: parsed {len(buoys)} buoys "
          f"({waves} hasWaves, {wtemp} hasWaterTemp from realtime2)")
    return buoys


# --- 3. beaches (GNIS, coastal-filtered) -----------------------------------
def parse_gnis_beaches(raw_txt: str, state: str) -> list[tuple[str, float, float]]:
    """Yield (name, lat, lon) for feature_class == 'Beach' rows of a GNIS
    DomesticNames per-state file (pipe-delimited, header row first).

    GNIS column layout (DomesticNames *_Text.zip, 2026): index 1 feature_name,
    2 feature_class, 5 county_name, 15 prim_lat_dec, 16 prim_long_dec.
    """
    rows: list[tuple[str, float, float]] = []
    lines = raw_txt.splitlines()
    if not lines:
        return rows
    header = lines[0].lstrip("﻿").split("|")
    idx = {name: i for i, name in enumerate(header)}
    i_name = idx.get("feature_name", 1)
    i_class = idx.get("feature_class", 2)
    i_lat = idx.get("prim_lat_dec", 15)
    i_lon = idx.get("prim_long_dec", 16)
    need = max(i_name, i_class, i_lat, i_lon)
    for line in lines[1:]:
        if not line:
            continue
        cols = line.split("|")
        if len(cols) <= need or cols[i_class] != "Beach":
            continue
        try:
            lat = float(cols[i_lat])
            lon = float(cols[i_lon])
        except ValueError:
            continue
        if lat == 0.0 and lon == 0.0:
            continue
        rows.append((cols[i_name].strip(), lat, lon))
    return rows


def build_beaches(coast: CoastGrid) -> tuple[list[dict], dict[str, dict]]:
    """Pull GNIS Beach features per coastal state, keep only those within
    COASTAL_KM of a tide station. Returns (beaches, per-state coverage stats)."""
    beaches: list[dict] = []
    coverage: dict[str, dict] = {}
    for st in COASTAL_STATES:
        url = GNIS_BASE.format(st=st)
        try:
            blob = _get(url)
        except Exception as e:  # noqa: BLE001
            print(f"beaches: WARN {st} fetch failed: {e}", file=sys.stderr)
            coverage[st] = {"status": "fetch-failed", "raw": 0, "kept": 0}
            continue
        try:
            zf = zipfile.ZipFile(io.BytesIO(blob))
            member = next((n for n in zf.namelist()
                           if n.endswith(".txt")), None)
            if member is None:
                raise ValueError("no .txt member in zip")
            raw_txt = zf.read(member).decode("utf-8-sig", "replace")
        except Exception as e:  # noqa: BLE001
            print(f"beaches: WARN {st} unzip/parse failed: {e}", file=sys.stderr)
            coverage[st] = {"status": "unzip-failed", "raw": 0, "kept": 0}
            continue
        raw_rows = parse_gnis_beaches(raw_txt, st)
        kept = 0
        for name, lat, lon in raw_rows:
            if not coast.near(lat, lon, COASTAL_KM):
                continue
            beaches.append({
                "name": name,
                "lat": round6(lat),
                "lon": round6(lon),
                "state": st,
                "source": "GNIS",
                "gnisClass": "Beach",
                "coastalConfirmed": True,
            })
            kept += 1
        coverage[st] = {"status": "ok", "raw": len(raw_rows), "kept": kept}
        print(f"beaches: {st} {len(raw_rows)} Beach features -> {kept} coastal")
    return beaches, coverage


# --- io --------------------------------------------------------------------
def write_json(path: str, obj, compact: bool = True) -> int:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        if compact:
            json.dump(obj, fh, separators=(",", ":"))
        else:
            json.dump(obj, fh, indent=2)
    return os.path.getsize(path)


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    built_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    built_at_iso = built_at.isoformat().replace("+00:00", "Z")

    counts: dict[str, int] = {}
    sources: dict[str, str] = {}
    failures: list[str] = []
    coverage: dict[str, dict] = {}

    # 1. tide stations -- also the coastal-proximity reference for beaches.
    tide_points: list[tuple[float, float]] = []
    try:
        stations = build_tide_stations()
        size = write_json(os.path.join(OUT_DIR, "tide-stations.json"), stations)
        counts["tideStations"] = len(stations)
        sources["tideStations"] = TIDES_URL
        tide_points = [(s["lat"], s["lon"]) for s in stations]
        print(f"wrote tide-stations.json: {len(stations)} ({size/1024:.0f} KB)")
    except Exception as e:  # noqa: BLE001
        print(f"tides: FAILED: {e}", file=sys.stderr)
        failures.append(f"tide-stations: {e}")

    # 2. buoys.
    try:
        buoys = build_buoys()
        size = write_json(os.path.join(OUT_DIR, "buoys.json"), buoys)
        counts["buoys"] = len(buoys)
        sources["buoys"] = f"{NDBC_TABLE_URL} + {NDBC_REALTIME2_URL}"
        print(f"wrote buoys.json: {len(buoys)} ({size/1024:.0f} KB)")
    except Exception as e:  # noqa: BLE001
        print(f"buoys: FAILED: {e}", file=sys.stderr)
        failures.append(f"buoys: {e}")

    # 3. beaches (needs tide stations for the coastal filter).
    if tide_points:
        coast = CoastGrid(tide_points)
        beaches, coverage = build_beaches(coast)
        size = write_json(os.path.join(OUT_DIR, "beaches.us.json"), beaches)
        counts["beaches"] = len(beaches)
        sources["beaches"] = GNIS_BASE.format(st="<ST>")
        print(f"wrote beaches.us.json: {len(beaches)} ({size/1024:.0f} KB)")
    else:
        print("beaches: SKIPPED (no tide stations for coastal filter)",
              file=sys.stderr)
        failures.append("beaches: skipped, tide stations unavailable")

    meta = {
        "builtAt": built_at_iso,
        "version": 1,
        "counts": counts,
        "sources": sources,
        "coastalKm": COASTAL_KM,
        "beachStateCoverage": coverage,
        "failures": failures,
    }
    write_json(os.path.join(OUT_DIR, "registry.meta.json"), meta, compact=False)
    print(f"wrote registry.meta.json: counts={counts} failures={failures}")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
