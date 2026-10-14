//
//  ComplicationViews.swift
//
//  The circular, rectangular and inline complication views. Compiled into
//  both the widget extension (where WidgetKit draws them) and the watch app
//  (where a DEBUG-only gallery draws them for screenshots).
//

import SwiftUI
import WidgetKit

enum ComplicationContent {
    case summary(BeachSummary)
    /// No beach chosen yet.
    case needsSetup
    /// A beach is chosen but nothing has loaded and nothing is cached.
    case unavailable
}

struct ComplicationView: View {
    @Environment(\.widgetFamily) private var family
    let content: ComplicationContent
    var now: Date = Date()

    var body: some View {
        switch family {
        case .accessoryRectangular: RectangularComplication(content: content, now: now)
        case .accessoryInline: InlineComplication(content: content, now: now)
        default: CircularComplication(content: content, now: now)
        }
    }
}

struct CircularComplication: View {
    let content: ComplicationContent
    var now: Date = Date()

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            switch content {
            case .summary(let s):
                if let score = s.displayScore {
                    let band = ScoreBands.band(for: score)
                    Gauge(value: Double(score), in: 0...100) {
                        Image(systemName: "beach.umbrella")
                    } currentValueLabel: {
                        Text("\(score)")
                            .font(.system(.title3, design: .rounded).weight(.semibold))
                            .minimumScaleFactor(0.6)
                            .foregroundStyle(band.color)
                    }
                    .gaugeStyle(.accessoryCircular)
                    .tint(band.color)
                    .opacity(s.isStale(now: now) ? 0.6 : 1)
                } else {
                    Image(systemName: "questionmark")
                }
            case .needsSetup, .unavailable:
                Image(systemName: "beach.umbrella")
                    .font(.title3)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken(content, now: now))
    }
}

struct RectangularComplication: View {
    let content: ComplicationContent
    var now: Date = Date()

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            switch content {
            case .summary(let s):
                Text(s.name)
                    .font(.headline)
                    .widgetAccentable()
                    .lineLimit(1)
                if let score = s.displayScore, let rating = s.rating {
                    HStack(spacing: 4) {
                        Text("\(score)")
                            .font(.system(.title3, design: .rounded).weight(.bold))
                            .foregroundStyle(ScoreBands.band(for: score).color)
                            .widgetAccentable()
                        Text(rating)
                            .font(.subheadline)
                            .lineLimit(1)
                    }
                } else {
                    Text("Conditions unavailable").font(.subheadline)
                }
                Text(s.isStale(now: now) ? "as of \(s.asOfText())" : (s.headlineLine ?? " "))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            case .needsSetup:
                Text("Beach Day").font(.headline).widgetAccentable()
                Text("Open the app to choose a beach").font(.caption2).foregroundStyle(.secondary)
            case .unavailable:
                Text("Beach Day").font(.headline).widgetAccentable()
                Text("Conditions unavailable").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken(content, now: now))
    }
}

struct InlineComplication: View {
    let content: ComplicationContent
    var now: Date = Date()

    var body: some View {
        Group {
            switch content {
            case .summary(let s):
                if let score = s.displayScore, let rating = s.rating {
                    Label("\(score) \(rating)", systemImage: "beach.umbrella")
                } else {
                    Label("Beach Day unavailable", systemImage: "beach.umbrella")
                }
            default:
                Label("Choose a beach", systemImage: "beach.umbrella")
            }
        }
        .accessibilityLabel(spoken(content, now: now))
    }
}

/// VoiceOver text: "Delray Beach. Beach Day score 82, Good. Yellow flag."
private func spoken(_ content: ComplicationContent, now: Date) -> String {
    switch content {
    case .summary(let s):
        var parts = [s.name, s.scoreSpokenLabel]
        if let line = s.headlineLine { parts.append(line) }
        if s.isStale(now: now) { parts.append("as of \(s.asOfText())") }
        return parts.joined(separator: ". ")
    case .needsSetup:
        return "Beach Day. Open the app to choose a beach."
    case .unavailable:
        return "Beach Day. Conditions unavailable."
    }
}
