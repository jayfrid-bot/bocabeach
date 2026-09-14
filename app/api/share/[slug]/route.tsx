import { ImageResponse } from "next/og";
import { NextResponse } from "next/server";
import { getConditions } from "@/lib/conditions";
import { shareCardModel, type ShareCardModel, type ShareCardTile } from "@/lib/shareCard";

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
  const sunTop = Math.round(height * 0.16);
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
function ScoreRing({ diameter, thickness, score, color, numSize, slashSize }: { diameter: number; thickness: number; score: number; color: string; numSize: number; slashSize: number }) {
  const pct = Math.max(0, Math.min(100, score));
  const c = diameter / 2;
  const r = (diameter - thickness) / 2;
  const circ = 2 * Math.PI * r;
  const filled = circ * (pct / 100);

  return (
    <div style={{ position: "relative", width: diameter, height: diameter, display: "flex" }}>
      <svg width={diameter} height={diameter} viewBox={`0 0 ${diameter} ${diameter}`} style={{ display: "flex" }}>
        <circle cx={c} cy={c} r={r} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth={thickness} />
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
          {Math.round(score)}
        </div>
        <div style={{ display: "flex", fontSize: slashSize, fontWeight: 600, color: MUTED, marginTop: 2 }}>
          /100
        </div>
      </div>
    </div>
  );
}

function Tile({ tile, valueSize, labelSize, tilePad }: { tile: ShareCardTile; valueSize: number; labelSize: number; tilePad: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        background: TILE_BG,
        border: `1px solid ${TILE_RING}`,
        borderRadius: 28,
        padding: tilePad,
      }}
    >
      <div
        style={{
          display: "flex",
          fontSize: labelSize,
          fontWeight: 600,
          lineHeight: 1.15,
          color: MUTED,
          textTransform: "uppercase",
          letterSpacing: 1.5,
        }}
      >
        {tile.label}
      </div>
      <div style={{ display: "flex", fontSize: valueSize, fontWeight: 700, lineHeight: 1.15, color: INK, marginTop: 6 }}>
        {tile.value}
      </div>
    </div>
  );
}

