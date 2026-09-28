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

/// Hazard-level accent for DECORATIVE, non-numeric surfaces only (currently
/// just the Dynamic Island's keyline tint) — turns red while lightning is
/// active regardless of score, same idea as the LightningRow banner. Never
/// use this for the score digit itself: see `scoreAccent` below for why.
private func effectiveAccent(state: BeachSessionAttributes.ContentState) -> Color {
    if state.lightning?.active == true { return Palette.lightning }
    return scoreAccent(forScore: state.score)
}

/// Full-sentence VoiceOver text for an active lightning hazard — shared by
/// every presentation that surfaces one (LightningRow on the Lock Screen and
/// DI expanded-bottom, CompactTrailing, MinimalView) so they all say the
/// same thing. Abbreviations like "mi" and "SW" in the visible text read
/// poorly aloud, so this spells out "miles" and the compass direction via
/// `cardinalSpoken`.
private func lightningAccessibilityLabel(miles: Double?, bearingDeg: Double?) -> String {
    if let miles {
        let dir = BeachSessionFormat.cardinalSpoken(fromDegrees: bearingDeg).map { " \($0)" } ?? ""
        let rounded = Int(miles.rounded())
        let unit = rounded == 1 ? "mile" : "miles"
        return "Lightning \(rounded) \(unit)\(dir). Get out of the water."
    }
    return "Lightning near you. Get out of the water."
}

