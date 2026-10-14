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
        waterTempF: 84, dataAt: Date(), fetchedAt: Date()
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

        switch WidgetRefreshPolicy.plan(activeSlug: slug, cached: cached, now: now) {
        case .setup:
            // Nothing to refresh until a beach arrives; the app reloads us then.
            completion(Timeline(entries: [BeachEntry(date: now, content: .needsSetup)], policy: .never))

        case .useCache(let summary, let reload):
            completion(Timeline(entries: [BeachEntry(date: now, content: .summary(summary))], policy: .after(reload)))

        case .fetch:
            guard let slug else { return }
            Task {
                let entry: BeachEntry
                let reload: WidgetRefreshPolicy.Reload
                if let fresh = try? await ConditionsClient.fetch(slug: slug) {
                    WidgetFailureCounter.reset()
                    entry = BeachEntry(date: now, content: .summary(fresh))
                    reload = WidgetRefreshPolicy.reloadAfterSuccess(now: Date())
                } else {
                    let failures = WidgetFailureCounter.recordFailure()
                    // Show the last reading (the views mark it "as of") rather than nothing.
                    entry = BeachEntry(date: now, content: cached.map(ComplicationContent.summary) ?? .unavailable)
                    reload = WidgetRefreshPolicy.reloadAfterFailure(failures: failures, now: Date())
                }
                switch reload {
                case .never: completion(Timeline(entries: [entry], policy: .never))
                case .after(let date): completion(Timeline(entries: [entry], policy: .after(date)))
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
