//
//  BeachSessionActivityLiveActivity.swift
//  BeachSessionActivity
//
//  All presentations for the Beach Session Live Activity: Lock Screen /
//  banner, Dynamic Island compact / expanded / minimal, plus the stale and
//  ended states. Static layout only — no looping animation. Countdowns use
//  Text(timerInterval:) so they tick with zero pushes.
//

import ActivityKit
import SwiftUI
import WidgetKit

// MARK: - Palette (mirrors the app's ocean/sand accents — tailwind.config.ts
// `ocean` scale + lib/scoreBands.ts band colors, checked 2026-09-22)

private enum Palette {
    static let ocean = Color(hex: "#1b85f5")      // ocean-600
    static let oceanDeep = Color(hex: "#146de1")  // ocean-700
    static let sand = Color(hex: "#fbbf24")       // amber, matches "Likely not" band
    static let lightning = Color(hex: "#fb7185")  // matches "Definitely not" band (urgency red)
    static let ink = Color.primary
    static let dim = Color.secondary
}

private extension Color {
    init(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        s.removeAll { $0 == "#" }
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        let r = Double((v >> 16) & 0xFF) / 255
        let g = Double((v >> 8) & 0xFF) / 255
        let b = Double(v & 0xFF) / 255
        self.init(.sRGB, red: r, green: g, blue: b, opacity: 1)
    }
}

@available(iOS 16.2, *)
struct BeachSessionLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: BeachSessionAttributes.self) { context in
            let degraded = isDegraded(state: context.state, isStale: context.isStale)
            let ended = hasEnded(state: context.state)
            LockScreenView(attributes: context.attributes, state: context.state, isDegraded: degraded, hasEnded: ended)
                .activityBackgroundTint(Color(.systemBackground))
                .activitySystemActionForegroundColor(Palette.ink)
        } dynamicIsland: { context in
            let degraded = isDegraded(state: context.state, isStale: context.isStale)
            let ended = hasEnded(state: context.state)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    ExpandedLeading(state: context.state, isDegraded: degraded, hasEnded: ended)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    ExpandedTrailing(state: context.state, isDegraded: degraded, hasEnded: ended)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    ExpandedBottom(attributes: context.attributes, state: context.state, isDegraded: degraded, hasEnded: ended)
                }
            } compactLeading: {
                CompactLeading(state: context.state, isDegraded: degraded, hasEnded: ended)
            } compactTrailing: {
                CompactTrailing(state: context.state, isDegraded: degraded, hasEnded: ended)
            } minimal: {
                MinimalView(state: context.state, isDegraded: degraded, hasEnded: ended)
            }
            .widgetURL(URL(string: "https://app.isitbeachday.com/beach/\(context.attributes.slug)"))
            .keylineTint(degraded ? Palette.dim : effectiveAccent(state: context.state))
        }
    }
}

// MARK: - Shared derived values

private func effectiveAccent(state: BeachSessionAttributes.ContentState) -> Color {
    if state.lightning?.active == true { return Palette.lightning }
    return Color(hex: BeachSessionVerdict.accentHex(forScore: state.score))
}

/// True when a surface should show a neutral "unavailable" indicator instead
/// of score/verdict/conditions: either the activity's own delivery is stale,
/// or the payload says the upstream feed is unavailable. Every presentation
/// (Lock Screen, compact, expanded, minimal) derives from this one place.
private func isDegraded(state: BeachSessionAttributes.ContentState, isStale: Bool) -> Bool {
    isStale || (state.unavailable ?? false)
}

private func hasEnded(state: BeachSessionAttributes.ContentState) -> Bool {
    state.ended ?? false
}

/// The Dynamic Island's expanded-leading region is too narrow for the full
/// verdict copy ("Yes — good beach day" truncates). Verdicts that carry a
/// short headline before " — " (e.g. "Yes") use just that headline there;
/// the Lock Screen keeps the full verdict via `BeachSessionVerdict.verdict`.
private func shortVerdict(forScore score: Int) -> String {
    let full = BeachSessionVerdict.verdict(forScore: score)
    if let range = full.range(of: " — ") {
        return String(full[full.startIndex..<range.lowerBound])
    }
    return full
}

/// Renders a countdown to `date` using `Text(timerInterval:)` only while
/// `date` is safely in the future (a few seconds of margin so a delayed
/// render, or a date that lands mid-render, never straddles "now" and traps
/// SwiftUI with an inverted range). Once the margin is gone it falls back to
/// "now", then "passed" — every call site that used to build
/// `Date()...eventDate` directly goes through this instead.
private struct CountdownText: View {
    let date: Date
    var showsHours: Bool = true

    var body: some View {
        let now = Date()
        if date > now.addingTimeInterval(3) {
            Text(timerInterval: now...date, countsDown: true, showsHours: showsHours)
        } else if date > now {
            Text("now")
        } else {
            Text("passed")
        }
    }
}

