#!/usr/bin/env python3
"""
Satellite-as-data research spike (bocabeach).

Validates whether Sentinel-2 imagery can supply a "recent conditions" signal
(offshore sargassum coverage, nearshore turbidity/clarity) for beaches that
lack a live camera, using Boca Raton's cam-derived history as ground truth.

See docs/HISTORY_AND_IMAGERY_PLAN.md (Part B) and
docs/reviews/2026-09-20-codex-phase2-history-imagery.md for the question
this spike answers.

Self-contained: reads the STAC catalog + cam history over the network, does
NOT download full scenes (only small windowed COG reads via /vsicurl/), and
writes its outputs to docs/research/.

Usage:
    <venv>/bin/python scripts/research/satellite_spike.py

Requires: pystac-client, rasterio, numpy, pandas, matplotlib
(rasterio wheels bundle GDAL - no separate GDAL install needed on macOS/Linux
wheels; if a wheel isn't available for your platform, try
`pip install rasterio --only-binary :all:` and do NOT attempt to build GDAL
from source for a research spike).
"""

from __future__ import annotations

import json
import math
import statistics
import sys
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

STAC_URL = "https://earth-search.aws.element84.com/v1"
COLLECTION = "sentinel-2-l2a"
CAM_HISTORY_URL = (
    "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/"
    "sargassum-data/cam_seaweed.json"
)

BOCA_LAT = 26.3587
BOCA_LON = -80.0686

DATE_START = "2026-06-01"
DATE_END = "2026-09-22"
SCENE_CLOUD_COVER_MAX = 40.0  # scene-level eo:cloud_cover filter (STAC query)
CROP_CLOUD_FRACTION_MAX = 0.20  # per-box SCL cloud/cirrus fraction reject threshold

# Box geometry, in meters, relative to the anchor point in its local UTM CRS.
# Boca Raton is an east-facing shoreline: +x (easting) points offshore.
NEARSHORE_X = (0, 300)       # 0-300m offshore
OFFSHORE_X = (300, 3000)     # 300m-3km offshore
ALONGSHORE_Y = (-500, 500)   # +/-500m north-south => ~1km along shoreline

# Sentinel-2 L2A band center wavelengths (nm), used for FAI.
LAMBDA_RED = 665.0
LAMBDA_NIR = 842.0
LAMBDA_SWIR = 1610.0

FAI_RAFT_THRESHOLD = 0.02  # literature range ~0.01-0.03 for sargassum rafts
NDVI_RAFT_THRESHOLD = 0.05  # fallback threshold if SWIR unavailable

SCL_CLOUD_CLASSES = {3, 8, 9, 10}  # cloud shadow, cloud med, cloud high, thin cirrus
SCL_WATER_CLASS = 6

CAM_MATCH_WINDOW_HOURS = 3

OUT_DIR = Path(__file__).resolve().parents[2] / "docs" / "research"


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class SceneResult:
    scene_id: str
    dt_utc: datetime
    scene_cloud_cover: float
    nearshore_cloud_frac: float | None = None
    offshore_cloud_frac: float | None = None
    survived: bool = False
    reject_reason: str = ""
    used_swir: bool = False
    raft_fraction: float | None = None   # offshore sargassum signal
    turbidity_red: float | None = None   # nearshore mean red reflectance
    ndti: float | None = None            # nearshore NDTI
    n_offshore_water_px: int = 0
    n_nearshore_water_px: int = 0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def log(msg: str) -> None:
    print(f"[spike] {msg}", file=sys.stderr, flush=True)


def fetch_cam_history() -> list[dict]:
    with urllib.request.urlopen(CAM_HISTORY_URL, timeout=30) as resp:
        data = json.load(resp)
    hist = data.get("history", [])
    log(f"cam history: {len(hist)} reads fetched")
    return hist


def parse_cam_time(t: str) -> datetime:
    return datetime.fromisoformat(t)


