//
//  BeachDayWatchWidget.swift
//
//  Apple Watch complications and Smart Stack widget: the Beach Day score for
//  the beach the watch app is showing (home from the iPhone, or the one
//  picked on the watch).
//
//  Refresh: one entry per load and a reload request after 30 minutes (15 when
//  the last load failed). watchOS decides the real timing within its budget.
//  The watch app also asks for a reload whenever it gets fresh data or a new
//  home beach arrives from the phone.
//

import SwiftUI
import WidgetKit

@main
struct BeachDayWatchWidgetBundle: WidgetBundle {
    var body: some Widget {
        BeachScoreWidget()
    }
}

struct BeachEntry: TimelineEntry {
    let date: Date
    let content: ComplicationContent
}

struct BeachProvider: TimelineProvider {
    static let sample = BeachSummary(
        slug: "boca-raton", name: "Boca Raton", score: 82, limitedData: false,
        hazard: nil, safety: SummaryLine(text: "Green flag \u{00B7} Rip low", tone: .calm),
        waterTempF: 84, best: "Best 10 AM\u{2013}1 PM", dataAt: Date(), fetchedAt: Date()
    )

    func placeholder(in context: Context) -> BeachEntry {
        BeachEntry(date: Date(), content: .summary(Self.sample))
    }

    func getSnapshot(in context: Context, completion: @escaping (BeachEntry) -> Void) {
        if context.isPreview {
            completion(placeholder(in: context))
            return
        }
        Task { completion(BeachEntry(date: Date(), content: await Self.load().content)) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<BeachEntry>) -> Void) {
        Task {
            let result = await Self.load()
            let now = Date()
            let next = now.addingTimeInterval(result.ok ? 30 * 60 : 15 * 60)
            completion(Timeline(entries: [BeachEntry(date: now, content: result.content)], policy: .after(next)))
        }
    }

    /// Fresh data when the network answers, else the last cached reading.
    private static func load() async -> (content: ComplicationContent, ok: Bool) {
        guard let slug = BeachSelection.activeSlug else { return (.needsSetup, true) }
        if let fresh = try? await ConditionsClient.fetch(slug: slug) { return (.summary(fresh), true) }
        if let cached = SummaryCache.load(slug) { return (.summary(cached), false) }
        return (.unavailable, false)
    }
}

struct BeachScoreWidget: Widget {
    let kind = "BeachDayScore"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: BeachProvider()) { entry in
            ComplicationView(content: entry.content, now: entry.date)
                .containerBackground(Color.clear, for: .widget)
        }
        .configurationDisplayName("Beach Day")
        .description("The Beach Day score for your beach.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}