// MARK: - Lock Screen / banner

private struct LockScreenView: View {
    let attributes: BeachSessionAttributes
    let state: BeachSessionAttributes.ContentState
    let isDegraded: Bool
    let hasEnded: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            if hasEnded {
                EndedRow()
            } else if isDegraded {
                UnavailableRow()
            } else {
                if let lightning = state.lightning, lightning.active {
                    LightningRow(lightning: lightning)
                }
                statsRow
            }
            footer
        }
        .padding(16)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(attributes.beachName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.dim)
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(hasEnded ? "—" : (isDegraded ? "—" : "\(state.score)"))
                        .font(.system(size: 40, weight: .bold, design: .rounded))
                        .foregroundStyle((hasEnded || isDegraded) ? Palette.dim : effectiveAccent(state: state))
                        .monospacedDigit()
                    Text(hasEnded ? "Session ended" : (isDegraded ? "Conditions unavailable" : BeachSessionVerdict.verdict(forScore: state.score)))
                        .font(.headline)
                        .foregroundStyle(Palette.ink)
                }
            }
            Spacer()
            if !hasEnded {
                CountdownColumn(state: state)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var statsRow: some View {
        HStack(spacing: 14) {
            if let wind = state.windMph {
                StatChip(
                    symbol: "wind",
                    text: "\(Int(wind.rounded())) mph" + (BeachSessionFormat.cardinal(fromDegrees: state.windDeg).map { " \($0)" } ?? "")
                )
            }
            if let wave = state.waveFt {
                StatChip(symbol: "water.waves", text: String(format: "%.1f ft", wave))
            }
            if let clarity = BeachSessionFormat.clarityLabel(state.clarity) {
                StatChip(symbol: "eye", text: clarity)
            }
            if let seaweed = BeachSessionFormat.seaweedLabel(state.seaweed) {
                StatChip(symbol: "leaf", text: seaweed)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var footer: some View {
        HStack {
            Text(hasEnded ? "Session ended" : "Score for the beach")
                .font(.caption2)
                .foregroundStyle(Palette.dim)
            Spacer()
            if !hasEnded, let tideAt = state.nextTideAt, let kind = state.nextTideKind {
                HStack(spacing: 4) {
                    Image(systemName: kind == "high" ? "arrow.up.right" : "arrow.down.right")
                        .font(.caption2)
                    Text(kind == "high" ? "High tide" : "Low tide")
                        .font(.caption2)
                    CountdownText(date: tideAt)
                        .font(.caption2.monospacedDigit())
                }
                .foregroundStyle(Palette.dim)
                .accessibilityElement(children: .combine)
            }
        }
    }
}

private struct CountdownColumn: View {
    let state: BeachSessionAttributes.ContentState

    var body: some View {
        if let sunsetAt = state.sunsetAt {
            VStack(alignment: .trailing, spacing: 2) {
                Image(systemName: "sunset.fill")
                    .foregroundStyle(Palette.sand)
                    .accessibilityHidden(true)
                CountdownText(date: sunsetAt)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(Palette.dim)
                Text("to sunset")
                    .font(.caption2)
                    .foregroundStyle(Palette.dim)
            }
            .accessibilityElement(children: .combine)
        }
    }
}

private struct StatChip: View {
    let symbol: String
    let text: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: symbol)
                .font(.caption)
                .foregroundStyle(Palette.ocean)
            Text(text)
                .font(.caption.monospacedDigit())
                .foregroundStyle(Palette.ink)
        }
    }
}

private struct LightningRow: View {
    let lightning: BeachSessionAttributes.ContentState.Lightning

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "cloud.bolt.fill")
                .foregroundStyle(Palette.lightning)
            Text("Lightning near you")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Palette.lightning)
            Spacer()
            if let miles = lightning.miles {
                Text(String(format: "%.0f mi", miles) + (BeachSessionFormat.cardinal(fromDegrees: lightning.bearingDeg).map { " \($0)" } ?? ""))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(Palette.lightning)
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity)
        .background(Palette.lightning.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "Lightning near you" + (lightning.miles.map { String(format: ", %.0f miles away", $0) } ?? "")
        )
    }
}

private struct UnavailableRow: View {
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "wifi.slash")
                .foregroundStyle(Palette.dim)
            Text("Conditions unavailable — showing the last known session.")
                .font(.caption)
                .foregroundStyle(Palette.dim)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct EndedRow: View {
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "checkmark.circle")
                .foregroundStyle(Palette.dim)
            Text("Thanks for checking in. This session has ended.")
                .font(.caption)
                .foregroundStyle(Palette.dim)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Dynamic Island

