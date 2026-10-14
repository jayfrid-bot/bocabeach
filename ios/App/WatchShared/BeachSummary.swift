//
//  BeachSummary.swift
//
//  What the watch shows for one beach: a few numbers and short lines. This is
//  also what the watch caches (App Group defaults) and what the widget reads.
//
//  TODO(Plus): v1 shows the PUBLIC score only. A Plus subscriber's personal
//  score lives on the server per device (lib/plus/, POST /api/devices/...),
//  needs the install token, and is not reachable from the watch yet. When it
//  is, add `personalScore: Int?` here and prefer it in `displayScore`.
//

import Foundation

enum Tone: String, Codable, Comparable {
    case calm, caution, danger

    private var rank: Int {
        switch self {
        case .calm: return 0
        case .caution: return 1
        case .danger: return 2
        }
    }
    static func < (a: Tone, b: Tone) -> Bool { a.rank < b.rank }
}

struct SummaryLine: Codable, Equatable {
    var text: String
    var tone: Tone
}

struct BeachSummary: Codable, Equatable {
    var slug: String
    var name: String
    /// nil means the server had no usable data for this beach right now.
    var score: Int?
    /// The server marked the score as built from too little live data.
    var limitedData: Bool
    /// Lightning, rain or a weather alert. Only present when there is one.
    var hazard: SummaryLine?
    /// Lifeguard flag and rip current status, joined.
    var safety: SummaryLine?
    var waterTempF: Int?
    /// "Best 4-6 PM", or "No good window today".
    var best: String?
    /// When the server built this snapshot.
    var dataAt: Date
    /// When this watch last received it.
    var fetchedAt: Date

    static let staleAfter: TimeInterval = 30 * 60

    var displayScore: Int? { score }

    var rating: String? { score.map { ScoreBands.band(for: $0).rating } }

    func isStale(now: Date = Date()) -> Bool {
        now.timeIntervalSince(dataAt) > Self.staleAfter
    }

    /// "Beach Day score 82, Good" for VoiceOver.
    var scoreSpokenLabel: String {
        guard let score, let rating else { return "Beach Day conditions unavailable" }
        return "Beach Day score \(score), \(rating)"
    }

    /// The single most useful line for a small space: danger first, then a
    /// cautionary flag or rip status, then the best time, then water.
    var headlineLine: String? {
        if let hazard { return hazard.text }
        if let safety, safety.tone != .calm { return safety.text }
        if let best { return best }
        if let waterTempF { return "Water \(waterTempF)\u{00B0}F" }
        return safety?.text
    }

    /// "3:58 PM" in the watch's own time zone.
    func asOfText(now: Date = Date()) -> String {
        dataAt.formatted(date: .omitted, time: .shortened)
    }
}
