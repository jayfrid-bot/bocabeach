//
//  BeachDayWatchWidget.swift
//
//  Apple Watch complications and Smart Stack widget: the Beach Day score for
//  the beach the watch app is showing (home from the iPhone, or the one
//  picked on the watch).
//
//  Refresh policy: WatchShared/WidgetRefreshPolicy.swift. A reading received
//  in the last 30 minutes is shown without a request; failures back off 30, 60,
//  120 minutes; no beach chosen means no reload at all. The watch app reloads
//  the widget once, after it saves new data.
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
        lines: [
            SummaryLine(kind: .safety, text: "Green flag \u{00B7} Rip low", tone: .calm),
            SummaryLine(kind: .water, text: "Water 84\u{00B0}F", tone: .calm),
            SummaryLine(kind: .best, text: "Best 10 AM\u{2013}1 PM", tone: .calm),
        ],
        waterTempF: 84, dataAt: Date(), validUntil: Date().addingTimeInterval(900), fetchedAt: Date()
    )

    func placeholder(in context: Context) -> BeachEntry {
        BeachEntry(date: Date(), content: .summary(Self.sample))
    }

    /// Cache only. A snapshot backs the widget gallery and previews and must
    /// return at once, never wait on the network.
    func getSnapshot(in context: Context, completion: @escaping (BeachEntry) -> Void) {
        if context.isPreview {
            completion(placeholder(in: context))
            return
        }
        let slug = BeachSelection.activeSlug
        let content: ComplicationContent
        if let slug {
            content = SummaryCache.load(slug).map(ComplicationContent.summary) ?? .unavailable
        } else {
            content = .needsSetup
        }
        completion(BeachEntry(date: Date(), content: content))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<BeachEntry>) -> Void) {
        let now = Date()
        let slug = BeachSelection.activeSlug
        let cached = slug.flatMap(SummaryCache.load)

        /// A reading, drawn now and again at its validUntil (so it flips to "as of" on time).
        func entries(for summary: BeachSummary, from start: Date) -> [BeachEntry] {
            WidgetRefreshPolicy.entryDates(from: start, validUntil: summary.validUntil)
                .map { BeachEntry(date: $0, content: .summary(summary)) }
        }

        switch WidgetRefreshPolicy.plan(activeSlug: slug, cached: cached, now: now) {
        case .setup:
            // Nothing to refresh until a beach arrives; the app reloads us then.
            completion(Timeline(entries: [BeachEntry(date: now, content: .needsSetup)], policy: .never))

        case .useCache(let summary, let reload):
            completion(Timeline(entries: entries(for: summary, from: now), policy: .after(reload)))

        case .fetch:
            guard let slug else { return }
            Task {
                var timelineEntries: [BeachEntry]
                let reload: WidgetRefreshPolicy.Reload
                if let fresh = try? await ConditionsClient.fetch(slug: slug) {
                    // Dated from when the answer ARRIVED, not from when this ran.
                    timelineEntries = entries(for: fresh, from: fresh.fetchedAt)
                    // Wake when the server says this stops being current, not sooner than the budget allows.
                    reload = WidgetRefreshPolicy.reloadAfterSuccess(validUntil: fresh.validUntil, now: Date())
                } else {
                    let failures = WidgetFailureCounter.recordFailure(slug)
                    let arrived = Date()
                    // Show the last reading (the views mark it "as of" once it has lapsed) rather than nothing.
                    if let cached {
                        timelineEntries = entries(for: cached, from: arrived)
                    } else {
                        timelineEntries = [BeachEntry(date: arrived, content: .unavailable)]
                    }
                    reload = WidgetRefreshPolicy.reloadAfterFailure(failures: failures, now: arrived)
                }
                switch reload {
                case .never: completion(Timeline(entries: timelineEntries, policy: .never))
                case .after(let date): completion(Timeline(entries: timelineEntries, policy: .after(date)))
                }
            }
        }
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
