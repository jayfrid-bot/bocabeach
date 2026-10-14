import XCTest
@testable import BeachDayWatch

/// SummaryCache's newest-wins compare-and-write under concurrent writers. The lock is an
/// `flock` on a file in the cache directory, and `flock` excludes separate open file
/// descriptions, so concurrent threads here stand in for the watch app and the widget process.
final class SummaryCacheTests: XCTestCase {
    private var dir: URL!
    private let base = Date(timeIntervalSince1970: 1_800_000_000)

    override func setUp() {
        super.setUp()
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("summarycache-\(UUID().uuidString)", isDirectory: true)
        SummaryCache.directoryOverride = dir
    }

    override func tearDown() {
        SummaryCache.directoryOverride = nil
        try? FileManager.default.removeItem(at: dir)
        super.tearDown()
    }

    private func reading(score: Int, builtSecondsAfterBase: Int) -> BeachSummary {
        let built = base.addingTimeInterval(TimeInterval(builtSecondsAfterBase))
        return BeachSummary(slug: "boca-raton", name: "Boca Raton", score: score, limitedData: false, lines: [], waterTempF: nil,
                            dataAt: built, validUntil: built.addingTimeInterval(900), fetchedAt: built)
    }

    func testConcurrentWritersInterleavedNewerAndOlderLeaveTheNewestCached() {
        // 400 readings built at different times, written from many threads in a scrambled order.
        let readings = (0..<400).map { reading(score: $0 % 100, builtSecondsAfterBase: $0) }.shuffled()
        let newest = readings.map(\.dataAt).max()!
        DispatchQueue.concurrentPerform(iterations: readings.count) { i in
            let kept = SummaryCache.store(readings[i])
            // Whatever a writer is told is cached is never older than what it wrote.
            XCTAssertGreaterThanOrEqual(kept.dataAt, readings[i].dataAt)
        }
        XCTAssertEqual(SummaryCache.load("boca-raton")?.dataAt, newest)
    }

    func testTheCachedReadingNeverGoesBackwardsWhileWritersRace() {
        let lock = NSLock()
        var seen: [Date] = []
        let readings = (0..<300).map { reading(score: 50, builtSecondsAfterBase: $0) }.shuffled()
        DispatchQueue.concurrentPerform(iterations: readings.count) { i in
            SummaryCache.store(readings[i])
            if let now = SummaryCache.load("boca-raton")?.dataAt { lock.lock(); seen.append(now); lock.unlock() }
        }
        XCTAssertEqual(SummaryCache.load("boca-raton")?.dataAt, readings.map(\.dataAt).max())
        // Every observation is a real reading, and the final one is the maximum of all.
        XCTAssertTrue(seen.allSatisfy { $0 >= base })
    }

    func testAnOlderWriteAfterANewerOneIsRefusedAndAnEqualOrNewerOneWins() {
        XCTAssertEqual(SummaryCache.store(reading(score: 90, builtSecondsAfterBase: 100)).score, 90)
        XCTAssertEqual(SummaryCache.store(reading(score: 10, builtSecondsAfterBase: 50)).score, 90)
        XCTAssertEqual(SummaryCache.load("boca-raton")?.score, 90)
        XCTAssertEqual(SummaryCache.store(reading(score: 70, builtSecondsAfterBase: 100)).score, 70, "same server time: the later write wins")
        XCTAssertEqual(SummaryCache.store(reading(score: 60, builtSecondsAfterBase: 200)).score, 60)
    }

    func testFilesAreWrittenAtomicallyAndUnreadableOnesAreIgnored() throws {
        SummaryCache.store(reading(score: 88, builtSecondsAfterBase: 1))
        let file = dir.appendingPathComponent("boca-raton.json")
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
        try Data("{not json".utf8).write(to: file)
        XCTAssertNil(SummaryCache.load("boca-raton"), "a corrupt file reads as no cache, not a crash")
        // And a good write replaces it even though "existing" could not be decoded.
        XCTAssertEqual(SummaryCache.store(reading(score: 77, builtSecondsAfterBase: 2)).score, 77)
        XCTAssertEqual(SummaryCache.load("boca-raton")?.score, 77)
    }

    func testOnlyValidSlugsTouchTheFileSystem() {
        let evil = BeachSummary(slug: "../../escape", name: "x", score: 1, limitedData: false, lines: [], waterTempF: nil,
                                dataAt: base, validUntil: base, fetchedAt: base)
        SummaryCache.store(evil)
        XCTAssertNil(SummaryCache.load("../../escape"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.deletingLastPathComponent().appendingPathComponent("escape.json").path))
    }

    #if DEBUG
    func testTheDebugForcePathReplacesANewerReading() {
        SummaryCache.store(reading(score: 90, builtSecondsAfterBase: 500))
        SummaryCache.forceStore(reading(score: 20, builtSecondsAfterBase: 1)) // -debugAgeCache / an older fixture
        XCTAssertEqual(SummaryCache.load("boca-raton")?.score, 20)
    }
    #endif
}
