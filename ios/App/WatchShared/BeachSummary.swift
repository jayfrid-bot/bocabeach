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

enum LineKind: String, Codable {
    case hazard, safety, water, best, other
}

struct SummaryLine: Codable, Equatable {
    var kind: LineKind
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
    /// Short lines in the order the server chose: hazards, flag and rip, water, best time.
    var lines: [SummaryLine]
    var waterTempF: Int?
    /// When the server built this snapshot.
    var dataAt: Date
    /// When this watch last received it.
    var fetchedAt: Date

    static let staleAfter: TimeInterval = 30 * 60
    /// A reading received this recently is used instead of asking the network again.
    static let freshFor: TimeInterval = 30 * 60

    var displayScore: Int? { score }

    var rating: String? { score.map { ScoreBands.band(for: $0).rating } }

    func isFresh(now: Date = Date()) -> Bool {
        let age = now.timeIntervalSince(fetchedAt)
        return age >= 0 && age < Self.freshFor
    }

    func isStale(now: Date = Date()) -> Bool {
        now.timeIntervalSince(dataAt) > Self.staleAfter
    }

    /// "Beach Day score 82, Good" for VoiceOver.
    var scoreSpokenLabel: String {
        guard let score, let rating else { return "Beach Day conditions unavailable" }
        return "Beach Day score \(score), \(rating)"
    }

    func firstLine(_ kind: LineKind) -> SummaryLine? { lines.first { $0.kind == kind } }

    /// The single most useful line for a small space: a hazard first, then a
    /// cautionary flag or rip status, then the best time, then water.
    var headlineLine: String? {
        if let hazard = firstLine(.hazard) { return hazard.text }
        if let safety = firstLine(.safety), safety.tone != .calm { return safety.text }
        if let best = firstLine(.best) { return best.text }
        if let water = firstLine(.water) { return water.text }
        return firstLine(.safety)?.text
    }

    /// "3:58 PM" in the watch's own time zone.
    func asOfText(now: Date = Date()) -> String {
        dataAt.formatted(date: .omitted, time: .shortened)
    }
}