def search_scenes():
    from pystac_client import Client

    client = Client.open(STAC_URL)
    search = client.search(
        collections=[COLLECTION],
        intersects={"type": "Point", "coordinates": [BOCA_LON, BOCA_LAT]},
        datetime=f"{DATE_START}/{DATE_END}",
        query={"eo:cloud_cover": {"lt": SCENE_CLOUD_COVER_MAX}},
    )
    items = list(search.items())
    log(f"STAC search: {len(items)} scenes with eo:cloud_cover < {SCENE_CLOUD_COVER_MAX}")
    return items


def box_bounds(x0: float, y0: float, xr: tuple[float, float], yr: tuple[float, float]):
    """Return (left, bottom, right, top) in the dataset's projected CRS units."""
    return (x0 + xr[0], y0 + yr[0], x0 + xr[1], y0 + yr[1])


def read_window(dataset, bounds, out_shape=None):
    from rasterio.windows import from_bounds
    from rasterio.enums import Resampling

    win = from_bounds(*bounds, transform=dataset.transform)
    kwargs = {"window": win}
    if out_shape is not None:
        kwargs["out_shape"] = out_shape
        kwargs["resampling"] = Resampling.nearest
    return dataset.read(1, **kwargs)


def process_scene(item, anchor_xy_cache: dict) -> SceneResult:
    import rasterio
    from rasterio.warp import transform as warp_transform

    res = SceneResult(
        scene_id=item.id,
        dt_utc=item.datetime,
        scene_cloud_cover=float(item.properties.get("eo:cloud_cover", -1)),
    )

    try:
        red_href = item.assets["red"].href
        green_href = item.assets["green"].href
        nir_href = item.assets["nir"].href
        scl_href = item.assets["scl"].href
        swir_href = item.assets.get("swir16")
        swir_href = swir_href.href if swir_href else None
    except KeyError as e:
        res.reject_reason = f"missing asset {e}"
        return res

    try:
        with rasterio.open(red_href) as red_ds:
            crs_key = str(red_ds.crs)
            if crs_key not in anchor_xy_cache:
                xs, ys = warp_transform("EPSG:4326", red_ds.crs, [BOCA_LON], [BOCA_LAT])
                anchor_xy_cache[crs_key] = (xs[0], ys[0])
            x0, y0 = anchor_xy_cache[crs_key]

            near_bounds = box_bounds(x0, y0, NEARSHORE_X, ALONGSHORE_Y)
            off_bounds = box_bounds(x0, y0, OFFSHORE_X, ALONGSHORE_Y)

            red_near = read_window(red_ds, near_bounds).astype(np.float64)
            red_off = read_window(red_ds, off_bounds).astype(np.float64)
            shape_near = red_near.shape
            shape_off = red_off.shape

        with rasterio.open(green_href) as ds:
            green_near = read_window(ds, near_bounds, out_shape=shape_near).astype(np.float64)

        with rasterio.open(nir_href) as ds:
            nir_near = read_window(ds, near_bounds, out_shape=shape_near).astype(np.float64)
            nir_off = read_window(ds, off_bounds, out_shape=shape_off).astype(np.float64)

        with rasterio.open(scl_href) as ds:
            scl_near = read_window(ds, near_bounds, out_shape=shape_near)
            scl_off = read_window(ds, off_bounds, out_shape=shape_off)

        # --- cloud screening (per-crop, not scene-level) ---
        near_cloud_frac = np.isin(scl_near, list(SCL_CLOUD_CLASSES)).mean()
        off_cloud_frac = np.isin(scl_off, list(SCL_CLOUD_CLASSES)).mean()
        res.nearshore_cloud_frac = float(near_cloud_frac)
        res.offshore_cloud_frac = float(off_cloud_frac)
        if near_cloud_frac > CROP_CLOUD_FRACTION_MAX or off_cloud_frac > CROP_CLOUD_FRACTION_MAX:
            res.reject_reason = (
                f"crop cloud frac near={near_cloud_frac:.2f} off={off_cloud_frac:.2f} "
                f"> {CROP_CLOUD_FRACTION_MAX}"
            )
            return res

        # --- try SWIR for FAI, fall back to NDVI ---
        swir_near = swir_off = None
        if swir_href:
            try:
                with rasterio.open(swir_href) as ds:
                    swir_off = read_window(ds, off_bounds, out_shape=shape_off).astype(np.float64)
            except Exception as e:  # noqa: BLE001
                log(f"{item.id}: SWIR read failed ({e}), falling back to NDVI")
                swir_off = None

        scale = 10000.0  # L2A BOA reflectance scale factor
        red_near_r = red_near / scale
        green_near_r = green_near / scale
        red_off_r = red_off / scale
        nir_off_r = nir_off / scale

        water_near = scl_near == SCL_WATER_CLASS
        water_off = scl_off == SCL_WATER_CLASS
        res.n_nearshore_water_px = int(water_near.sum())
        res.n_offshore_water_px = int(water_off.sum())

        if water_off.sum() == 0 or water_near.sum() == 0:
            res.reject_reason = "no water pixels in one or both boxes (land/mixed pixel)"
            return res

        if swir_off is not None:
            swir_off_r = swir_off / scale
            baseline = red_off_r + (swir_off_r - red_off_r) * (
                (LAMBDA_NIR - LAMBDA_RED) / (LAMBDA_SWIR - LAMBDA_RED)
            )
            fai = nir_off_r - baseline
            raft_px = (fai > FAI_RAFT_THRESHOLD) & water_off
            res.used_swir = True
        else:
            ndvi = (nir_off_r - red_off_r) / (nir_off_r + red_off_r + 1e-9)
            raft_px = (ndvi > NDVI_RAFT_THRESHOLD) & water_off
            res.used_swir = False

        res.raft_fraction = float(raft_px.sum() / water_off.sum())

        red_water_near = red_near_r[water_near]
        green_water_near = green_near_r[water_near]
        res.turbidity_red = float(red_water_near.mean())
        ndti_vals = (red_water_near - green_water_near) / (red_water_near + green_water_near + 1e-9)
        res.ndti = float(np.mean(ndti_vals))

        res.survived = True
        return res

    except Exception as e:  # noqa: BLE001
        res.reject_reason = f"exception: {e}"
        return res


