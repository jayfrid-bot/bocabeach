import { ImageResponse } from "next/og";
import { NextResponse } from "next/server";
import { getConditions } from "@/lib/conditions";
import { shareCacheControl, shareCardModel, type ShareCardModel, type ShareCardTile } from "@/lib/shareCard";

// The shareable social card: a phone-native PNG of today's conditions, built
// for the Share sheet (components/ShareCardSheet.tsx) rather than link
// unfurls (that's app/opengraph-image.tsx). Same hard constraints as that
// file: no external fetches, default font only, and deliberately NOT edge
// runtime — OpenNext/Cloudflare bundles the server as one Node-compat
// function and rejects per-route edge runtimes.
//
// GET /api/share/<slug>?format=story|square
//   story  — 1080x1920, Instagram/TikTok Story
//   square — 1080x1080, feed post
export const dynamic = "force-dynamic";

const SIZES = {
  story: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
} as const;
type Format = keyof typeof SIZES;

function isFormat(v: string): v is Format {
  return v === "story" || v === "square";
}

// --- Brand language (matches the app icon: a sun over layered waves on a
// deep navy sky) --------------------------------------------------------
const SKY_GRADIENT = "linear-gradient(180deg, #0b2a5b 0%, #1758b6 100%)";
const BODY_BG = "#142f57"; // ocean-950 — the flat ground the ring "punches a hole" into
const WAVE_LIGHT = "#59c1ff"; // ocean-400
const WAVE_DARK = "#1b85f5"; // ocean-600
const SUN_CORE = "radial-gradient(circle at 35% 30%, #fef3d0 0%, #f9d465 45%, #f5b942 100%)";
const SUN_RAY = "#f9d465";
const SUN_YELLOW = "#f5c24b";
const INK = "#f4f9fc";
const MUTED = "#a9c8e0";
const WORDMARK_MUTED = "#bcd9ef";
const TILE_BG = "rgba(255,255,255,0.14)";
const TILE_RING = "rgba(255,255,255,0.28)";

/** A sun disc with 8 short rounded rays, matching the app icon's motif. Each
 *  ray is drawn resting straight up from the disc, then rotated around a
 *  transform-origin placed back at the disc's own center — the standard
 *  "clock hand" trick, so no translate() is needed alongside the rotate(). */
function Sun({ diameter, rayLen, rayW, gap }: { diameter: number; rayLen: number; rayW: number; gap: number }) {
  const reach = diameter / 2 + gap + rayLen; // distance from disc center to the ray's outer tip
  const angles = [0, 45, 90, 135, 180, 225, 270, 315];
  return (
    <div style={{ position: "relative", width: diameter, height: diameter, display: "flex" }}>
      {angles.map((deg) => (
        <div
          key={deg}
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: rayW,
            height: rayLen,
            marginLeft: -rayW / 2,
            marginTop: -reach,
            borderRadius: 999,
            background: SUN_RAY,
            transform: `rotate(${deg}deg)`,
            transformOrigin: `${rayW / 2}px ${reach}px`,
            display: "flex",
          }}
        />
      ))}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: diameter,
          height: diameter,
          borderRadius: 9999,
          background: SUN_CORE,
          display: "flex",
        }}
      />
    </div>
  );
}

/** One wavy band: a row of overlapping circles forms the scalloped top edge,
 *  with a solid rectangle beneath filling the rest of the band — "a row of
 *  large circles clipped by an overflow-hidden container gives a wave crest
 *  cheaply." Stacks bottom-up via `offsetBottom` inside the sky band. */