/** Chunk tiles into rows of `cols` — a plain flex grid (satori has no CSS Grid). */
function TileGrid({
  tiles,
  cols,
  valueSize,
  labelSize,
  tilePad,
  gap,
}: {
  tiles: ShareCardTile[];
  cols: number;
  valueSize: number;
  labelSize: number;
  tilePad: string;
  gap: number;
}) {
  const rows: ShareCardTile[][] = [];
  for (let i = 0; i < tiles.length; i += cols) rows.push(tiles.slice(i, i + cols));
  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%" }}>
      {rows.map((row, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "row", width: "100%", marginTop: i === 0 ? 0 : gap }}>
          {row.map((tile, j) => (
            <div key={tile.key} style={{ display: "flex", flex: 1, marginLeft: j === 0 ? 0 : gap }}>
              <Tile tile={tile} valueSize={valueSize} labelSize={labelSize} tilePad={tilePad} />
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

function ShareCard({ model, format }: { model: ShareCardModel; format: Format }) {
  const isStory = format === "story";
  const { width, height } = SIZES[format];

  const pad = isStory ? 60 : 56;
  const skyH = Math.round(height * (isStory ? 0.245 : 0.25));
  const sun = isStory ? { d: 128, rayLen: 34, rayW: 12, gap: 12 } : { d: 106, rayLen: 28, rayW: 9, gap: 11 };

  const ringDiameter = isStory ? 545 : 280;
  const ringThickness = isStory ? 26 : 20;
  const ringNumSize = isStory ? 222 : 80;
  const ringSlashSize = isStory ? 52 : 22;

  const verdictSize = isStory ? 64 : 32;
  const nameSize = isStory ? 84 : 36;
  const metaSize = isStory ? 36 : 21;
  const capSize = isStory ? 28 : 19;

  const cols = isStory ? 2 : 3;
  const tileValueSize = isStory ? 56 : 25;
  const tileLabelSize = isStory ? 28 : 16;
  const tileGap = isStory ? 18 : 12;
  const tilePad = isStory ? "14px 22px" : "14px 14px";

  const footerWordmark = isStory ? 40 : 22;
  const footerUrl = isStory ? 32 : 18;

  const metaLine = [model.region, model.dateLabel, model.timeLabel].filter(Boolean).join(" · ");

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
        {/* Pushes everything below down past the sky band's painted area —
            without this the hero would render on top of the sun/waves. */}
        <div style={{ display: "flex", height: Math.max(0, skyH - pad), flexShrink: 0 }} />

        {/* Centers the hero+tiles+footer block in the space left below the
            sky band, so any slack lands evenly above and below instead of
            as one large empty band at the bottom. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            flex: 1,
            justifyContent: "center",
          }}
        >
          <ScoreRing
            diameter={ringDiameter}
            thickness={ringThickness}
            score={model.score}
            color={model.color}
            numSize={ringNumSize}
            slashSize={ringSlashSize}
          />

          <div
            style={{
              display: "flex",
              fontSize: verdictSize,
              fontWeight: 800,
              lineHeight: 1.15,
              color: model.color,
              marginTop: isStory ? 22 : 20,
              textAlign: "center",
            }}
          >
            {model.verdict}
          </div>

          <div
            style={{
              display: "flex",
              fontSize: nameSize,
              fontWeight: 800,
              lineHeight: 1.15,
              color: INK,
              marginTop: isStory ? 14 : 18,
              textAlign: "center",
            }}
          >
            {model.beachName}
          </div>
          {metaLine ? (
            <div
              style={{
                display: "flex",
                fontSize: metaSize,
                lineHeight: 1.15,
                color: MUTED,
                marginTop: isStory ? 10 : 18,
                textAlign: "center",
              }}
            >
              {metaLine}
            </div>
          ) : null}

          {model.capped && model.capNote ? (
            <div
              style={{
                display: "flex",
                marginTop: isStory ? 16 : 14,
                padding: isStory ? "12px 20px" : "8px 14px",
                borderRadius: 999,
                background: "rgba(251,113,133,0.18)",
                border: "1px solid rgba(251,113,133,0.45)",
                fontSize: capSize,
                color: "#ffd7de",
                textAlign: "center",
              }}
            >
              {model.capNote}
            </div>
          ) : null}

          <div style={{ display: "flex", width: "100%", marginTop: isStory ? 24 : 26 }}>
            <TileGrid
              tiles={model.tiles}
              cols={cols}
              valueSize={tileValueSize}
              labelSize={tileLabelSize}
              tilePad={tilePad}
              gap={tileGap}
            />
          </div>

          {/* Footer: wordmark + plain URL line — no QR code. Kept inside the
              centered block so it hugs the tiles instead of pinning to the
              card's bottom edge with a big gap above it. */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              width: "100%",
              marginTop: isStory ? 18 : 18,
              paddingTop: isStory ? 20 : 16,
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

  const data = await getConditions(slug);
  if (!data) {
    return NextResponse.json({ error: "Unknown location" }, { status: 404 });
  }

  const model = shareCardModel(data, Date.now());
  const { width, height } = SIZES[formatParam];

  // Rendering a 1080x1920 PNG through satori is CPU-heavy (several seconds),
  // and the card only changes as fast as the conditions do (~2 min). Serve a
  // rendered card straight from the Cloudflare edge cache for its lifetime, so
  // the second view of a beach — reopening the sheet, the Share button's own
  // fetch, or the next person sharing the same beach — is instant instead of
  // re-rendering. Guarded: if the cache global isn't present, just render.
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const cacheKey = new Request(new URL(req.url).toString());
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const image = new ImageResponse(<ShareCard model={model} format={formatParam} />, {
    width,
    height,
    headers: {
      "Cache-Control": "public, max-age=120, s-maxage=120",
    },
  });

  if (cache) {
    // Cache a clone; the original still streams to this caller.
    await cache.put(cacheKey, image.clone());
  }
  return image;
}