def match_cam_reads(scene_dt_utc: datetime, cam_history: list[dict]) -> tuple[float | None, float | None, int]:
    """Return (median cov, median clr, n matched) for cam reads within +/-3h same
    calendar day (local) as the scene time."""
    matches_cov = []
    matches_clr = []
    n = 0
    for row in cam_history:
        try:
            t_local = parse_cam_time(row["t"])
        except (KeyError, ValueError):
            continue
        t_utc = t_local.astimezone(timezone.utc)
        if t_local.date() != scene_dt_utc.astimezone(t_local.tzinfo).date():
            continue
        if abs((t_utc - scene_dt_utc).total_seconds()) > CAM_MATCH_WINDOW_HOURS * 3600:
            continue
        n += 1
        if row.get("cov") is not None:
            matches_cov.append(row["cov"])
        if row.get("clr") is not None:
            matches_clr.append(row["clr"])
    cov = statistics.median(matches_cov) if matches_cov else None
    clr = statistics.median(matches_clr) if matches_clr else None
    return cov, clr, n


def spearman(x: list[float], y: list[float]) -> tuple[float | None, int]:
    n = len(x)
    if n < 3:
        return None, n
    xs = pd.Series(x).rank()
    ys = pd.Series(y).rank()
    return float(xs.corr(ys)), n


