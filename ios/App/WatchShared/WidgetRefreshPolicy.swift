//
//  WidgetRefreshPolicy.swift
//
//  When the complication asks the network and when it asks the system to wake
//  it again. Pure functions, unit-tested (BeachDayWatchTests). watchOS gives a
//  frequently viewed widget roughly 40 to 70 reloads a day, so:
//    - a cached reading received in the last 30 minutes is used without any request;
//    - a failure backs off 30, 60, 120 minutes and stays at 120;
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
        /// Fresh enough: show it, and wake at `reload` (30 minutes after it arrived).
        case useCache(BeachSummary, reload: Date)
        /// Cache is missing or old: ask the network.
        case fetch
    }

    static let successInterval: TimeInterval = 30 * 60
    static let maxBackoff: TimeInterval = 120 * 60
    /// Never ask to be woken sooner than this, however little of the 30 minutes is left.
    static let minimumGap: TimeInterval = 5 * 60

    static func plan(activeSlug: String?, cached: BeachSummary?, now: Date) -> Plan {
        guard let slug = activeSlug else { return .setup }
        if let cached, cached.slug == slug, cached.isFresh(now: now) {
            let due = cached.fetchedAt.addingTimeInterval(successInterval)
            return .useCache(cached, reload: max(due, now.addingTimeInterval(minimumGap)))
        }
        return .fetch
    }

    /// 30, 60, 120, 120, ... minutes after the 1st, 2nd, 3rd, ... failure in a row.
    static func backoff(afterFailures failures: Int) -> TimeInterval {
        let n = max(1, failures)
        let steps = min(n - 1, 8)
        return min(successInterval * pow(2, Double(steps)), maxBackoff)
    }

    static func reloadAfterSuccess(now: Date) -> Reload { .after(now.addingTimeInterval(successInterval)) }

    static func reloadAfterFailure(failures: Int, now: Date) -> Reload {
        .after(now.addingTimeInterval(backoff(afterFailures: failures)))
    }
}

/// Failures in a row, kept in the App Group so each timeline run sees the last one.
enum WidgetFailureCounter {
    private static let key = "widget.failures"

    static var count: Int { SharedStore.defaults.integer(forKey: key) }
    static func recordFailure() -> Int {
        let n = count + 1
        SharedStore.defaults.set(n, forKey: key)
        return n
    }
    static func reset() { SharedStore.defaults.removeObject(forKey: key) }
}
