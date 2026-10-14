import XCTest
@testable import BeachDayWatch

final class WidgetRefreshPolicyTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func cached(slug: String = "boca-raton", receivedMinutesAgo: Double) -> BeachSummary {
        BeachSummary(slug: slug, name: "Boca Raton", score: 80, limitedData: false, lines: [],
                     waterTempF: nil, dataAt: now.addingTimeInterval(-receivedMinutesAgo * 60 - 600),
                     fetchedAt: now.addingTimeInterval(-receivedMinutesAgo * 60))
    }

    func testNoBeachMeansSetupAndNoReload() {
        XCTAssertEqual(WidgetRefreshPolicy.plan(activeSlug: nil, cached: nil, now: now), .setup)
        XCTAssertEqual(WidgetRefreshPolicy.plan(activeSlug: nil, cached: cached(receivedMinutesAgo: 1), now: now), .setup)
    }

    func testFreshCacheIsUsedWithoutNetworkAndReloadsThirtyMinutesAfterItArrived() {
        let c = cached(receivedMinutesAgo: 10)
        guard case .useCache(let used, let reload) = WidgetRefreshPolicy.plan(activeSlug: "boca-raton", cached: c, now: now) else {
            return XCTFail("expected cache")
        }
        XCTAssertEqual(used, c)
        XCTAssertEqual(reload, c.fetchedAt.addingTimeInterval(30 * 60))
    }

    func testCacheNearlyExpiredStillWaitsAtLeastFiveMinutes() {
        let c = cached(receivedMinutesAgo: 29)
        guard case .useCache(_, let reload) = WidgetRefreshPolicy.plan(activeSlug: "boca-raton", cached: c, now: now) else {
            return XCTFail("expected cache")
        }
        XCTAssertGreaterThanOrEqual(reload.timeIntervalSince(now), 5 * 60)
    }

    func testOldMissingOrOtherBeachCacheFetches() {
        XCTAssertEqual(WidgetRefreshPolicy.plan(activeSlug: "boca-raton", cached: cached(receivedMinutesAgo: 31), now: now), .fetch)
        XCTAssertEqual(WidgetRefreshPolicy.plan(activeSlug: "boca-raton", cached: nil, now: now), .fetch)
        XCTAssertEqual(WidgetRefreshPolicy.plan(activeSlug: "naples", cached: cached(receivedMinutesAgo: 1), now: now), .fetch)
    }

    func testCacheFromTheFutureIsNotTrusted() {
        XCTAssertEqual(WidgetRefreshPolicy.plan(activeSlug: "boca-raton", cached: cached(receivedMinutesAgo: -10), now: now), .fetch)
    }

    func testFailureBackoffDoublesAndCaps() {
        let minutes = (1...6).map { WidgetRefreshPolicy.backoff(afterFailures: $0) / 60 }
        XCTAssertEqual(minutes, [30, 60, 120, 120, 120, 120])
        XCTAssertEqual(WidgetRefreshPolicy.backoff(afterFailures: 0) / 60, 30)
        XCTAssertEqual(WidgetRefreshPolicy.backoff(afterFailures: 10_000) / 60, 120)
    }

    func testReloadDates() {
        XCTAssertEqual(WidgetRefreshPolicy.reloadAfterSuccess(now: now), .after(now.addingTimeInterval(30 * 60)))
        XCTAssertEqual(WidgetRefreshPolicy.reloadAfterFailure(failures: 3, now: now), .after(now.addingTimeInterval(120 * 60)))
    }
}
