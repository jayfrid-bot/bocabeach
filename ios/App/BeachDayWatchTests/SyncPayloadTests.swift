import XCTest
@testable import BeachDayWatch

final class SyncPayloadTests: XCTestCase {
    func testSlugRule() {
        XCTAssertEqual(WatchSync.cleanSlug("boca-raton"), "boca-raton")
        for bad in ["Boca Raton", "../etc", "a--b", "-x", "x-", "", String(repeating: "x", count: 65)] {
            XCTAssertNil(WatchSync.cleanSlug(bad), bad)
        }
        XCTAssertNil(WatchSync.cleanSlug(42))
        XCTAssertNil(WatchSync.cleanSlug(nil))
    }

    func testCleanDedupesCapsAndDropsGarbage() {
        let many = (0..<40).map { "beach-\($0)" }
        let c = WatchSync.clean(home: "Bad Slug", favorites: ["naples", "naples", 7, "miami-beach"] + many, lastViewed: "jupiter")
        XCTAssertNil(c.home)
        XCTAssertEqual(c.lastViewed, "jupiter")
        XCTAssertEqual(c.favorites.count, WatchSync.maxFavorites)
        XCTAssertEqual(Array(c.favorites.prefix(2)), ["naples", "miami-beach"])
        XCTAssertEqual(WatchSync.clean(home: nil, favorites: "not a list").favorites, [])
    }

    func testScoreBands() {
        XCTAssertEqual(ScoreBands.band(for: 90).rating, "Excellent")
        XCTAssertEqual(ScoreBands.band(for: 89).rating, "Good")
        XCTAssertEqual(ScoreBands.band(for: 75).rating, "Good")
        XCTAssertEqual(ScoreBands.band(for: 74).rating, "Decent")
        XCTAssertEqual(ScoreBands.band(for: 65).rating, "Decent")
        XCTAssertEqual(ScoreBands.band(for: 64).rating, "Marginal")
        XCTAssertEqual(ScoreBands.band(for: 25).rating, "Marginal")
        XCTAssertEqual(ScoreBands.band(for: 24).rating, "Poor")
        XCTAssertEqual(ScoreBands.band(for: -5).rating, "Poor")
    }
}
