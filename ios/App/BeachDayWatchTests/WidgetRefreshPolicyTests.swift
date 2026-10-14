import XCTest
@testable import BeachDayWatch

final class WidgetRefreshPolicyTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    /// A reading the server built `builtMinutesAgo` ago and calls valid until `validInMinutes` from now.
    private func cached(slug: String = "boca-raton", builtMinutesAgo: Double = 2, validInMinutes: Double = 13) -> BeachSummary {
        BeachSummary(slug: slug, name: "Boca Raton", score: 80, limitedData: false, lines: [],
                     waterTempF: nil, dataAt: now.addingTimeInterval(-builtMinutesAgo * 60),
                     validUntil: now.addingTimeInterval(validInMinutes * 60),
                     fetchedAt: now.addingTimeInterval(-60))
    }

    func testNoBeachMeansSetupAndNoReload() {
        XCTAssertEqual(WidgetRefreshPolicy.plan(activeSlug: nil, cached: nil, now: now), .setup)
        XCTAssertEqual(WidgetRefreshPolicy.plan(activeSlug: nil, cached: cached(), now: now), .setup)
    }

    func testACurrentCacheIsUsedWithoutNetworkAndWakesAtValidUntil() {
        let c = cached(validInMinutes: 13)
        guard case .useCache(let used, let reload) = WidgetRefreshPolicy.plan(activeSlug: "boca-raton", cached: c, now: now) else {
            return XCTFail("expected cache")
        }
        XCTAssertEqual(used, c)
        XCTAssertEqual(reload, c.validUntil)
    }

    func testValidUntilVeryCloseStillWaitsAtLeastTheMinimumGap() {
        guard case .useCache(_, let reload) = WidgetRefreshPolicy.plan(activeSlug: "boca-raton", cached: cached(validInMinutes: 1), now: now) else {
            return XCTFail("expected cache")
        }
        XCTAssertGreaterThanOrEqual(reload.timeIntervalSince(now), 5 * 60)
    }

    func testAReadingPastItsServerValidityFetchesEvenIfJustReceived() {
        // Received 1 minute ago, but the server's own clock says it expired 2 minutes ago.
        XCTAssertEqual(WidgetRefreshPolicy.plan(activeSlug: "boca-raton", cached: cached(builtMinutesAgo: 17, validInMinutes: -2), now: now), .fetch)
    }

    func testMissingOrOtherBeachCacheFetches() {
        XCTAssertEqual(WidgetRefreshPolicy.plan(activeSlug: "boca-raton", cached: nil, now: now), .fetch)
        XCTAssertEqual(WidgetRefreshPolicy.plan(activeSlug: "naples", cached: cached(), now: now), .fetch)
    }

    func testFailureBackoffDoublesAndCaps() {
        let minutes = (1...6).map { WidgetRefreshPolicy.backoff(afterFailures: $0) / 60 }
        XCTAssertEqual(minutes, [30, 60, 120, 120, 120, 120])
        XCTAssertEqual(WidgetRefreshPolicy.backoff(afterFailures: 0) / 60, 30)
        XCTAssertEqual(WidgetRefreshPolicy.backoff(afterFailures: 10_000) / 60, 120)
    }

    func testReloadDates() {
        XCTAssertEqual(WidgetRefreshPolicy.reloadAfterSuccess(validUntil: now.addingTimeInterval(13 * 60), now: now),
                       .after(now.addingTimeInterval(13 * 60)))
        XCTAssertEqual(WidgetRefreshPolicy.reloadAfterSuccess(validUntil: now.addingTimeInterval(60), now: now),
                       .after(now.addingTimeInterval(5 * 60)))
        XCTAssertEqual(WidgetRefreshPolicy.reloadAfterFailure(failures: 3, now: now), .after(now.addingTimeInterval(120 * 60)))
    }

    func testFailureStreaksAreKeptPerBeachAndAnySuccessClearsThem() {
        WidgetFailureCounter.reset("boca-raton"); WidgetFailureCounter.reset("naples")
        defer { WidgetFailureCounter.reset("boca-raton"); WidgetFailureCounter.reset("naples") }
        XCTAssertEqual(WidgetFailureCounter.recordFailure("boca-raton"), 1)
        XCTAssertEqual(WidgetFailureCounter.recordFailure("boca-raton"), 2)
        XCTAssertEqual(WidgetFailureCounter.recordFailure("boca-raton"), 3)
        // Another beach starts from zero, so switching beaches never inherits a long backoff.
        XCTAssertEqual(WidgetFailureCounter.count("naples"), 0)
        XCTAssertEqual(WidgetFailureCounter.recordFailure("naples"), 1)
        // A success for a beach (the app's fetch or the widget's) clears that beach only.
        WidgetFailureCounter.reset("boca-raton")
        XCTAssertEqual(WidgetFailureCounter.count("boca-raton"), 0)
        XCTAssertEqual(WidgetFailureCounter.count("naples"), 1)
    }
}