function WaveBand({
  color,
  height,
  bump,
  offsetBottom,
  cardWidth,
}: {
  color: string;
  height: number;
  bump: number;
  offsetBottom: number;
  cardWidth: number;
}) {
  const r = bump / 2;
  const step = bump * 0.82;
  const count = Math.ceil((cardWidth + bump * 2) / step) + 2;
  return (
    <div style={{ position: "absolute", left: 0, bottom: offsetBottom, width: "100%", height, display: "flex" }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: r,
          width: "100%",
          height: Math.max(height - r, 0),
          background: color,
          display: "flex",
        }}
      />
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: -bump + i * step,
            top: 0,
            width: bump,
            height: bump,
            borderRadius: 9999,
            background: color,
            display: "flex",
          }}
        />
      ))}
    </div>
  );
}

/** The decorative header: navy sky, sun, and a two-tone wave crest — the
 *  app icon's motif recreated with divs (satori: no <img>/<svg> assets). */
function SkyBand({ height, cardWidth, sun }: { height: number; cardWidth: number; sun: { d: number; rayLen: number; rayW: number; gap: number } }) {
  const waveTopH = Math.round(height * 0.16);
  const waveMidH = Math.round(height * 0.13);
  const waveBlendH = Math.round(height * 0.1);
  const sunTop = Math.round(height * 0.14);
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height,
        overflow: "hidden",
        background: SKY_GRADIENT,
        display: "flex",
      }}
    >
      <div style={{ position: "absolute", left: (cardWidth - sun.d) / 2, top: sunTop, display: "flex" }}>
        <Sun diameter={sun.d} rayLen={sun.rayLen} rayW={sun.rayW} gap={sun.gap} />
      </div>
      <WaveBand
        color={WAVE_LIGHT}
        height={waveTopH}
        bump={Math.round(waveTopH * 1.7)}
        offsetBottom={waveMidH + waveBlendH}
        cardWidth={cardWidth}
      />
      <WaveBand
        color={WAVE_DARK}
        height={waveMidH}
        bump={Math.round(waveMidH * 1.7)}
        offsetBottom={waveBlendH}
        cardWidth={cardWidth}
      />
      {/* Blend band: same color as the card body below, so the sky band's
          bottom edge dissolves into the rest of the card with no seam. */}
      <WaveBand
        color={BODY_BG}
        height={waveBlendH}
        bump={Math.round(waveBlendH * 1.7)}
        offsetBottom={0}
        cardWidth={cardWidth}
      />
    </div>
  );
}

/** Beach Day score as a ring: a real SVG arc (satori renders inline SVG
 *  directly). A conic-gradient background was tried first, but this build's
 *  satori/next-og recognizes "conic-gradient(...)" as a valid gradient-shaped
 *  string without actually having a stop parser for it (throws "Failed to
 *  parse declaration" the moment it renders one); a dial of tiny rotated
 *  divs was tried next, but it reads as jagged rather than a clean ring. A
 *  stroked <circle> with stroke-dasharray is exact and cheap. */
