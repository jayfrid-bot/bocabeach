import XCTest
@testable import BeachDayWatch

/// How a reading is presented against the server's own validUntil, and which line leads.
final class SummaryPresentationTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func summary(_ lines: [SummaryLine], builtMinutesAgo: Double = 1, validInMinutes: Double = 14) -> BeachSummary {
        BeachSummary(slug: "boca-raton", name: "Boca Raton", score: 80, limitedData: false, lines: lines, waterTempF: 86,
                     dataAt: now.addingTimeInterval(-builtMinutesAgo * 60),
                     validUntil: now.addingTimeInterval(validInMinutes * 60),
                     fetchedAt: now.addingTimeInterval(-30))
    }

    private func line(_ kind: LineKind, _ text: String, _ tone: Tone) -> SummaryLine { SummaryLine(kind: kind, text: text, tone: tone) }

    func testHeadlineIsTheFirstRelevantLineInTheServersOrder() {
        // A double red flag ranks ahead of approaching rain on the server; it must stay ahead here.
        let s = summary([line(.safety, "Double red flag", .danger), line(.hazard, "Rain in ~20 min", .caution), line(.water, "Water 86\u{00B0}F", .calm)])
        XCTAssertEqual(s.headlineLine(now: now), "Double red flag")
        // An active rip alert ahead of a soft advisory.
        let s2 = summary([line(.safety, "Rip current alert", .danger), line(.hazard, "Beach Hazards Statement", .caution)])
        XCTAssertEqual(s2.headlineLine(now: now), "Rip current alert")
        // And the other way round: the server put the hazard first, so it leads.
        let s3 = summary([line(.hazard, "Lightning 3 mi away", .danger), line(.safety, "Yellow flag", .caution)])
        XCTAssertEqual(s3.headlineLine(now: now), "Lightning 3 mi away")
    }

    func testCalmSafetyLinesYieldToBestTimeThenWater() {
        let calm = [line(.safety, "Green flag \u{00B7} Rip current low", .calm), line(.water, "Water 86\u{00B0}F", .calm), line(.best, "Best 4\u{2013}6 PM", .calm)]
        XCTAssertEqual(summary(calm).headlineLine(now: now), "Best 4\u{2013}6 PM")
        XCTAssertEqual(summary(Array(calm.prefix(2))).headlineLine(now: now), "Water 86\u{00B0}F")
        XCTAssertEqual(summary([calm[0]]).headlineLine(now: now), "Green flag \u{00B7} Rip current low")
        XCTAssertNil(summary([]).headlineLine(now: now))
    }

    func testAnExpiredReadingHasNoHeadlineAndIsMarkedStale() {
        let alerting = [line(.hazard, "Lightning 3 mi away", .danger)]
        let current = summary(alerting, builtMinutesAgo: 1, validInMinutes: 14)
        XCTAssertFalse(current.isExpired(now: now))
        XCTAssertFalse(current.isStale(now: now))
        XCTAssertEqual(current.headlineLine(now: now), "Lightning 3 mi away")
        // Built 16 minutes ago, valid until a minute ago: well under 30 minutes old, but expired.
        let expired = summary(alerting, builtMinutesAgo: 16, validInMinutes: -1)
        XCTAssertTrue(expired.isExpired(now: now))
        XCTAssertTrue(expired.isStale(now: now), "an expired reading shows \"as of\", not as current")
        XCTAssertNil(expired.headlineLine(now: now), "an expired alert is not a headline")
        XCTAssertFalse(expired.isFresh(now: now))
    }

    func testAnOldReadingIsStaleEvenIfItsOwnValidityWasLong() {
        var s = summary([], builtMinutesAgo: 45, validInMinutes: 5)
        s.dataAt = now.addingTimeInterval(-45 * 60)
        XCTAssertTrue(s.isStale(now: now))
    }

    func testTheOpenAppRefreshesAtValidUntilWithAFloorAndBacksOffOnFailures() {
        let valid = now.addingTimeInterval(10 * 60)
        XCTAssertEqual(BeachStore.nextRefreshDelay(validUntil: valid, now: now, failures: 0), 10 * 60)
        // Very close or already past: never under the one-minute floor.
        XCTAssertEqual(BeachStore.nextRefreshDelay(validUntil: now.addingTimeInterval(5), now: now, failures: 0), 60)
        XCTAssertEqual(BeachStore.nextRefreshDelay(validUntil: now.addingTimeInterval(-600), now: now, failures: 0), 60)
        // After failures it doubles instead of retrying every minute, up to 15 minutes.
        let past = now.addingTimeInterval(-600)
        let delays = (1...6).map { BeachStore.nextRefreshDelay(validUntil: past, now: now, failures: $0) / 60 }
        XCTAssertEqual(delays, [2, 4, 8, 15, 15, 15])
    }
}
