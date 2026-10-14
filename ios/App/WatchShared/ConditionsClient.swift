//
//  ConditionsClient.swift
//
//  GET https://app.isitbeachday.com/api/watch/<slug> (lib/watchView.ts): under
//  2 KB, already decided by the website's own safety and score logic. The route
//  accepts a bare URL only; any query string is a 400. The edge caches the
//  answer for 5 minutes.
//

import Foundation

enum ConditionsError: Error, Equatable {
    case invalidSlug
    case unknownBeach
    case offline
    case server(Int)
    case badData

    /// Short text for the screen.
    var message: String {
        switch self {
        case .offline: return "No connection"
        case .unknownBeach: return "Beach not found"
        case .server: return "Server problem"
        case .invalidSlug, .badData: return "Unreadable data"
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

    /// Fetches, summarizes and caches one beach.
    static func fetch(slug rawSlug: String, now: Date = Date()) async throws -> BeachSummary {
        guard let slug = WatchSync.cleanSlug(rawSlug) else { throw ConditionsError.invalidSlug }
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "debugOffline") { throw ConditionsError.offline }
        // Simulator only: read <dir>/<slug>.json instead of the network (the watch
        // simulator shares the Mac's file system). Used while /api/watch is not deployed.
        if let dir = SharedStore.defaults.string(forKey: "debug.watchJSON") {
            guard let data = FileManager.default.contents(atPath: "\(dir)/\(slug).json") else { throw ConditionsError.unknownBeach }
            guard let dto = WatchViewDecoder.decode(data, expectedSlug: slug) else { throw ConditionsError.badData }
            let summary = WatchViewDecoder.summary(from: dto, slug: slug, fetchedAt: now)
            SummaryCache.save(summary)
            WidgetFailureCounter.reset(slug)
            return summary
        }
        #endif
        let url = baseURL.appendingPathComponent("api/watch/\(slug)")
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(from: url)
        } catch {
            // Every transport failure (no network, timeout, DNS) reads the same on a watch.
            throw ConditionsError.offline
        }
        guard let http = response as? HTTPURLResponse else { throw ConditionsError.badData }
        if http.statusCode == 404 { throw ConditionsError.unknownBeach }
        guard http.statusCode == 200 else { throw ConditionsError.server(http.statusCode) }
        // 503 "incomplete" and every other non-200 land above: nothing is cached from them.
        guard let dto = WatchViewDecoder.decode(data, expectedSlug: slug) else { throw ConditionsError.badData }
        let summary = WatchViewDecoder.summary(from: dto, slug: slug, fetchedAt: now)
        SummaryCache.save(summary)
        // Any success, from the app or the widget, ends this beach's failure streak.
        WidgetFailureCounter.reset(slug)
        return summary
    }
}
