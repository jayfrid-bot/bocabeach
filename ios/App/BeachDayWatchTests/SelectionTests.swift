import XCTest
@testable import BeachDayWatch

/// What the phone's sync does to the beach the watch shows. These use the real
/// App Group defaults, so they clear the selection keys before and after.
final class SelectionTests: XCTestCase {
    private let keys = [WatchSync.Key.homeSlug, WatchSync.Key.favorites, WatchSync.Key.lastViewedSlug, "selectedSlug", "syncedAt"]

    private func clear() { keys.forEach { SharedStore.defaults.removeObject(forKey: $0) } }
    override func setUp() { super.setUp(); clear() }
    override func tearDown() { clear(); super.tearDown() }

    func testPrecedenceIsPickedThenHomeThenLastViewed() {
        BeachSelection.applySync(home: nil, favorites: [], lastViewed: "naples")
        XCTAssertEqual(BeachSelection.activeSlug, "naples")
        BeachSelection.applySync(home: "boca-raton", favorites: [], lastViewed: "naples")
        XCTAssertEqual(BeachSelection.activeSlug, "boca-raton")
        BeachSelection.select("miami-beach")
        XCTAssertEqual(BeachSelection.activeSlug, "miami-beach")
        // A new home beach on the phone clears the pick.
        BeachSelection.applySync(home: "deerfield-beach", favorites: [], lastViewed: "naples")
        XCTAssertEqual(BeachSelection.activeSlug, "deerfield-beach")
    }

    func testSyncReportsAChangeOnlyWhenTheShownBeachChanges() {
        XCTAssertTrue(BeachSelection.applySync(home: "boca-raton", favorites: ["naples"], lastViewed: nil))
        // Same beach shown: different favorites and last-viewed must not count as a change.
        XCTAssertFalse(BeachSelection.applySync(home: "boca-raton", favorites: ["miami-beach", "naples"], lastViewed: "naples"))
        XCTAssertFalse(BeachSelection.applySync(home: "boca-raton", favorites: [], lastViewed: nil))
        XCTAssertTrue(BeachSelection.applySync(home: "naples", favorites: [], lastViewed: nil))
        // A pick on the watch hides home changes... until the home itself changes.
        BeachSelection.select("miami-beach")
        XCTAssertFalse(BeachSelection.applySync(home: "naples", favorites: ["x-y"], lastViewed: "naples"))
        XCTAssertTrue(BeachSelection.applySync(home: "boca-raton", favorites: [], lastViewed: nil))
        // Clearing everything on the phone clears the shown beach: that IS a change.
        XCTAssertTrue(BeachSelection.applySync(home: nil, favorites: [], lastViewed: nil))
        XCTAssertNil(BeachSelection.activeSlug)
    }

    func testSyncOutcomeSeparatesAShownBeachChangeFromMetadataOnly() {
        XCTAssertEqual(BeachSelection.applySyncOutcome(home: "boca-raton", favorites: [], lastViewed: nil),
                       .init(activeChanged: true, metadataChanged: true))
        // Favorites and last-viewed change behind the same beach: an open picker must refresh, nothing is fetched.
        XCTAssertEqual(BeachSelection.applySyncOutcome(home: "boca-raton", favorites: ["naples"], lastViewed: "miami-beach"),
                       .init(activeChanged: false, metadataChanged: true))
        // Nothing changed at all.
        XCTAssertEqual(BeachSelection.applySyncOutcome(home: "boca-raton", favorites: ["naples"], lastViewed: "miami-beach"),
                       .init(activeChanged: false, metadataChanged: false))
    }

    func testPickingTheDefaultBeachFollowsThePhoneAgain() {
        BeachSelection.applySync(home: "boca-raton", favorites: [], lastViewed: nil)
        BeachSelection.select("naples")
        XCTAssertEqual(BeachSelection.selectedSlug, "naples")
        BeachSelection.select("boca-raton")
        XCTAssertNil(BeachSelection.selectedSlug)
    }
}