/// The score digit's color, ALWAYS keyed to the score band and nothing else.
/// Root cause of the red-84-next-to-"Yes" bug: `effectiveAccent` used to be
/// called here too, so an active lightning flag forced the digit red even
/// when the score itself was still in a green/amber band (real data can hit
/// this — lib/liveActivity/state.ts's lightning field can come from a
/// device-anchored point read that differs from the beach-anchored read
/// score.ts caps the score with). The score digit must render what the
/// score says; the lightning banner and keyline carry the hazard warning.
private func scoreAccent(forScore score: Int) -> Color {
    Color(hex: BeachSessionVerdict.accentHex(forScore: score))
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

    /// Lightning active pulls the layout into a deliberately COMPACT mode:
    /// the banner itself already spends a full row, and Live Activities have
    /// a hard system height ceiling (~160pt at default text, less headroom
    /// at accessibility text sizes) — so lightning mode drops the footer row
    /// entirely (header + banner + at most one stats row) rather than risk
    /// the footer or the header verdict getting clipped.
    private var isLightningActive: Bool {
        !hasEnded && !isDegraded && state.lightning?.active == true
    }

    var body: some View {
        VStack(alignment: .leading, spacing: isLightningActive ? 8 : 10) {
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
            if !isLightningActive {
                footer
            }
        }
        .padding(16)
    }

    private var header: some View {
        // isLightningActive (not the raw `state.lightning?.active` flag)
        // already excludes hasEnded/isDegraded — the wire payload's
        // `lightning` field can be RETAINED on an ended or stale-unavailable
        // update (nothing zeroes it out), so gating on the raw flag here
        // would announce "Beach score N" over VoiceOver even while the
        // visible text (from headerVerdictText, which checks hasEnded/
        // isDegraded first) correctly says "Session ended" / "Conditions
        // unavailable". Using the same gated flag for both keeps the
        // spoken and visible states in agreement.
        return HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(attributes.beachName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.dim)
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(hasEnded ? "—" : (isDegraded ? "—" : "\(state.score)"))
                        .font(.system(size: 40, weight: .bold, design: .rounded))
                        .foregroundStyle((hasEnded || isDegraded) ? Palette.dim : scoreAccent(forScore: state.score))
                        .monospacedDigit()
                        // Lightning mode folds the number into the label's
                        // own accessibility text ("Beach score N out of
                        // 100") below, so VoiceOver doesn't read the digit
                        // twice.
                        .accessibilityHidden(isLightningActive)
                    Text(headerVerdictText(lightningActive: isLightningActive))
                        .font(.headline)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(2)
                        .minimumScaleFactor(0.75)
                        .accessibilityLabel(
                            isLightningActive ? "Beach score \(state.score) out of 100" : headerVerdictText(lightningActive: isLightningActive)
                        )
                }
            }
            Spacer()
            if !hasEnded {
                CountdownColumn(state: state)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// While lightning is active, the header must never assert a positive
    /// verdict ("Yes — good beach day") next to the red lightning banner —
    /// that combination is exactly the contradiction this fix removes, and
    /// it's reachable with real data, not just the demo: a device-anchored
    /// lightning point read (lib/liveActivity/state.ts's `lightningPoint`
    /// branch) can be active while the beach's own forecast-based score
    /// stays high, since score.ts only caps the score for a BEACH-anchored
    /// reading. So lightning mode shows a neutral "Beach score" label
    /// instead of any verdict word — true whether the score itself is high
    /// or the score.ts cap already pulled it down (see BeachSessionDemo's
    /// two lightning phases for both cases). `.minimumScaleFactor` (not
    /// `.fixedSize`) lets this shrink rather than clip if a larger Dynamic
    /// Type size leaves no room — a forced full-height verdict could exceed
    /// the Lock Screen's system height ceiling and get clipped outright.
    /// The number itself is NOT repeated here — the big digit to the left
    /// already shows it, so this just says "Beach score" (the digit is
    /// hidden from VoiceOver and this label's own accessibility text
    /// carries the number instead, so it's spoken exactly once).
    private func headerVerdictText(lightningActive: Bool) -> String {
        if hasEnded { return "Session ended" }
        if isDegraded { return "Conditions unavailable" }
        if lightningActive { return "Beach score" }
        return BeachSessionVerdict.verdict(forScore: state.score)
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

    /// Distance/direction inline in ONE short string, not a separate
    /// trailing element — "Lightning near you — get out of the water" (the
    /// earlier wording) needed an aggressive shrink to fit as a single line
    /// and became hard to read; folding "5 mi SW" into the main phrase
    /// keeps it short enough for a gentler, legible minimumScaleFactor.
    private var mainText: String {
        if let miles = lightning.miles {
            let dir = BeachSessionFormat.cardinal(fromDegrees: lightning.bearingDeg).map { " \($0)" } ?? ""
            return "Lightning \(String(format: "%.0f", miles)) mi\(dir) — leave the water"
        }
        return "Lightning near you — leave the water"
    }

    /// VoiceOver gets the fuller, spelled-out sentence — abbreviations like
    /// "mi" and "SW" read poorly aloud. Shared with CompactTrailing and
    /// MinimalView (see `lightningAccessibilityLabel`) so every Dynamic
    /// Island presentation says the same thing as the Lock Screen.
    private var accessibilityText: String {
        lightningAccessibilityLabel(miles: lightning.miles, bearingDeg: lightning.bearingDeg)
    }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "cloud.bolt.fill")
                .foregroundStyle(Palette.lightning)
            // lineLimit(1), NOT lineLimit(2): a Live Activity's Lock Screen
            // presentation renders in a system-fixed-height container that
            // does not grow to fit a second line just because lineLimit
            // allows it (confirmed empirically). minimumScaleFactor is a
            // gentle 0.75 floor now that distance/direction fold into this
            // one short phrase instead of a separate trailing element —
            // there's no longer a long string that needs an aggressive
            // shrink to fit.
            Text(mainText)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Palette.lightning)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity)
        .background(Palette.lightning.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
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
                .foregroundStyle(scoreAccent(forScore: state.score))
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
            .accessibilityLabel(lightningAccessibilityLabel(miles: lightning.miles, bearingDeg: lightning.bearingDeg))
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
                .accessibilityLabel(lightningAccessibilityLabel(miles: state.lightning?.miles, bearingDeg: state.lightning?.bearingDeg))
        } else {
            Text("\(state.score)")
                .font(.caption2.bold().monospacedDigit())
                .foregroundStyle(scoreAccent(forScore: state.score))
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
                    .foregroundStyle(scoreAccent(forScore: state.score))
                    // Same reasoning as the Lock Screen header: the label
                    // below already says the number for VoiceOver when
                    // lightning is active, so don't say it twice.
                    .accessibilityHidden(state.lightning?.active == true)
                // Same rule as the Lock Screen header: ExpandedBottom shows
                // the LightningRow banner in this same expanded presentation,
                // so no verdict word here either while lightning is active.
                Text(state.lightning?.active == true ? "Beach score" : shortVerdict(forScore: state.score))
                    .font(.caption2)
                    .foregroundStyle(Palette.dim)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .accessibilityLabel(
                        state.lightning?.active == true ? "Beach score \(state.score) out of 100" : shortVerdict(forScore: state.score)
                    )
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
