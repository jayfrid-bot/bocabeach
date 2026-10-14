//
//  ConditionsModels.swift
//
//  The slice of GET /api/conditions/<slug> the watch reads. Every field is
//  optional on purpose: the endpoint returns about 160 KB (17 KB gzipped) of
//  which the watch uses a few numbers, and a missing or reshaped source must
//  never fail the whole decode. Shapes follow lib/types.ts.
//

import Foundation

/// `{source, status, data}` envelope (Wrapped<T> in lib/types.ts). A `data`
/// value that is missing, null or the wrong shape reads as nil.
struct Wrapped<T: Decodable>: Decodable {
    let status: String?
    let data: T?

    private enum CodingKeys: String, CodingKey { case status, data }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        data = (try? c.decodeIfPresent(T.self, forKey: .data)) ?? nil
    }

    /// Data from a source that did not fail outright. "stale" still carries
    /// the last good reading, the same as the web app.
    var usable: T? { status == "error" ? nil : data }
}

struct ConditionsResponse: Decodable {
    let snapshot: Snapshot
    let score: ScoreBlock?
    let multiDayWindows: [DayWindow]?
}

struct ScoreBlock: Decodable {
    let score: Int?
    let rating: String?
    let dataAvailable: Bool?
    let dataCoverage: String?
}

struct DayWindow: Decodable {
    let date: String?
    let dow: String?
    let best: BestWindow?
}

struct BestWindow: Decodable {
    let startIso: String?
    let endIso: String?
    let score: Int?
}

struct Snapshot: Decodable {
    let location: SnapshotLocation
    let generatedAt: String?
    let buoy: Wrapped<BuoyData>?
    let marine: Wrapped<MarineData>?
    let cityOfficial: Wrapped<CityOfficialData>?
    let nws: Wrapped<NwsData>?
    let ripNwps: Wrapped<RipNwpsData>?
    let lightning: Wrapped<LightningData>?
    let precipRadar: Wrapped<PrecipRadarData>?
}

struct SnapshotLocation: Decodable {
    let slug: String?
    let name: String
    let timezone: String?
}

struct BuoyData: Decodable { let waterTempF: Double? }
struct MarineData: Decodable { let seaSurfaceTempF: Double? }

struct CityOfficialData: Decodable {
    let flags: [String]?
    let noSwimAdvisory: NoSwimAdvisory?
}
struct NoSwimAdvisory: Decodable { let title: String? }

struct NwsData: Decodable {
    let alerts: [NwsAlert]?
    let ripCurrentRisk: String?
    let srfPeriods: [SrfPeriod]?
}

struct NwsAlert: Decodable {
    let event: String
    let severity: String?
    let headline: String?
    let description: String?
    let effective: String?
    let onset: String?
    let ends: String?
    let expires: String?
}

struct SrfPeriod: Decodable {
    let label: String?
    let level: String?
    let start: String?
    let end: String?
}

struct RipNwpsData: Decodable {
    let run: String?
    let hours: [RipHour]?
}
struct RipHour: Decodable {
    let t: String
    let prob: Double
}

struct LightningData: Decodable {
    let nearestMi: Double?
    let nearestMinutesAgo: Double?
}

struct PrecipRadarData: Decodable {
    let rainNowMmHr: Double?
    let nearestRainKm: Double?
    let etaMinutes: Double?
    let frameAgeMinutes: Double?
}

/// ISO-8601 with or without fractional seconds ("...:20.051Z" and "...:00+00:00").
enum ISODate {
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func parse(_ s: String?) -> Date? {
        guard let s else { return nil }
        return withFraction.date(from: s) ?? plain.date(from: s)
    }
}