private struct CompactLeading: View {
    let state: BeachSessionAttributes.ContentState
    let isDegraded: Bool
    let hasEnded: Bool
    var body: some View {
        if hasEnded || isDegraded {
            Text("—")
                .font(.caption.bold())
                .foregroundStyle(Palette.dim)
                .accessibilityLabel(hasEnded ? "Session ended" : "Conditions unavailable")
        } else {
            Text("\(state.score)")
                .font(.caption.bold().monospacedDigit())
                .foregroundStyle(effectiveAccent(state: state))
        }
    }
}

private struct CompactTrailing: View {
    let state: BeachSessionAttributes.ContentState
    let isDegraded: Bool
    let hasEnded: Bool
    var body: some View {
        if hasEnded {
            EmptyView()
        } else if isDegraded {
            Image(systemName: "wifi.slash")
                .foregroundStyle(Palette.dim)
                .accessibilityHidden(true)
        } else if let lightning = state.lightning, lightning.active {
            HStack(spacing: 2) {
                Text("⚡")
                if let miles = lightning.miles {
                    Text(String(format: "%.0f mi", miles))
                        .font(.caption2.monospacedDigit())
                }
            }
            .foregroundStyle(Palette.lightning)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Lightning near you")
        } else if let sunsetAt = state.sunsetAt {
            HStack(spacing: 0) {
                Text("Sunset in ")
                    .frame(width: 0)
                    .clipped()
                CountdownText(date: sunsetAt)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(Palette.dim)
                    .frame(width: 44)
            }
            .accessibilityElement(children: .combine)
        } else {
            Image(systemName: "sunset.fill").foregroundStyle(Palette.sand)
        }
    }
}

private struct MinimalView: View {
    let state: BeachSessionAttributes.ContentState
    let isDegraded: Bool
    let hasEnded: Bool
    var body: some View {
        if hasEnded || isDegraded {
            Text("—")
                .font(.caption2.bold())
                .foregroundStyle(Palette.dim)
                .accessibilityLabel(hasEnded ? "Session ended" : "Conditions unavailable")
        } else if state.lightning?.active == true {
            Text("⚡")
                .foregroundStyle(Palette.lightning)
                .accessibilityLabel("Lightning near you")
        } else {
            Text("\(state.score)")
                .font(.caption2.bold().monospacedDigit())
                .foregroundStyle(effectiveAccent(state: state))
        }
    }
}

private struct ExpandedLeading: View {
    let state: BeachSessionAttributes.ContentState
    let isDegraded: Bool
    let hasEnded: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if hasEnded {
                Text("—")
                    .font(.title2.bold())
                    .foregroundStyle(Palette.dim)
                Text("Session ended")
                    .font(.caption2)
                    .foregroundStyle(Palette.dim)
                    .lineLimit(1)
            } else if isDegraded {
                Text("—")
                    .font(.title2.bold())
                    .foregroundStyle(Palette.dim)
                Text("Conditions unavailable")
                    .font(.caption2)
                    .foregroundStyle(Palette.dim)
                    .lineLimit(1)
            } else {
                Text("\(state.score)")
                    .font(.title2.bold().monospacedDigit())
                    .foregroundStyle(effectiveAccent(state: state))
                Text(shortVerdict(forScore: state.score))
                    .font(.caption2)
                    .foregroundStyle(Palette.dim)
                    .lineLimit(1)
            }
        }
    }
}

private struct ExpandedTrailing: View {
    let state: BeachSessionAttributes.ContentState
    let isDegraded: Bool
    let hasEnded: Bool
    var body: some View {
        if hasEnded {
            EmptyView()
        } else if isDegraded {
            Image(systemName: "wifi.slash")
                .foregroundStyle(Palette.dim)
                .accessibilityHidden(true)
        } else if let sunsetAt = state.sunsetAt {
            VStack(alignment: .trailing, spacing: 2) {
                Image(systemName: "sunset.fill")
                    .foregroundStyle(Palette.sand)
                    .accessibilityHidden(true)
                Text("Sunset in")
                    .frame(width: 0, height: 0)
                    .clipped()
                CountdownText(date: sunsetAt)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(Palette.dim)
            }
            .accessibilityElement(children: .combine)
        }
    }
}

private struct ExpandedBottom: View {
    let attributes: BeachSessionAttributes
    let state: BeachSessionAttributes.ContentState
    let isDegraded: Bool
    let hasEnded: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if hasEnded {
                EndedRow()
            } else if isDegraded {
                UnavailableRow()
            } else {
                if let lightning = state.lightning, lightning.active {
                    LightningRow(lightning: lightning)
                }
                HStack(spacing: 14) {
                    if let wind = state.windMph {
                        StatChip(symbol: "wind", text: "\(Int(wind.rounded())) mph")
                    }
                    if let wave = state.waveFt {
                        StatChip(symbol: "water.waves", text: String(format: "%.1f ft", wave))
                    }
                    if let clarity = BeachSessionFormat.clarityLabel(state.clarity) {
                        StatChip(symbol: "eye", text: clarity)
                    }
                    Spacer()
                }
            }
        }
    }
}
