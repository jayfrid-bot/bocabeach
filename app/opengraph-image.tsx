import { ImageResponse } from "next/og";

// The social share card. Kept deliberately self-contained: no external fetches,
// no custom fonts (default only) so it renders reliably in the Workers runtime.
// NOTE: intentionally NOT edge runtime — OpenNext/Cloudflare bundles the server
// as a single Node-compat function and rejects per-route edge runtimes.
export const alt = "Is It Beach Day? — Live beach conditions, scored.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "flex-start",
          padding: "80px",
          background: "linear-gradient(160deg, #041525 0%, #06263f 55%, #073a5c 100%)",
          color: "#f1f7fb",
          fontFamily: "sans-serif",
          position: "relative",
        }}
      >
        {/* Sun motif, top-right */}
        <div
          style={{
            position: "absolute",
            top: "70px",
            right: "90px",
            width: "150px",
            height: "150px",
            borderRadius: "9999px",
            background: "radial-gradient(circle at 50% 50%, #ffe27a 0%, #ffcf4d 55%, #f7b733 100%)",
            boxShadow: "0 0 90px 30px rgba(255, 207, 77, 0.35)",
            display: "flex",
          }}
        />
        {/* Wave motif, bottom band */}
        <div
          style={{
            position: "absolute",
            left: 0,
            bottom: 0,
            width: "100%",
            height: "90px",
            display: "flex",
            background: "linear-gradient(90deg, #0e9bd6 0%, #1fb6d8 50%, #2fd0d0 100%)",
          }}
        />
        <div
          style={{
            fontSize: "34px",
            fontWeight: 600,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "#7fd7f0",
            display: "flex",
          }}
        >
          isitbeachday.com
        </div>
        <div
          style={{
            fontSize: "112px",
            fontWeight: 800,
            lineHeight: 1.02,
            marginTop: "18px",
            display: "flex",
          }}
        >
          Is it beach day?
        </div>
        <div
          style={{
            fontSize: "42px",
            fontWeight: 500,
            marginTop: "28px",
            color: "#c9dbe6",
            display: "flex",
          }}
        >
          Live beach conditions, scored. 🌊
        </div>
      </div>
    ),
    { ...size },
  );
}
