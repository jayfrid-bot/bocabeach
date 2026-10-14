//
//  WidgetRefreshPolicy.swift
//
//  When the complication asks the network and when it asks the system to wake
//  it again. Pure functions, unit-tested (BeachDayWatchTests). watchOS gives a
//  frequently viewed widget roughly 40 to 70 reloads a day, so:
//    - a cached reading is used without any request while the SERVER says it is
//      current (BeachSummary.validUntil: at most 15 minutes after the snapshot,
//      sooner at an alert boundary), and the widget asks to wake at validUntil;
//    - a failure backs off 30, 60, 120 minutes and stays at 120, counted per beach
//      and cleared by any success for that beach;
//    - with no beach chosen there is nothing to refresh (.never); the app
//      reloads the widget when a beach arrives;
//    - snapshots (the widget gallery, previews) never touch the network.
//

import Foundation

enum WidgetRefreshPolicy {
    enum Reload: Equatable {
        case never
        case after(Date)
    }

    enum Plan: Equatable {
        /// No beach chosen: show the setup face and do not ask to be woken.
        case setup
        /// Current by the server's clock: show it, and wake at `reload` (its validUntil).
        case useCache(BeachSummary, reload: Date)
        /// Cache is missing or old: ask the network.
        case fetch
    }

    static let successInterval: TimeInterval = 30 * 60
    static let maxBackoff: TimeInterval = 120 * 60
    /// Never ask to be woken sooner than this, however close validUntil is.
    static let minimumGap: TimeInterval = 5 * 60

    static func plan(activeSlug: String?, cached: BeachSummary?, now: Date) -> Plan {
        guard let slug = activeSlug else { return .setup }
        if let cached, cached.slug == slug, cached.isFresh(now: now) {
            return .useCache(cached, reload: max(cached.validUntil, now.addingTimeInterval(minimumGap)))
        }
        return .fetch
    }

    /// 30, 60, 120, 120, ... minutes after the 1st, 2nd, 3rd, ... failure in a row.
    static func backoff(afterFailures failures: Int) -> TimeInterval {
        let n = max(1, failures)
        let steps = min(n - 1, 8)
        return min(successInterval * pow(2, Double(steps)), maxBackoff)
    }

    /// After a fetch: wake when the server says the view stops being current.
    static func reloadAfterSuccess(validUntil: Date, now: Date) -> Reload {
        .after(max(validUntil, now.addingTimeInterval(minimumGap)))
    }

    static func reloadAfterFailure(failures: Int, now: Date) -> Reload {
        .after(now.addingTimeInterval(backoff(afterFailures: failures)))
    }
}

/// Failures in a row, per beach, kept in the App Group so each timeline run sees
/// the last one. Any success for the beach (the app's or the widget's) clears it.
enum WidgetFailureCounter {
    private static func key(_ slug: String) -> String { "widget.failures.\(slug)" }

    static func count(_ slug: String) -> Int { SharedStore.defaults.integer(forKey: key(slug)) }

    @discardableResult
    static func recordFailure(_ slug: String) -> Int {
        let n = count(slug) + 1
        SharedStore.defaults.set(n, forKey: key(slug))
        return n
    }

    static func reset(_ slug: String) { SharedStore.defaults.removeObject(forKey: key(slug)) }
}
