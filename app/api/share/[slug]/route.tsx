import { ImageResponse } from "next/og";
import { NextResponse } from "next/server";
import { getConditions } from "@/lib/conditions";
import { shareCardModel, type ShareCardModel, type ShareCardTile } from "@/lib/shareCard";
import { qrMatrix } from "@/lib/qr";

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

// --- Design language (matches app/opengraph-image.tsx) --------------------
const BG = "linear-gradient(160deg, #041525 0%, #06263f 55%, #073a5c 100%)";
const INK = "#f1f7fb";
const MUTED = "#9fc3d6";
const WORDMARK = "#7fd7f0";
const CARD_BG = "rgba(255,255,255,0.06)";
const CARD_RING = "rgba(255,255,255,0.14)";

function SunMotif({ size, top, right }: { size: number; top: number; right: number }) {
  return (
    <div
      style={{
        position: "absolute",
        top,
        right,
        width: size,
        height: size,
        borderRadius: 9999,
        background: "radial-gradient(circle at 50% 50%, #ffe27a 0%, #ffcf4d 55%, #f7b733 100%)",
        boxShadow: `0 0 ${Math.round(size * 0.5)}px ${Math.round(size * 0.16)}px rgba(255, 207, 77, 0.3)`,
        display: "flex",
      }}
    />
  );
}

function WaveBand({ height }: { height: number }) {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        bottom: 0,
        width: "100%",
        height,
        display: "flex",
        background: "linear-gradient(90deg, #0e9bd6 0%, #1fb6d8 50%, #2fd0d0 100%)",
      }}
    />
  );
}

/** QR modules rendered as absolutely-positioned divs — satori has no <img>/
 *  external-asset support here and no emoji font, but plain divs always work. */
function QrCode({ text, box }: { text: string; box: number }) {
  const QUIET = 3; // modules of white margin, each side — keeps scanners happy
  const m = qrMatrix(text, "M");
  const total = m.size + QUIET * 2;
  const cell = box / total;
  const modules: { x: number; y: number }[] = [];
  for (let row = 0; row < m.size; row++) {
    for (let col = 0; col < m.size; col++) {
      if (m.isDark(row, col)) modules.push({ x: col, y: row });
    }
  }
  return (
    <div
      style={{
        position: "relative",
        width: box,
        height: box,
        background: "#ffffff",
        borderRadius: 12,
        display: "flex",
      }}
    >
      {modules.map((mod, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: Math.round((mod.x + QUIET) * cell),
            top: Math.round((mod.y + QUIET) * cell),
            width: Math.ceil(cell),
            height: Math.ceil(cell),
            background: "#06263f",
            display: "flex",
          }}
        />
      ))}
    </div>
  );
}

const FLAG_DOT: Record<string, string> = {
  green: "#34d399",
  yellow: "#fbbf24",
  red: "#fb7185",
  "double-red": "#e11d48",
  purple: "#c084fc",
};

function FlagChip({ flag }: { flag: { color: string; label: string } }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        background: CARD_BG,
        border: `1px solid ${CARD_RING}`,
        borderRadius: 9999,
        padding: "10px 20px",
        marginRight: 12,
        marginTop: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          width: 16,
          height: 16,
          borderRadius: 9999,
          background: FLAG_DOT[flag.color] ?? "#94a3b8",
          marginRight: 10,
        }}
      />
      <div style={{ display: "flex", fontSize: 24, color: INK }}>{flag.label}</div>
    </div>
  );
}

function Tile({ tile, valueSize }: { tile: ShareCardTile; valueSize: number }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        background: CARD_BG,
        border: `1px solid ${CARD_RING}`,
        borderRadius: 20,
        padding: "22px 24px",
        marginRight: 16,
      }}
    >
      <div style={{ display: "flex", fontSize: 22, color: MUTED, textTransform: "uppercase", letterSpacing: 1 }}>
        {tile.label}
      </div>
      <div style={{ display: "flex", fontSize: valueSize, fontWeight: 700, color: INK, marginTop: 6 }}>
        {tile.value}
      </div>
    </div>
  );
}

