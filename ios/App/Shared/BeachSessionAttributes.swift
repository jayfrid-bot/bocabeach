//
//  BeachSessionAttributes.swift
//  Shared between the App target and the BeachSessionActivity widget extension.
//
//  This file is added to BOTH targets' Compile Sources. It must have no
//  dependency on Capacitor, UIKit, or anything else app-only — ActivityKit
//  attributes/state cross the process boundary to the extension's sandbox.
//
//  Versioning rule (see docs/LIVE_ACTIVITY_PLAN.md): never rename or retype a
//  shipped field. New fields are always optional and decode with a default so
//  an OLD extension binary never fails to decode a NEWER payload sent by a
//  server that has already redeployed.
//

import ActivityKit
import Foundation

/// Static attributes set once when the Live Activity starts. No coordinates,
/// device id, or profile data — see the plan's privacy rule.
struct BeachSessionAttributes: ActivityAttributes {

    /// Human-readable beach name for display (e.g. "South Beach").
    let beachName: String

    /// Stable beach identifier used to re-associate with the web app / API.
    let slug: String

    /// When this beach session started (for a "since HH:MM" style label).
    let sessionStart: Date

    struct ContentState: Codable, Hashable {

        /// Schema version for this ContentState. Bump only when adding a
        /// field; never change an existing field's name or type.
        let v: Int

        /// Monotonic sequence number for this activity. Lets the widget (and
        /// any future debugging) detect an out-of-order delivery even though
        /// ActivityKit itself is expected to apply updates in order.
        let seq: Int

        /// 0-100 composite beach score. Verdict word is derived on-device —
        /// see `BeachSessionVerdict`.
        let score: Int

        let windMph: Double?
        let gustMph: Double?
        let windDeg: Double?

        let waveFt: Double?

        /// Short enum-like code, e.g. "clear", "murky", "unknown".
        let clarity: String?

        /// Short enum-like code, e.g. "low", "moderate", "high", "unknown".
        let seaweed: String?

        let nextTideAt: Date?
        /// "high" or "low".
        let nextTideKind: String?

        let sunsetAt: Date?

        let lightning: Lightning?

        /// When this state was produced server-side (or on-device for the
        /// Phase 1 demo fixtures).
        let updatedAt: Date

        /// True when a required feed is stale/unavailable and the surfaces
        /// should render "Conditions unavailable" rather than stale numbers.
        let unavailable: Bool?

        /// True once the session has ended. Surfaces show a brief "Session
        /// ended" layout instead of live stats. Optional/defaulted so an
        /// older widget extension decodes an omitted field as nil (not
        /// ended).
        let ended: Bool?

        struct Lightning: Codable, Hashable {
            let active: Bool
            let latched: Bool
            let miles: Double?
            let bearingDeg: Double?
            let observedAt: Date?
            let holdUntil: Date?

            init(
                active: Bool,
                latched: Bool,
                miles: Double? = nil,
                bearingDeg: Double? = nil,
                observedAt: Date? = nil,
                holdUntil: Date? = nil
            ) {
                self.active = active
                self.latched = latched
                self.miles = miles
                self.bearingDeg = bearingDeg
                self.observedAt = observedAt
                self.holdUntil = holdUntil
            }

            private enum CodingKeys: String, CodingKey {
                case active, latched, miles, bearingDeg, observedAt, holdUntil
            }

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                active = try c.decodeIfPresent(Bool.self, forKey: .active) ?? false
                latched = try c.decodeIfPresent(Bool.self, forKey: .latched) ?? false
                miles = try c.decodeIfPresent(Double.self, forKey: .miles)
                bearingDeg = try c.decodeIfPresent(Double.self, forKey: .bearingDeg)
                observedAt = try c.decodeIfPresent(Date.self, forKey: .observedAt)
                holdUntil = try c.decodeIfPresent(Date.self, forKey: .holdUntil)
            }
        }

        init(
            v: Int,
            seq: Int,
            score: Int,
            windMph: Double? = nil,
            gustMph: Double? = nil,
            windDeg: Double? = nil,
            waveFt: Double? = nil,
            clarity: String? = nil,
            seaweed: String? = nil,
            nextTideAt: Date? = nil,
            nextTideKind: String? = nil,
            sunsetAt: Date? = nil,
            lightning: Lightning? = nil,
            updatedAt: Date,
            unavailable: Bool? = nil,
            ended: Bool? = nil
        ) {
            self.v = v
            self.seq = seq
            self.score = score
            self.windMph = windMph
            self.gustMph = gustMph
            self.windDeg = windDeg
            self.waveFt = waveFt
            self.clarity = clarity
            self.seaweed = seaweed
            self.nextTideAt = nextTideAt
            self.nextTideKind = nextTideKind
            self.sunsetAt = sunsetAt
            self.lightning = lightning
            self.updatedAt = updatedAt
            self.unavailable = unavailable
            self.ended = ended
        }

