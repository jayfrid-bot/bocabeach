//
//  Summarizer.swift
//
//  Turns the conditions payload into a BeachSummary. The rules follow the web
//  app so the watch never says something the phone does not:
//    - score and rating words: lib/scoreBands.ts (ScoreBands.swift)
//    - rip current status: lib/ripRisk/resolve.ts (RipResolver below)
//    - rain: lib/rainNowcast.ts thresholds; lightning: lib/hazards/assess.ts
//    - best time: lib/scoreBands.ts goodWindow (65+ only)
//

import Foundation

enum Summarizer {
    static func summarize(_ r: ConditionsResponse, fetchedAt: Date, now: Date = Date()) -> BeachSummary {
        let s = r.snapshot
        let slug = s.location.slug ?? ""
        let available = r.score?.dataAvailable != false
        let score: Int? = available ? r.score?.score.map { max(0, min(100, $0)) } : nil

        let water = s.buoy?.usable?.waterTempF ?? s.marine?.usable?.seaSurfaceTempF

        return BeachSummary(
            slug: slug,
            name: s.location.name,
            score: score,
            limitedData: r.score?.dataCoverage == "limited",
            hazard: hazardLine(s, now: now),
            safety: safetyLine(s, now: now),
            waterTempF: water.map { Int($0.rounded()) },
            best: bestLine(r, timeZone: s.location.timezone, now: now),
            dataAt: ISODate.parse(s.generatedAt) ?? fetchedAt,
            fetchedAt: fetchedAt
        )
    }

    // MARK: Hazards (lightning, rain, alerts)

    static func hazardLine(_ s: Snapshot, now: Date) -> SummaryLine? {
        var candidates: [(rank: Int, line: SummaryLine)] = []

        if s.cityOfficial?.usable?.noSwimAdvisory != nil {
            candidates.append((90, SummaryLine(text: "No-swim advisory", tone: .danger)))
        }

        // Lightning: a strike inside the 30-minute window. Under 5 mi is the
        // "get out of the water" line the web app uses.
        if s.lightning?.status == "ok", let l = s.lightning?.data,
           let mi = l.nearestMi, let ago = l.nearestMinutesAgo, ago <= 30, mi <= 10 {
            let rounded = (mi * 10).rounded() / 10
            let miles = rounded.truncatingRemainder(dividingBy: 1) == 0 ? "\(Int(rounded))" : String(format: "%.1f", rounded)
            let text = "Lightning \(miles) mi away"
            candidates.append((mi <= 5 ? 100 : 60, SummaryLine(text: text, tone: mi <= 5 ? .danger : .caution)))
        }

        // Rain: observed on radar, or about to arrive. Radar older than 25
        // minutes is not trusted (PRECIP_RADAR_STALE_MINUTES).
        if s.precipRadar?.status == "ok", let p = s.precipRadar?.data,
           (p.frameAgeMinutes ?? 0) <= 25 {
            if let rate = p.rainNowMmHr, rate >= 0.5 {
                candidates.append((70, SummaryLine(text: "Raining now", tone: .caution)))
            } else if let eta = p.etaMinutes, eta <= 45,
                      let km = p.nearestRainKm, km / 1.609344 <= 30 {
                candidates.append((50, SummaryLine(text: "Rain in ~\(Int(eta.rounded())) min", tone: .caution)))
            }
        }

        // Severe weather alert in effect (rip alerts are handled by RipResolver).
        if let alerts = s.nws?.usable?.alerts {
            for a in alerts where !RipResolver.isRipAlert(a) && RipResolver.status(of: a, now: now) == .inEffect {
                if let sev = a.severity, sev == "Severe" || sev == "Extreme" {
                    candidates.append((80, SummaryLine(text: a.event, tone: .danger)))
                    break
                }
            }
        }

        return candidates.max { $0.rank < $1.rank }?.line
    }

    // MARK: Flag + rip current

    static func safetyLine(_ s: Snapshot, now: Date) -> SummaryLine? {
        var parts: [String] = []
        var tone: Tone = .calm

        if let flags = s.cityOfficial?.usable?.flags {
            let order = ["double-red", "red", "yellow", "green"]
            if let worst = order.first(where: { flags.contains($0) }) {
                switch worst {
                case "double-red": parts.append("Double red flag"); tone = max(tone, .danger)
                case "red": parts.append("Red flag"); tone = max(tone, .danger)
                case "yellow": parts.append("Yellow flag"); tone = max(tone, .caution)
                default: parts.append("Green flag")
                }
            } else if flags.contains("purple") {
                parts.append("Purple flag")
                tone = max(tone, .caution)
            }
        }

        if let nws = s.nws?.usable {
            let model = RipResolver.modelNow(s.ripNwps?.usable, now: now)
            let rip = RipResolver.resolve(alerts: nws.alerts ?? [], periods: nws.srfPeriods ?? [],
                                          legacyLevel: nws.ripCurrentRisk, model: model, now: now)
            switch (rip.isAlert, rip.level) {
            case (true, _): parts.append("Rip alert"); tone = max(tone, .danger)
            case (_, .high): parts.append("Rip high"); tone = max(tone, .danger)
            case (_, .moderate): parts.append("Rip moderate"); tone = max(tone, .caution)
            case (_, .low): parts.append("Rip low")
            case (_, .unknown): break
            }
        }

        return parts.isEmpty ? nil : SummaryLine(text: parts.joined(separator: " \u{00B7} "), tone: tone)
    }

    // MARK: Best time

