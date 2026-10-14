import XCTest
@testable import BeachDayWatch

/// The request rules of BeachStore: one request per beach at a time, one widget reload per
/// change on every path, nothing stranded, and no older answer overwriting a newer one.
@MainActor
final class BeachStoreTests: XCTestCase {
    private let keys = [WatchSync.Key.homeSlug, WatchSync.Key.favorites, WatchSync.Key.lastViewedSlug, "selectedSlug", "syncedAt",
                        "summary.boca-raton", "summary.naples"]
    private var reloads = 0

    override func setUp() {
        super.setUp()
        keys.forEach { SharedStore.defaults.removeObject(forKey: $0) }
        reloads = 0
    }
    override func tearDown() {
        keys.forEach { SharedStore.defaults.removeObject(forKey: $0) }
        super.tearDown()
    }

    /// A gate a fake fetch waits on, so a test decides when a request finishes.
    final class Gate: @unchecked Sendable {
        private var waiters: [CheckedContinuation<Void, Never>] = []
        private var open = false
        func wait() async {
            if open { return }
            await withCheckedContinuation { waiters.append($0) }
        }
        func release() {
            open = true
            waiters.forEach { $0.resume() }
            waiters = []
        }
    }
    final class Counter: @unchecked Sendable { var n = 0; var slugs: [String] = [] }

    private nonisolated static func summary(_ slug: String, score: Int) -> BeachSummary {
        let now = Date()
        return BeachSummary(slug: slug, name: slug, score: score, limitedData: false, lines: [], waterTempF: nil,
                            dataAt: now, validUntil: now.addingTimeInterval(600), fetchedAt: now)
    }

    private func makeStore(_ fetch: @escaping BeachStore.Fetcher) -> BeachStore {
        BeachStore(fetcher: fetch, reloadWidget: { [unowned self] in self.reloads += 1 }, observeNotifications: false)
    }

    private func settle() async { for _ in 0..<5 { await Task.yield() } }

    func testAForegroundRefreshJoinsASelectionRequestInsteadOfSupersedingIt() async {
        BeachSelection.applySync(home: "boca-raton", favorites: [], lastViewed: nil)
        let gate = Gate(), counter = Counter()
        let store = makeStore { slug in counter.n += 1; await gate.wait(); throw ConditionsError.offline }
        store.loadSelection()

        let selection = Task { await store.refresh(.selection) }
        await settle()
        let foreground = Task { await store.refresh(.foreground) }
        await settle()
        gate.release()
        await selection.value
        await foreground.value

        XCTAssertEqual(counter.n, 1, "one request for the beach, not two")
        XCTAssertEqual(reloads, 1, "the failed selection request still owes the widget exactly one reload")
        XCTAssertEqual(store.phase, .failed(.offline))
    }

    func testASelectionRequestThatSucceedsReloadsTheWidgetOnceAndSavesTheCache() async {
        BeachSelection.applySync(home: "boca-raton", favorites: [], lastViewed: nil)
        let store = makeStore { slug in Self.summary(slug, score: 91) }
        store.loadSelection()
        await store.refresh(.selection)
        XCTAssertEqual(reloads, 1)
        XCTAssertEqual(store.summary?.score, 91)
        XCTAssertEqual(SummaryCache.load("boca-raton")?.score, 91)
        XCTAssertEqual(store.phase, .idle)
    }

    func testAForegroundFailureAloneDoesNotReloadTheWidget() async {
        BeachSelection.applySync(home: "boca-raton", favorites: [], lastViewed: nil)
        let store = makeStore { _ in throw ConditionsError.server(500) }
        store.loadSelection()
        await store.refresh(.foreground)
        XCTAssertEqual(reloads, 0)
        XCTAssertEqual(store.phase, .failed(.server(500)))
        XCTAssertNil(SummaryCache.load("boca-raton"), "a failure never writes the cache")
    }

    func testAForegroundSuccessReloadsOnce() async {
        BeachSelection.applySync(home: "boca-raton", favorites: [], lastViewed: nil)
        let store = makeStore { slug in Self.summary(slug, score: 70) }
        store.loadSelection()
        await store.refresh(.foreground)
        XCTAssertEqual(reloads, 1)
    }

    func testClearingTheBeachOnThePhoneReloadsTheWidgetSoItShowsSetup() async {
        BeachSelection.applySync(home: nil, favorites: [], lastViewed: nil)
        let store = makeStore { _ in XCTFail("nothing to fetch"); throw ConditionsError.offline }
        store.loadSelection()
        await store.refresh(.selection)
        XCTAssertEqual(reloads, 1)
    }

    func testSwitchingBeachesMidRequestKeepsOnlyTheNewestAnswerAndOneReload() async {
        BeachSelection.applySync(home: "boca-raton", favorites: [], lastViewed: nil)
        let slowGate = Gate(), counter = Counter()
        let store = makeStore { slug in
            counter.slugs.append(slug)
            if slug == "boca-raton" { await slowGate.wait(); return Self.summary(slug, score: 10) }
            return Self.summary(slug, score: 99)
        }
        store.loadSelection()
        let first = Task { await store.refresh(.selection) }
        await settle()
        // The user picks another beach while the first request is still out.
        await store.select("naples")
        XCTAssertEqual(store.summary?.slug, "naples")
        XCTAssertEqual(store.summary?.score, 99)
        XCTAssertEqual(reloads, 1)
        // The slow, older answer arrives last. It must not overwrite the screen, the cache, or reload again.
        slowGate.release()
        await first.value
        XCTAssertEqual(store.summary?.slug, "naples")
        XCTAssertNil(SummaryCache.load("boca-raton"), "the superseded answer is not cached")
        XCTAssertEqual(SummaryCache.load("naples")?.score, 99)
        XCTAssertEqual(reloads, 1)
        XCTAssertEqual(counter.slugs, ["boca-raton", "naples"])
    }
}