        // Tolerant decoding: every field beyond `v`/`score`/`updatedAt` is
        // optional or defaulted so an older widget extension never fails to
        // decode a payload a newer server/app has started sending.
        private enum CodingKeys: String, CodingKey {
            case v, seq, score, windMph, gustMph, windDeg, waveFt, clarity,
                 seaweed, nextTideAt, nextTideKind, sunsetAt, lightning,
                 updatedAt, unavailable, ended
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            v = try c.decodeIfPresent(Int.self, forKey: .v) ?? 1
            seq = try c.decodeIfPresent(Int.self, forKey: .seq) ?? 0
            score = try c.decodeIfPresent(Int.self, forKey: .score) ?? 0
            windMph = try c.decodeIfPresent(Double.self, forKey: .windMph)
            gustMph = try c.decodeIfPresent(Double.self, forKey: .gustMph)
            windDeg = try c.decodeIfPresent(Double.self, forKey: .windDeg)
            waveFt = try c.decodeIfPresent(Double.self, forKey: .waveFt)
            clarity = try c.decodeIfPresent(String.self, forKey: .clarity)
            seaweed = try c.decodeIfPresent(String.self, forKey: .seaweed)
            nextTideAt = try c.decodeIfPresent(Date.self, forKey: .nextTideAt)
            nextTideKind = try c.decodeIfPresent(String.self, forKey: .nextTideKind)
            sunsetAt = try c.decodeIfPresent(Date.self, forKey: .sunsetAt)
            lightning = try c.decodeIfPresent(Lightning.self, forKey: .lightning)
            updatedAt = try c.decodeIfPresent(Date.self, forKey: .updatedAt) ?? Date()
            unavailable = try c.decodeIfPresent(Bool.self, forKey: .unavailable)
            ended = try c.decodeIfPresent(Bool.self, forKey: .ended)
        }
    }
}

// MARK: - On-device derivation
//
// Per the plan, the wire payload never carries the verdict word, cardinal
// directions, or rising/falling — those are derived here, once, from the
// numeric fields. This mirrors lib/scoreBands.ts exactly (checked
// 2026-09-22): boundaries 90 / 75 / 65 / 25.

enum BeachSessionVerdict {
    /// Mirrors `lib/scoreBands.ts` SCORE_BANDS. Keep these two files in sync;
    /// if the web boundaries or copy change, update both.
    static func verdict(forScore score: Int) -> String {
        switch score {
        case 90...: return "Absolutely!"
        case 75..<90: return "Yes — good beach day"
        case 65..<75: return "Decent"
        case 25..<65: return "Likely not"
        default: return "Definitely not"
        }
    }

    static func accentHex(forScore score: Int) -> String {
        switch score {
        case 90...: return "#10b981"
        case 75..<90: return "#34d399"
        case 65..<75: return "#a3e635"
        case 25..<65: return "#fbbf24"
        default: return "#fb7185"
        }
    }
}

enum BeachSessionFormat {
    /// 16-point compass rose from degrees (0 = N).
    static func cardinal(fromDegrees deg: Double?) -> String? {
        guard let deg else { return nil }
        let dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
        let normalized = deg.truncatingRemainder(dividingBy: 360)
        let positive = normalized < 0 ? normalized + 360 : normalized
        let index = Int((positive / 22.5).rounded()) % 16
        return dirs[index]
    }

    /// "Rising" / "Falling" from the *next* tide's kind: the water is doing
    /// the opposite of what the next event will be (rising toward high,
    /// falling toward low).
    static func tideTrend(nextKind: String?) -> String? {
        switch nextKind {
        case "high": return "Rising"
        case "low": return "Falling"
        default: return nil
        }
    }

    static func clarityLabel(_ code: String?) -> String? {
        switch code {
        case "clear": return "Clear"
        case "murky": return "Murky"
        case "unknown", nil: return nil
        default: return code?.capitalized
        }
    }

    static func seaweedLabel(_ code: String?) -> String? {
        switch code {
        case "low": return "Low seaweed"
        case "moderate": return "Some seaweed"
        case "high": return "Heavy seaweed"
        case "unknown", nil: return nil
        default: return code?.capitalized
        }
    }
}