function ScoreRing({ diameter, thickness, score, color, numSize, slashSize }: { diameter: number; thickness: number; score: number | null; color: string; numSize: number; slashSize: number }) {
  const pct = score == null ? 0 : Math.max(0, Math.min(100, score));
  const c = diameter / 2;
  const r = (diameter - thickness) / 2;
  const circ = 2 * Math.PI * r;
  const filled = circ * (pct / 100);

  return (
    <div style={{ position: "relative", width: diameter, height: diameter, display: "flex" }}>
      <svg width={diameter} height={diameter} viewBox={`0 0 ${diameter} ${diameter}`} style={{ display: "flex" }}>
        <circle cx={c} cy={c} r={r} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth={thickness} />
        {pct > 0 ? (
        <circle
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circ}`}
          transform={`rotate(-90 ${c} ${c})`}
        />
        ) : null}
      </svg>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: diameter,
          height: diameter,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div style={{ display: "flex", fontSize: numSize, fontWeight: 800, color: INK, lineHeight: 1 }}>
          {score == null ? "—" : Math.round(score)}
        </div>
        <div style={{ display: "flex", fontSize: slashSize, fontWeight: 600, color: MUTED, marginTop: 2 }}>
          /100
        </div>
      </div>
    </div>
  );
}

function Tile({ tile, sizes }: { tile: ShareCardTile; sizes: TileSizes }) {
  // One line per row, clipped with an ellipsis: a long reading must never
  // grow the tile (a wrapped value once pushed the hero text into itself).
  const line = (extra: Record<string, string | number>) => ({
    display: "block" as const,
    whiteSpace: "nowrap" as const,
    overflow: "hidden" as const,
    textOverflow: "ellipsis" as const,
    lineHeight: 1.15,
    ...extra,
  });
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minWidth: 0,
        background: TILE_BG,
        border: `1px solid ${TILE_RING}`,
        borderRadius: sizes.radius,
        padding: sizes.pad,
      }}
    >
      <div style={line({ fontSize: sizes.label, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: 1.2 })}>
        {tile.label}
      </div>
      <div style={line({ fontSize: sizes.value, fontWeight: 700, color: INK, marginTop: 4 })}>{tile.value}</div>
      <div style={line({ fontSize: sizes.note, color: MUTED, marginTop: 2 })}>{tile.note ?? " "}</div>
    </div>
  );
}

interface TileSizes {
  label: number;
  value: number;
  note: number;
  pad: string;
  radius: number;
}

/** Chunk tiles into rows of `cols` — a plain flex grid (satori has no CSS Grid). */
function TileGrid({ tiles, cols, sizes, gap }: { tiles: ShareCardTile[]; cols: number; sizes: TileSizes; gap: number }) {
  const rows: ShareCardTile[][] = [];
  for (let i = 0; i < tiles.length; i += cols) rows.push(tiles.slice(i, i + cols));
  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", flexShrink: 0 }}>
      {rows.map((row, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "row", width: "100%", marginTop: i === 0 ? 0 : gap }}>
          {row.map((tile, j) => (
            <div key={tile.key} style={{ display: "flex", flex: 1, minWidth: 0, marginLeft: j === 0 ? 0 : gap }}>
              <Tile tile={tile} sizes={sizes} />
            </div>
          ))}
          {row.length < cols
            ? Array.from({ length: cols - row.length }).map((_, j) => (
                <div key={`pad-${j}`} style={{ display: "flex", flex: 1, marginLeft: gap }} />
              ))
            : null}
        </div>
      ))}
    </div>
  );
}

const SAFETY_STYLE: Record<ShareCardModel["safety"]["level"], { bg: string; ring: string; dot: string; text: string }> = {
  safe: { bg: "rgba(52,211,153,0.16)", ring: "rgba(52,211,153,0.45)", dot: "#34d399", text: "#d1fae5" },
  caution: { bg: "rgba(251,191,36,0.16)", ring: "rgba(251,191,36,0.5)", dot: "#fbbf24", text: "#fef3c7" },
  "stay-out": { bg: "rgba(251,113,133,0.18)", ring: "rgba(251,113,133,0.5)", dot: "#fb7185", text: "#ffe4e9" },
};

/** Up to `max` tiles, trimmed to whole rows so no tile sits alone at the end
 *  (the list is in priority order, so the lowest-priority ones drop). */
function fullRows(tiles: ShareCardTile[], cols: number, max: number): ShareCardTile[] {
  const n = Math.min(tiles.length, max);
  return tiles.slice(0, n < cols ? n : n - (n % cols));
}

/** Beach name size that keeps long names to two lines in the hero column. */
function nameSizeFor(name: string, base: number): number {
  if (name.length > 18) return Math.round(base * 0.78);
  if (name.length > 13) return Math.round(base * 0.88);
  return base;
}

function ShareCard({ model, format }: { model: ShareCardModel; format: Format }) {
  const isStory = format === "story";
  const { width, height } = SIZES[format];

  // Every size below is fixed, and every block is flexShrink: 0, so the
  // layout can never squeeze one text line into the next. The story budget
  // (sky 300 + hero 360 + safety ~130 + 4 tile rows ~620 + best ~40 + footer
  // ~100 + gaps ~130) sits under 1920; the square one under 1080.
  const pad = isStory ? 56 : 44;
  const skyH = isStory ? 300 : 150;
  const sun = isStory ? { d: 96, rayLen: 26, rayW: 10, gap: 10 } : { d: 58, rayLen: 16, rayW: 7, gap: 7 };

  const ring = isStory
    ? { d: 360, thick: 24, num: 146, slash: 38 }
    : { d: 228, thick: 16, num: 92, slash: 26 };
  const verdictSize = isStory ? 50 : 34;
  const nameSize = nameSizeFor(model.beachName, isStory ? 80 : 54);
  const metaSize = isStory ? 30 : 21;

  const cols = 3;
  const tileCount = isStory ? 12 : 9;
  const tileSizes: TileSizes = isStory
    ? { label: 22, value: 50, note: 25, pad: "18px 22px", radius: 24 }
    : { label: 15, value: 31, note: 17, pad: "10px 14px", radius: 18 };
  const tileGap = isStory ? 16 : 10;

  const safetySize = isStory ? { title: 34, reason: 26, pad: "18px 26px", dot: 20 } : { title: 23, reason: 18, pad: "10px 16px", dot: 13 };
  const bestSize = isStory ? 32 : 21;
  const footerWordmark = isStory ? 38 : 22;
  const footerUrl = isStory ? 28 : 17;
  const gapY = isStory ? 32 : 16;

  const dateTime = [model.dateLabel, model.timeLabel ? `as of ${model.timeLabel}` : ""].filter(Boolean).join(" · ");
  const safety = SAFETY_STYLE[model.safety.level];

  return (
    <div
      style={{
        width,
        height,
        display: "flex",
        flexDirection: "column",
        position: "relative",
        background: BODY_BG,
        color: INK,
        fontFamily: "sans-serif",
      }}
    >
      <SkyBand height={skyH} cardWidth={width} sun={sun} />

      <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: pad, position: "relative" }}>
        <div style={{ display: "flex", height: Math.max(0, skyH - pad), flexShrink: 0 }} />

        <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center" }}>
          {/* Hero: the score ring beside the verdict, beach, and time. */}
          <div style={{ display: "flex", flexDirection: "row", alignItems: "center", width: "100%", flexShrink: 0 }}>
            <div style={{ display: "flex", flexShrink: 0 }}>
              <ScoreRing
                diameter={ring.d}
                thickness={ring.thick}
                score={model.available ? model.score : null}
                color={model.color}
                numSize={ring.num}
                slashSize={ring.slash}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, marginLeft: isStory ? 40 : 28 }}>
              <div style={{ display: "flex", fontSize: verdictSize, fontWeight: 800, lineHeight: 1.1, color: model.color }}>
                {model.verdict}
              </div>
              <div style={{ display: "flex", fontSize: nameSize, fontWeight: 800, lineHeight: 1.05, color: INK, marginTop: isStory ? 12 : 8 }}>
                {model.beachName}
              </div>
              {model.region ? (
                <div style={{ display: "flex", fontSize: metaSize, lineHeight: 1.2, color: MUTED, marginTop: isStory ? 14 : 8 }}>
                  {model.region}
                </div>
              ) : null}
              {dateTime ? (
                <div style={{ display: "flex", fontSize: metaSize, lineHeight: 1.2, color: MUTED, marginTop: 4 }}>{dateTime}</div>
              ) : null}
              {model.limitedNote ? (
                <div style={{ display: "flex", fontSize: metaSize, lineHeight: 1.2, color: SUN_YELLOW, marginTop: isStory ? 10 : 6 }}>
                  {model.limitedNote}
                </div>
              ) : null}
            </div>
          </div>

          {model.safety.label ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                flexShrink: 0,
                marginTop: gapY,
                padding: safetySize.pad,
                borderRadius: isStory ? 24 : 16,
                background: safety.bg,
                border: `1px solid ${safety.ring}`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center" }}>
                <div
                  style={{
                    display: "flex",
                    width: safetySize.dot,
                    height: safetySize.dot,
                    borderRadius: 999,
                    background: safety.dot,
                    marginRight: isStory ? 14 : 10,
                  }}
                />
                <div style={{ display: "flex", fontSize: safetySize.title, fontWeight: 800, lineHeight: 1.15, color: INK }}>
                  {model.safety.label}
                </div>
              </div>
              {model.safety.reasons.slice(0, isStory ? 2 : 1).map((reason) => (
                <div
                  key={reason}
                  style={{
                    display: "block",
                    fontSize: safetySize.reason,
                    lineHeight: 1.25,
                    color: safety.text,
                    marginTop: isStory ? 6 : 4,
                    marginLeft: safetySize.dot + (isStory ? 14 : 10),
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {reason}
                </div>
              ))}
            </div>
          ) : null}

          <div style={{ display: "flex", width: "100%", marginTop: gapY, flexShrink: 0 }}>
            <TileGrid tiles={fullRows(model.tiles, cols, tileCount)} cols={cols} sizes={tileSizes} gap={tileGap} />
          </div>

          {model.bestTime ? (
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                flexShrink: 0,
                marginTop: gapY,
                fontSize: bestSize,
                fontWeight: 700,
                lineHeight: 1.2,
                color: SUN_YELLOW,
              }}
            >
              {model.bestTime}
            </div>
          ) : null}

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              width: "100%",
              flexShrink: 0,
              marginTop: gapY,
              paddingTop: isStory ? 20 : 12,
              borderTop: `1px solid ${TILE_RING}`,
            }}
          >
            <div style={{ display: "flex", fontSize: footerWordmark, fontWeight: 800, lineHeight: 1.15, color: INK }}>
              <span style={{ display: "flex" }}>Is it beach day</span>
              <span style={{ display: "flex", color: SUN_YELLOW }}>?</span>
            </div>
            <div style={{ display: "flex", fontSize: footerUrl, lineHeight: 1.15, color: WORDMARK_MUTED, marginTop: 6 }}>
              {model.pageUrl}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const url = new URL(req.url);
  const formatParam = url.searchParams.get("format") ?? "story";
  if (!isFormat(formatParam)) {
    return NextResponse.json({ error: "Bad format — use story or square" }, { status: 400 });
  }

  // Rendering a 1080x1920 PNG through satori is CPU-heavy (several seconds),
  // and the card only changes as fast as the conditions meaningfully do. Serve a
  // rendered card straight from the Cloudflare edge cache for its lifetime, so
  // the second view of a beach — reopening the sheet, the Share button's own
  // fetch, or the next person sharing the same beach — is instant instead of
  // re-rendering. Guarded: if the cache global isn't present, just render.
  //
  // Checked BEFORE `getConditions` (Codex round 2): a cache hit must skip the
  // conditions build entirely, not just the satori render — this route is
  // warmed proactively (components/ConditionsDashboard.tsx fires both
  // formats on every page view), and calling getConditions() first meant
  // every one of those warm requests paid for a conditions lookup even when
  // the PNG itself was already cached and about to be thrown away below.
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const cacheKey = new Request(new URL(req.url).toString());
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const data = await getConditions(slug);
  if (!data) {
    return NextResponse.json({ error: "Unknown location" }, { status: 404 });
  }

  const nowMs = Date.now();
  const model = shareCardModel(data, nowMs);
  const { width, height } = SIZES[formatParam];

  const image = new ImageResponse(<ShareCard model={model} format={formatParam} />, {
    width,
    height,
    headers: { "Cache-Control": shareCacheControl(model, nowMs) },
  });

  if (cache) {
    // Cache a clone; the original still streams to this caller.
    await cache.put(cacheKey, image.clone());
  }
  return image;
}