    static func bestLine(_ r: ConditionsResponse, timeZone: String?, now: Date) -> String? {
        guard let today = r.multiDayWindows?.first else { return nil }
        guard let best = today.best, let score = best.score,
              let start = ISODate.parse(best.startIso), let end = ISODate.parse(best.endIso) else {
            return nil
        }
        // The server builds today's window from time still ahead. If it has
        // already ended (a stale payload), say nothing rather than point backward.
        if end <= now { return nil }
        if score < ScoreBands.goodWindowMinScore { return "No good window today" }
        return "Best " + windowText(start: start, end: end, timeZone: timeZone)
    }

    /// "4\u{2013}6 PM", or "11 AM\u{2013}1 PM" when the AM/PM differs.
    static func windowText(start: Date, end: Date, timeZone: String?) -> String {
        var cal = Calendar(identifier: .gregorian)
        if let tz = timeZone.flatMap(TimeZone.init(identifier:)) { cal.timeZone = tz }
        func parts(_ d: Date) -> (hour: Int, minute: Int, pm: Bool) {
            let c = cal.dateComponents([.hour, .minute], from: d)
            let h = c.hour ?? 0
            return (h % 12 == 0 ? 12 : h % 12, c.minute ?? 0, h >= 12)
        }
        func clock(_ p: (hour: Int, minute: Int, pm: Bool), suffix: Bool) -> String {
            let base = p.minute == 0 ? "\(p.hour)" : String(format: "%d:%02d", p.hour, p.minute)
            return suffix ? base + (p.pm ? " PM" : " AM") : base
        }
        let a = parts(start), b = parts(end)
        let sameHalf = a.pm == b.pm
        return clock(a, suffix: !sameHalf) + "\u{2013}" + clock(b, suffix: true)
    }
}

// MARK: - Rip current resolution (port of lib/ripRisk/resolve.ts)

enum RipLevel: Int, Comparable {
    case unknown = -1, low = 0, moderate = 1, high = 2
    static func < (a: RipLevel, b: RipLevel) -> Bool { a.rawValue < b.rawValue }

    init(word: String?) {
        switch word {
        case "low": self = .low
        case "moderate": self = .moderate
        case "high": self = .high
        default: self = .unknown
        }
    }

    /// One band lower, floored at low.
    var stepDown: RipLevel { self == .high ? .moderate : (self == .moderate ? .low : self) }
}

struct RipNow: Equatable {
    var level: RipLevel
    var isAlert: Bool
}

enum RipResolver {
    enum AlertStatus { case scheduled, inEffect, ended }

    static let modelStale: TimeInterval = 36 * 3600
    static let modelTrusted: TimeInterval = 18 * 3600

    /// NOAA rip model band: under 20% low, 20 to 50% moderate, 50%+ high.
    static func level(forProbability p: Double) -> RipLevel {
        p >= 50 ? .high : (p >= 20 ? .moderate : .low)
    }

    /// Only these count as a rip alert; a Beach Hazards Statement counts when
    /// its text mentions rip currents.
    static func isRipAlert(_ a: NwsAlert) -> Bool {
        let event = a.event.lowercased()
        if event.contains("rip current statement") { return true }
        if event.contains("beach hazard") && event.contains("statement") {
            let text = "\(a.headline ?? "") \(a.description ?? "")".lowercased()
            return text.contains("rip current")
        }
        return false
    }

    static func status(of a: NwsAlert, now: Date) -> AlertStatus? {
        guard let onset = ISODate.parse(a.onset ?? a.effective),
              let end = ISODate.parse(a.ends ?? a.expires) else { return nil }
        if now >= end { return .ended }
        if now < onset { return .scheduled }
        return .inEffect
    }

    struct ModelNow { var level: RipLevel; var run: Date }

    /// The model hour covering `now`, if the model run is fresh.
    static func modelNow(_ series: RipNwpsData?, now: Date) -> ModelNow? {
        guard let series, let run = ISODate.parse(series.run), let hours = series.hours else { return nil }
        let age = now.timeIntervalSince(run)
        guard age <= modelStale, age >= -3600 else { return nil }
        let hourStart = floor(now.timeIntervalSince1970 / 3600) * 3600
        guard let row = hours.first(where: { ISODate.parse($0.t)?.timeIntervalSince1970 == hourStart }) else {
            return nil
        }
        return ModelNow(level: level(forProbability: row.prob), run: run)
    }

    /// The forecast word for now: the SRF period whose window holds `now`; with
    /// no windows at all, the first period (or the flat legacy word).
    static func forecastLevel(periods: [SrfPeriod], legacy: String?, now: Date) -> RipLevel {
        var anyWindow = false
        for p in periods {
            guard let s = ISODate.parse(p.start), let e = ISODate.parse(p.end) else { continue }
            anyWindow = true
            if now >= s && now < e { return RipLevel(word: p.level) }
        }
        if anyWindow { return .unknown }
        if let first = periods.first { return RipLevel(word: first.level) }
        return RipLevel(word: legacy)
    }

    static func resolve(alerts: [NwsAlert], periods: [SrfPeriod], legacyLevel: String?,
                        model: ModelNow?, now: Date) -> RipNow {
        // An alert in effect is always high.
        if alerts.contains(where: { isRipAlert($0) && status(of: $0, now: now) == .inEffect }) {
            return RipNow(level: .high, isAlert: true)
        }
        let forecast = forecastLevel(periods: periods, legacy: legacyLevel, now: now)
        if let model {
            if forecast != .unknown {
                let trusted = now.timeIntervalSince(model.run) <= modelTrusted
                // A trusted model may pull the word down one step, never more.
                // An aging model may only raise it.
                let floorLevel = trusted ? forecast.stepDown : forecast
                return RipNow(level: Swift.max(model.level, floorLevel), isAlert: false)
            }
            return RipNow(level: model.level, isAlert: false)
        }
        return RipNow(level: forecast, isAlert: false)
    }
}
