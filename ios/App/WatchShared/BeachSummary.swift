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
    case hazard, safety, water, best, more, other
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
    /// When the server says this view stops being current: an alert starting or
    /// ending, the next rip model hour, the best window's end, or 15 minutes after
    /// `dataAt`, whichever is first.
    var validUntil: Date
    /// When this watch last received it.
    var fetchedAt: Date

    /// The "as of 3:58 PM" label appears when the snapshot is older than this.
    static let staleAfter: TimeInterval = 30 * 60
    /// No view is current longer than this after its snapshot was built.
    static let maxValidity: TimeInterval = 15 * 60

    var displayScore: Int? { score }

    var rating: String? { score.map { ScoreBands.band(for: $0).rating } }

    /// Current by the SERVER's clock (its snapshot time and its `validUntil`), not by
    /// when this watch happened to receive it. A cached reading is reused only while fresh.
    func isFresh(now: Date = Date()) -> Bool {
        now >= fetchedAt && now < validUntil
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
