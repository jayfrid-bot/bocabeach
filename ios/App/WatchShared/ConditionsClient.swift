//
//  ConditionsClient.swift
//
//  GET https://app.isitbeachday.com/api/conditions/<slug>. The route accepts
//  only a bare URL (or ?fresh=1); anything else is a 400, so no query string
//  here. The edge caches the answer for 5 minutes.
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
        #endif
        let url = baseURL.appendingPathComponent("api/conditions/\(slug)")
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
        guard let decoded = try? JSONDecoder().decode(ConditionsResponse.self, from: data) else {
            throw ConditionsError.badData
        }
        var summary = Summarizer.summarize(decoded, fetchedAt: now, now: now)
        if summary.slug.isEmpty { summary.slug = slug }
        SummaryCache.save(summary)
        return summary
    }
}
