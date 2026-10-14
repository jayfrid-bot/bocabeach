import XCTest
@testable import BeachDayWatch

final class WatchViewDecoderTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func summary(_ json: String, slug: String = "boca-raton") -> BeachSummary? {
        guard let dto = WatchViewDecoder.decode(Data(json.utf8), expectedSlug: slug) else { return nil }
        return WatchViewDecoder.summary(from: dto, slug: slug, fetchedAt: now)
    }

    func testFullPayload() throws {
        let s = try XCTUnwrap(summary("""
        {"v":1,"slug":"boca-raton","name":"Boca Raton","score":79,"rating":"Good","band":"good","limitedData":false,
         "lines":[{"kind":"hazard","text":"Water quality advisory","tone":"danger"},
                  {"kind":"safety","text":"Yellow + purple flags \\u00b7 Rip low","tone":"caution"},
                  {"kind":"water","text":"Water 86\\u00b0F","tone":"calm"},
                  {"kind":"best","text":"Best 3\\u20137 PM","tone":"calm"}],
         "waterTempF":86,"generatedAt":"2026-10-14T19:58:20.051Z","capturedAt":"2026-10-14T20:00:00.000Z",
         "validUntil":"2026-10-14T20:05:00.000Z"}
        """))
        XCTAssertEqual(s.name, "Boca Raton")
        XCTAssertEqual(s.score, 79)
        XCTAssertEqual(s.rating, "Good")
        XCTAssertEqual(s.lines.map(\.kind), [.hazard, .safety, .water, .best])
        XCTAssertEqual(s.firstLine(.hazard)?.tone, .danger)
        XCTAssertEqual(s.waterTempF, 86)
        XCTAssertEqual(s.headlineLine(now: ISODate.parse("2026-10-14T20:00:00Z")!), "Water quality advisory")
        XCTAssertEqual(ISODate.parse("2026-10-14T19:58:20.051Z"), s.dataAt)
        XCTAssertEqual(s.validUntil, ISODate.parse("2026-10-14T20:05:00.000Z"))
    }

    func testValidUntilIsCappedAtFifteenMinutesAndDefaultsToIt() throws {
        let built = ISODate.parse("2026-10-14T19:58:20Z")!
        let capped = try XCTUnwrap(summary(#"{"v":1,"generatedAt":"2026-10-14T19:58:20Z","validUntil":"2026-10-14T23:00:00Z"}"#))
        XCTAssertEqual(capped.validUntil, built.addingTimeInterval(15 * 60))
        let missing = try XCTUnwrap(summary(#"{"v":1,"generatedAt":"2026-10-14T19:58:20Z"}"#))
        XCTAssertEqual(missing.validUntil, built.addingTimeInterval(15 * 60))
        let junk = try XCTUnwrap(summary(#"{"v":1,"generatedAt":"2026-10-14T19:58:20Z","validUntil":"later"}"#))
        XCTAssertEqual(junk.validUntil, built.addingTimeInterval(15 * 60))
        let early = try XCTUnwrap(summary(#"{"v":1,"generatedAt":"2026-10-14T19:58:20Z","validUntil":"2026-10-14T19:59:00Z"}"#))
        XCTAssertEqual(early.validUntil, ISODate.parse("2026-10-14T19:59:00Z"))
    }

    func testOnlyVersionOneIsAccepted() {
        XCTAssertNotNil(summary(#"{"v":1}"#))
        XCTAssertNil(summary(#"{"v":2,"score":80}"#))
        XCTAssertNil(summary(#"{"v":0}"#))
        XCTAssertNil(summary(#"{"v":"1"}"#))
        XCTAssertNil(summary(#"{"score":80}"#))
    }

    func testAMismatchedSlugIsRejectedAndAMissingOneIsAllowed() {
        XCTAssertNil(summary(#"{"v":1,"slug":"naples","score":90}"#, slug: "boca-raton"))
        XCTAssertNotNil(summary(#"{"v":1,"slug":"boca-raton","score":90}"#, slug: "boca-raton"))
        XCTAssertNotNil(summary(#"{"v":1,"score":90}"#, slug: "boca-raton"))
    }

    func testAnUnknownOrMissingToneIsACautionNotAllClear() throws {
        let s = try XCTUnwrap(summary(#"{"v":1,"lines":[{"kind":"hazard","text":"A","tone":"weird"},{"kind":"hazard","text":"B"},{"kind":"water","text":"C","tone":"calm"}]}"#))
        XCTAssertEqual(s.lines.map(\.tone), [.caution, .caution, .calm])
    }

    func testEmptyObjectWithVersionIsHonestlyUnavailable() throws {
        let s = try XCTUnwrap(summary(#"{"v":1}"#, slug: "south-padre-island"))
        XCTAssertNil(s.score)
        XCTAssertEqual(s.name, "South Padre Island")
        XCTAssertTrue(s.lines.isEmpty)
        XCTAssertEqual(s.dataAt, now)
        XCTAssertEqual(s.scoreSpokenLabel, "Beach Day conditions unavailable")
    }

    func testBodiesThatAreNotThisEndpointAreRejected() {
        XCTAssertNil(summary("{}"))
        XCTAssertNil(summary(#"{"error":"Unknown location"}"#))
        XCTAssertNil(summary("<html>captive portal</html>"))
        XCTAssertNil(summary("[]"))
        XCTAssertNil(summary(""))
    }

    func testWrongTypesReadAsMissingNotAsFailure() throws {
        let s = try XCTUnwrap(summary(#"{"v":1,"name":7,"score":"high","limitedData":"yes","waterTempF":[],"lines":"none"}"#))
        XCTAssertNil(s.score)
        XCTAssertNil(s.waterTempF)
        XCTAssertFalse(s.limitedData)
        XCTAssertTrue(s.lines.isEmpty)
        XCTAssertEqual(s.name, "Boca Raton")
    }

    func testOneBadLineDoesNotLoseTheOthers() throws {
        let s = try XCTUnwrap(summary("""
        {"v":1,"score":80,"lines":[7,{"text":99},{"kind":"water","text":"Water 80\\u00b0F","tone":"weird"},
          {"kind":"best","text":"   "},null,{"kind":"safety","text":"Green flag","tone":"calm"}]}
        """))
        XCTAssertEqual(s.lines.map(\.text), ["Water 80\u{00B0}F", "Green flag"])
        XCTAssertEqual(s.lines[0].tone, .caution) // an unknown tone is a caution, never "all clear"
    }

    func testOverlongAndExcessLinesAreBounded() throws {
        let long = String(repeating: "x", count: 200)
        let many = (0..<20).map { #"{"kind":"other","text":"L\#($0)"}"# }.joined(separator: ",")
        let s = try XCTUnwrap(summary(#"{"v":1,"lines":[{"text":"\#(long)"},\#(many)]}"#))
        XCTAssertEqual(s.lines.count, WatchViewDecoder.maxLines)
        XCTAssertFalse(s.lines.contains { $0.text.count > WatchViewDecoder.maxLineLength })
        // The overlong line is kept, cut with an ellipsis, not dropped.
        XCTAssertEqual(s.lines[0].text.count, WatchViewDecoder.maxLineLength)
        XCTAssertTrue(s.lines[0].text.hasSuffix("\u{2026}"))
    }

    func testNumbersAreCheckedBeforeAnyIntConversion() {
        XCTAssertEqual(WatchViewDecoder.wholeNumber(79.6, in: 0...100), 80)
        XCTAssertNil(WatchViewDecoder.wholeNumber(.nan, in: 0...100))
        XCTAssertNil(WatchViewDecoder.wholeNumber(.infinity, in: 0...100))
        XCTAssertNil(WatchViewDecoder.wholeNumber(-.infinity, in: 0...100))
        XCTAssertNil(WatchViewDecoder.wholeNumber(1e300, in: 0...100))
        XCTAssertNil(WatchViewDecoder.wholeNumber(-1, in: 0...100))
        XCTAssertNil(WatchViewDecoder.wholeNumber(101, in: 0...100))
        XCTAssertNil(WatchViewDecoder.wholeNumber(nil, in: 0...100))
    }

    func testOutOfRangeNumbersFromTheServerDoNotTrap() throws {
        let s = try XCTUnwrap(summary(#"{"v":1,"score":1e300,"waterTempF":9e99}"#))
        XCTAssertNil(s.score)
        XCTAssertNil(s.waterTempF)
        let s2 = try XCTUnwrap(summary(#"{"v":1,"score":-4,"waterTempF":400}"#))
        XCTAssertNil(s2.score)
        XCTAssertNil(s2.waterTempF)
    }

    func testBadDatesFallBackToCapturedThenFetchTime() throws {
        XCTAssertEqual(try XCTUnwrap(summary(#"{"v":1,"generatedAt":"soon","capturedAt":"2026-10-14T20:00:00Z"}"#)).dataAt,
                       ISODate.parse("2026-10-14T20:00:00Z"))
        XCTAssertEqual(try XCTUnwrap(summary(#"{"v":1,"generatedAt":"soon"}"#)).dataAt, now)
    }

    func testFreshnessFollowsTheServersClockNotTheTimeOfReceipt() throws {
        var s = try XCTUnwrap(summary(#"{"v":1,"score":80}"#))
        // The server built it 45 minutes ago and called it valid for 15; this watch got it 1 minute ago.
        s.dataAt = now.addingTimeInterval(-45 * 60)
        s.validUntil = now.addingTimeInterval(-30 * 60)
        s.fetchedAt = now.addingTimeInterval(-60)
        XCTAssertTrue(s.isStale(now: now))   // old enough for the "as of" label
        XCTAssertFalse(s.isFresh(now: now))  // received a minute ago, but not current
        // Built 2 minutes ago, valid for 13 more.
        s.dataAt = now.addingTimeInterval(-2 * 60)
        s.validUntil = now.addingTimeInterval(13 * 60)
        s.fetchedAt = now.addingTimeInterval(-60)
        XCTAssertFalse(s.isStale(now: now))
        XCTAssertTrue(s.isFresh(now: now))
        XCTAssertFalse(s.isFresh(now: now.addingTimeInterval(14 * 60)))
        XCTAssertFalse(s.isFresh(now: now.addingTimeInterval(-10 * 60))) // before it was received
    }
}