/** Chunk tiles into rows of `cols` — a plain flex grid (satori has no CSS Grid). */
function TileGrid({ tiles, cols, valueSize }: { tiles: ShareCardTile[]; cols: number; valueSize: number }) {
  const rows: ShareCardTile[][] = [];
  for (let i = 0; i < tiles.length; i += cols) rows.push(tiles.slice(i, i + cols));
  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%" }}>
      {rows.map((row, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "row", width: "100%", marginTop: i === 0 ? 0 : 16 }}>
          {row.map((tile) => (
            <Tile key={tile.key} tile={tile} valueSize={valueSize} />
          ))}
          {/* Pad a short final row so tiles keep their column width. */}
          {row.length < cols
            ? Array.from({ length: cols - row.length }).map((_, j) => (
                <div key={`pad-${j}`} style={{ display: "flex", flex: 1, marginRight: 16 }} />
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
  const pad = isStory ? 64 : 56;
  const cols = isStory ? 2 : 3;
  const scoreSize = isStory ? 260 : 176;
  const nameSize = isStory ? 68 : 54;
  const verdictSize = isStory ? 40 : 28;
  const tileValueSize = isStory ? 44 : 28;

  return (
    <div
      style={{
        width,
        height,
        display: "flex",
        flexDirection: "column",
        position: "relative",
        background: BG,
        color: INK,
        fontFamily: "sans-serif",
        padding: pad,
      }}
    >
      <SunMotif size={isStory ? 170 : 130} top={isStory ? 50 : 40} right={isStory ? 60 : 50} />
      <WaveBand height={isStory ? 70 : 56} />

      {/* Wordmark, with the local date/time on its own line beneath — the sun
          motif owns the top-right corner, so nothing else may sit there. */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            fontSize: 26,
            fontWeight: 600,
            letterSpacing: 3,
            textTransform: "uppercase",
            color: WORDMARK,
          }}
        >
          isitbeachday.com
        </div>
        <div style={{ display: "flex", fontSize: 26, color: MUTED, marginTop: 10 }}>
          {model.dateLabel}
          {model.dateLabel && model.timeLabel ? " · " : ""}
          {model.timeLabel}
        </div>
      </div>

      {/* Body. On the tall story canvas it is centred between the header and
          the footer (a top-anchored body left a third of the card empty); the
          square is nearly full, so it stays top-anchored. */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          justifyContent: isStory ? "center" : "flex-start",
          paddingBottom: isStory ? 40 : 0,
        }}
      >
      {/* Beach name + region */}
      <div style={{ display: "flex", flexDirection: "column", marginTop: 28 }}>
        <div style={{ display: "flex", fontSize: nameSize, fontWeight: 800, lineHeight: 1.05 }}>
          {model.beachName}
        </div>
        {model.region ? (
          <div style={{ display: "flex", fontSize: 28, color: MUTED, marginTop: 6 }}>{model.region}</div>
        ) : null}
      </div>

      {/* Score + verdict */}
      <div style={{ display: "flex", flexDirection: "row", alignItems: "flex-end", marginTop: isStory ? 32 : 18 }}>
        <div style={{ display: "flex", fontSize: scoreSize, fontWeight: 800, color: model.color, lineHeight: 1 }}>
          {Math.round(model.score)}
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginLeft: 24, marginBottom: isStory ? 22 : 14 }}>
          <div style={{ display: "flex", fontSize: isStory ? 40 : 32, fontWeight: 700, color: model.color }}>
            {model.rating}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", fontSize: verdictSize, fontWeight: 500, color: INK, marginTop: isStory ? 16 : 10 }}>
        {model.verdict}
      </div>

      {model.capped && model.capNote ? (
        <div
          style={{
            display: "flex",
            marginTop: 18,
            padding: "12px 18px",
            borderRadius: 14,
            background: "rgba(251,113,133,0.16)",
            border: "1px solid rgba(251,113,133,0.4)",
            fontSize: 22,
            color: "#ffd7de",
          }}
        >
          {model.capNote}
        </div>
      ) : null}

      {/* Metric tiles */}
      <div style={{ display: "flex", marginTop: isStory ? 40 : 28 }}>
        <TileGrid tiles={model.tiles} cols={cols} valueSize={tileValueSize} />
      </div>

      {/* Lifeguard flags */}
      {model.flags.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", marginTop: 8 }}>
          {model.flags.map((f) => (
            <FlagChip key={f.color} flag={f} />
          ))}
        </div>
      ) : null}

      </div>

      {/* Footer: brand + URL + QR */}
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: isStory ? 24 : 16,
          paddingTop: isStory ? 24 : 16,
          borderTop: `1px solid ${CARD_RING}`,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 30, fontWeight: 700, color: INK }}>Is It Beach Day?</div>
          <div style={{ display: "flex", fontSize: 24, color: MUTED, marginTop: 4 }}>{model.pageUrl}</div>
        </div>
        <QrCode text={model.shareUrl} box={isStory ? 180 : 150} />
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

  return new ImageResponse(<ShareCard model={model} format={formatParam} />, {
    width,
    height,
    headers: {
      "Cache-Control": "public, max-age=120, s-maxage=120",
    },
  });
}
