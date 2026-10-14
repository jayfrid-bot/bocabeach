//
//  ScoreBands.swift
//
//  Mirror of SCORE_BANDS in lib/scoreBands.ts (the web app's one source of
//  truth for the Beach Day score's rating words and colors). A vitest
//  (lib/watchSync.test.ts) parses this file and fails if the two drift.
//  Keep each band on ONE line in the same shape.
//

import SwiftUI

struct ScoreBand: Equatable {
    /// Inclusive lower bound (0-100).
    let min: Int
    let rating: String
    let hex: UInt32

    var color: Color {
        Color(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

enum ScoreBands {
    /// Highest band first.
    static let all: [ScoreBand] = [
        ScoreBand(min: 90, rating: "Excellent", hex: 0x10B981),
        ScoreBand(min: 75, rating: "Good", hex: 0x34D399),
        ScoreBand(min: 65, rating: "Decent", hex: 0xA3E635),
        ScoreBand(min: 25, rating: "Marginal", hex: 0xFBBF24),
        ScoreBand(min: 0, rating: "Poor", hex: 0xFB7185),
    ]

    static func band(for score: Int) -> ScoreBand {
        all.first { score >= $0.min } ?? all[all.count - 1]
    }

    /// A best-time window must reach "Decent" to be offered as a good time.
    /// Mirrors GOOD_WINDOW_MIN_SCORE in lib/scoreBands.ts.
    static let goodWindowMinScore = 65
}