def make_scatter(x, y, xlabel, ylabel, title, rho, n, out_path: Path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(6, 5))
    ax.scatter(x, y, color="#2b6cb0", alpha=0.8, edgecolor="white", s=60, zorder=3)
    if n >= 2:
        try:
            coeffs = np.polyfit(x, y, 1)
            xs_line = np.linspace(min(x), max(x), 50)
            ax.plot(xs_line, np.polyval(coeffs, xs_line), color="#c05621", linestyle="--", zorder=2)
        except Exception:  # noqa: BLE001
            pass
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    ax.set_title(f"{title}\nSpearman rho={rho:.2f}, n={n}" if rho is not None else f"{title}\nn={n} (too small for rho)")
    ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)
    log(f"wrote {out_path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    cam_history = fetch_cam_history()
    items = search_scenes()

    month_counts = Counter()
    survived_month_counts = Counter()
    anchor_cache: dict = {}
    results: list[SceneResult] = []

    for item in items:
        month_key = item.datetime.strftime("%Y-%m")
        month_counts[month_key] += 1
        r = process_scene(item, anchor_cache)
        results.append(r)
        status = "OK" if r.survived else f"REJECT ({r.reject_reason})"
        log(f"{item.id} {item.datetime.isoformat()} cloud={r.scene_cloud_cover:.1f} -> {status}")
        if r.survived:
            survived_month_counts[month_key] += 1

    survived = [r for r in results if r.survived]
    log(f"scenes queried: {len(results)}, survived crop cloud filter: {len(survived)}")

    matched_rows = []
    for r in survived:
        cov, clr, n_cam = match_cam_reads(r.dt_utc, cam_history)
        matched_rows.append(
            {
                "scene_id": r.scene_id,
                "dt_utc": r.dt_utc.isoformat(),
                "raft_fraction": r.raft_fraction,
                "turbidity_red": r.turbidity_red,
                "ndti": r.ndti,
                "used_swir": r.used_swir,
                "n_offshore_water_px": r.n_offshore_water_px,
                "n_nearshore_water_px": r.n_nearshore_water_px,
                "cam_cov": cov,
                "cam_clr": clr,
                "n_cam_matches": n_cam,
            }
        )

    df = pd.DataFrame(matched_rows)
    df.to_csv(OUT_DIR / "satellite_spike_matched_scenes.csv", index=False)
    log(f"wrote {OUT_DIR / 'satellite_spike_matched_scenes.csv'}")

    df_cov = df.dropna(subset=["raft_fraction", "cam_cov"])
    df_clr_red = df.dropna(subset=["turbidity_red", "cam_clr"])
    df_clr_ndti = df.dropna(subset=["ndti", "cam_clr"])

    rho_cov, n_cov = spearman(df_cov["raft_fraction"].tolist(), df_cov["cam_cov"].tolist())
    rho_red, n_red = spearman(df_clr_red["turbidity_red"].tolist(), df_clr_red["cam_clr"].tolist())
    rho_ndti, n_ndti = spearman(df_clr_ndti["ndti"].tolist(), df_clr_ndti["cam_clr"].tolist())

    log(f"Spearman raft_fraction vs cam cov: rho={rho_cov} n={n_cov}")
    log(f"Spearman turbidity_red vs cam clr: rho={rho_red} n={n_red}")
    log(f"Spearman ndti vs cam clr: rho={rho_ndti} n={n_ndti}")

    if n_cov >= 2:
        make_scatter(
            df_cov["raft_fraction"].tolist(),
            df_cov["cam_cov"].tolist(),
            "Sentinel-2 offshore sargassum raft fraction",
            "Cam seaweed coverage % (cov)",
            "Sargassum raft fraction vs cam-observed coverage",
            rho_cov,
            n_cov,
            OUT_DIR / "satellite_spike_sargassum_scatter.png",
        )
    if n_red >= 2:
        make_scatter(
            df_clr_red["turbidity_red"].tolist(),
            df_clr_red["cam_clr"].tolist(),
            "Nearshore mean red (B04) reflectance",
            "Cam water clarity % (clr)",
            "Turbidity proxy (red reflectance) vs cam-observed clarity",
            rho_red,
            n_red,
            OUT_DIR / "satellite_spike_turbidity_scatter.png",
        )

    summary = {
        "scenes_queried": len(results),
        "scenes_survived_crop_cloud_filter": len(survived),
        "month_breakdown_queried": dict(month_counts),
        "month_breakdown_survived": dict(survived_month_counts),
        "n_matched_cov": n_cov,
        "n_matched_clr_red": n_red,
        "n_matched_clr_ndti": n_ndti,
        "spearman_raft_vs_cov": rho_cov,
        "spearman_turbidity_red_vs_clr": rho_red,
        "spearman_ndti_vs_clr": rho_ndti,
        "survived_dates_utc": [r.dt_utc.isoformat() for r in survived],
    }
    with open(OUT_DIR / "satellite_spike_summary.json", "w") as f:
        json.dump(summary, f, indent=2)
    log(f"wrote {OUT_DIR / 'satellite_spike_summary.json'}")
    log("done")


if __name__ == "__main__":
    main()
