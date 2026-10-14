//
//  ConditionsClient.swift
//
//  GET https://app.isitbeachday.com/api/watch/<slug> (lib/watchView.ts): under
//  2 KB, already decided by the website's own safety and score logic. The route
//  accepts a bare URL only; any query string is a 400. The edge caches the
//  answer for at most a minute and never past its validUntil.
//

import Foundation

enum ConditionsError: Error, Equatable {
    case invalidSlug
    case unknownBeach
    case offline
    case server(Int)
    case badData
    /// The server's own validUntil had already passed when the answer arrived.
    case expired

    /// Short text for the screen.
    var message: String {
        switch self {
        case .offline: return "No connection"
        case .unknownBeach: return "Beach not found"
        case .server: return "Server problem"
        case .invalidSlug, .badData: return "Unreadable data"
        case .expired: return "Out of date"
        }
    }
}

enum ConditionsClient {
    static let baseURL = URL(string: "https://app.isitbeachday.com")!

    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 30
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpAdditionalHeaders = ["User-Agent": "IsItBeachDayWatch/1.0 (watchOS)"]
        return URLSession(configuration: config)
    }()

    typealias Transport = @Sendable (URL) async throws -> (Data, URLResponse)
    typealias Clock = @Sendable () -> Date

    /// Fetches, summarizes and (unless told otherwise) caches one beach.
    ///
    /// The time of receipt is read AFTER the network call returns and is what `fetchedAt` and
    /// the expiry check use: an answer that was valid when requested but expired in transit is
    /// rejected, not cached. With `save: false` the caller saves the cache itself, after its own
    /// check that the answer is still the one it wants (BeachStore does).
    ///
    /// `transport` and `clock` are injected by tests; the defaults are the real session and clock.
    static func fetch(
        slug rawSlug: String,
        save: Bool = true,
        clock: Clock = { Date() },
        transport: Transport? = nil
    ) async throws -> BeachSummary {
        guard let slug = WatchSync.cleanSlug(rawSlug) else { throw ConditionsError.invalidSlug }
        #if DEBUG
        // (An injected transport means a test: the launch-argument shortcuts below stay out of it.)
        if transport == nil, UserDefaults.standard.bool(forKey: "debugOffline") { throw ConditionsError.offline }
        // Simulator only: read <dir>/<slug>.json instead of the network (the watch
        // simulator shares the Mac's file system). Used while /api/watch is not deployed.
        // The expiry check is skipped here: fixtures are made ahead of time.
        if transport == nil, let dir = SharedStore.defaults.string(forKey: "debug.watchJSON") {
            guard let data = FileManager.default.contents(atPath: "\(dir)/\(slug).json") else { throw ConditionsError.unknownBeach }
            guard let dto = WatchViewDecoder.decode(data, expectedSlug: slug) else { throw ConditionsError.badData }
            var summary = WatchViewDecoder.summary(from: dto, slug: slug, fetchedAt: clock())
            // A fixture may be older than the cached live reading: replace it anyway (debug
            // only), whoever asked, so the watch app's later newest-wins store keeps it too.
            summary = SummaryCache.forceStore(summary)
            WidgetFailureCounter.reset(slug)
            return summary
        }
        #endif
        let url = baseURL.appendingPathComponent("api/watch/\(slug)")
        let data: Data
        let response: URLResponse
        do {
            if let transport {
                (data, response) = try await transport(url)
            } else {
                (data, response) = try await session.data(from: url)
            }
        } catch {
            // Every transport failure (no network, timeout, DNS) reads the same on a watch.
            throw ConditionsError.offline
        }
        // The moment the answer ARRIVED: not when the request started.
        let receivedAt = clock()
        guard let http = response as? HTTPURLResponse else { throw ConditionsError.badData }
        if http.statusCode == 404 { throw ConditionsError.unknownBeach }
        guard http.statusCode == 200 else { throw ConditionsError.server(http.statusCode) }
        // 503 "incomplete" and every other non-200 land above: nothing is cached from them.
        guard let dto = WatchViewDecoder.decode(data, expectedSlug: slug) else { throw ConditionsError.badData }
        var summary = WatchViewDecoder.summary(from: dto, slug: slug, fetchedAt: receivedAt)
        // Already past its own validUntil on arrival: a failure, and the cache keeps what it had.
        guard !summary.isExpired(now: receivedAt) else { throw ConditionsError.expired }
        if save { summary = SummaryCache.store(summary) }
        // Any success, from the app or the widget, ends this beach's failure streak.
        WidgetFailureCounter.reset(slug)
        return summary
    }
}
