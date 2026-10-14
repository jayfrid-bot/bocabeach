import XCTest
@testable import BeachDayWatch

/// The client's clock and cache rules, with the network and the clock injected.
final class ConditionsClientTests: XCTestCase {
    final class TestClock: @unchecked Sendable {
        var now: Date
        init(_ now: Date) { self.now = now }
    }

    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    private let iso = ISO8601DateFormatter()

    override func setUp() { super.setUp(); SummaryCache.remove("boca-raton") }
    override func tearDown() { SummaryCache.remove("boca-raton"); WidgetFailureCounter.reset("boca-raton"); super.tearDown() }

    private func body(score: Int = 80, builtAt: Date? = nil, validUntil: Date, slug: String = "boca-raton") -> Data {
        let built = builtAt ?? t0
        return Data(#"{"v":1,"slug":"\#(slug)","score":\#(score),"lines":[],"generatedAt":"\#(iso.string(from: built))","validUntil":"\#(iso.string(from: validUntil))"}"#.utf8)
    }

    private func response(_ status: Int = 200) -> HTTPURLResponse {
        HTTPURLResponse(url: URL(string: "https://app.isitbeachday.com/api/watch/boca-raton")!, statusCode: status, httpVersion: nil, headerFields: nil)!
    }

    func testReceiptTimeIsTakenAfterTheNetworkCallAndUsedForFetchedAt() async throws {
        let clock = TestClock(t0)
        let data = body(validUntil: t0.addingTimeInterval(600))
        let summary = try await ConditionsClient.fetch(slug: "boca-raton", save: false, clock: { clock.now }) { _ in
            clock.now = clock.now.addingTimeInterval(7)   // the request takes 7 seconds
            return (data, self.response())
        }
        XCTAssertEqual(summary.fetchedAt, t0.addingTimeInterval(7), "fetchedAt is when the answer arrived, not when the request started")
    }

    func testAnAnswerThatExpiredInTransitIsRejectedAndNeverCached() async {
        // Seed the cache with a good, older reading.
        let older = BeachSummary(slug: "boca-raton", name: "Boca Raton", score: 50, limitedData: false, lines: [], waterTempF: nil,
                                 dataAt: t0.addingTimeInterval(-300), validUntil: t0.addingTimeInterval(300), fetchedAt: t0)
        SummaryCache.save(older)

        let clock = TestClock(t0)
        // Valid for 60 seconds when requested; the transfer takes 90 (a suspended watch, a bad link).
        let data = body(validUntil: t0.addingTimeInterval(60))
        do {
            _ = try await ConditionsClient.fetch(slug: "boca-raton", clock: { clock.now }) { _ in
                clock.now = clock.now.addingTimeInterval(90)
                return (data, self.response())
            }
            XCTFail("expected .expired")
        } catch let error as ConditionsError {
            XCTAssertEqual(error, .expired)
        } catch { XCTFail("wrong error \(error)") }
        XCTAssertEqual(SummaryCache.load("boca-raton")?.score, 50, "the cache keeps what it had")
    }

    func testAnAnswerStillValidOnArrivalIsAcceptedAndCached() async throws {
        let clock = TestClock(t0)
        let data = body(score: 91, validUntil: t0.addingTimeInterval(60))
        let summary = try await ConditionsClient.fetch(slug: "boca-raton", clock: { clock.now }) { _ in
            clock.now = clock.now.addingTimeInterval(59)
            return (data, self.response())
        }
        XCTAssertEqual(summary.score, 91)
        XCTAssertEqual(SummaryCache.load("boca-raton")?.score, 91)
    }

    func testIncompleteAndWrongAnswersAreFailuresThatLeaveTheCacheAlone() async {
        func attempt(_ status: Int, _ data: Data) async -> ConditionsError? {
            do {
                _ = try await ConditionsClient.fetch(slug: "boca-raton", clock: { self.t0 }) { _ in (data, self.response(status)) }
                return nil
            } catch { return error as? ConditionsError }
        }
        let good = body(validUntil: t0.addingTimeInterval(600))
        let e503 = await attempt(503, Data(#"{"error":"incomplete"}"#.utf8))
        XCTAssertEqual(e503, .server(503))
        let e404 = await attempt(404, good)
        XCTAssertEqual(e404, .unknownBeach)
        let wrongSlug = await attempt(200, body(validUntil: t0.addingTimeInterval(600), slug: "naples"))
        XCTAssertEqual(wrongSlug, .badData)
        let junk = await attempt(200, Data("<html>".utf8))
        XCTAssertEqual(junk, .badData)
        XCTAssertNil(SummaryCache.load("boca-raton"))
    }

    func testAnOlderAnswerNeverOverwritesANewerCachedOne() {
        func summary(score: Int, builtMinutesAgo: Double) -> BeachSummary {
            BeachSummary(slug: "boca-raton", name: "Boca Raton", score: score, limitedData: false, lines: [], waterTempF: nil,
                         dataAt: t0.addingTimeInterval(-builtMinutesAgo * 60), validUntil: t0.addingTimeInterval(600), fetchedAt: t0)
        }
        XCTAssertEqual(SummaryCache.store(summary(score: 90, builtMinutesAgo: 1)).score, 90)
        // An answer the server built earlier arrives later (the widget's process, an old request).
        let kept = SummaryCache.store(summary(score: 10, builtMinutesAgo: 6))
        XCTAssertEqual(kept.score, 90, "the newer reading is returned and kept")
        XCTAssertEqual(SummaryCache.load("boca-raton")?.score, 90)
        // A newer one does replace it.
        XCTAssertEqual(SummaryCache.store(summary(score: 70, builtMinutesAgo: 0)).score, 70)
        XCTAssertEqual(SummaryCache.load("boca-raton")?.score, 70)
    }
}
