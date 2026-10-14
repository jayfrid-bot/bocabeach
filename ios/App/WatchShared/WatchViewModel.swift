//
//  WatchViewModel.swift
//
//  Decodes GET /api/watch/<slug> (lib/watchView.ts). That endpoint returns
//  exactly what the watch shows, already decided by the website's own logic, so
//  the watch has no safety rules of its own: it validates and draws.
//
//  Decoding is lenient on purpose. Every field is optional, a field of the
//  wrong type reads as missing, a bad line is skipped without losing the rest,
//  and numbers are checked (finite, plausible range) before any Int conversion.
//

import Foundation

/// Decodes one element of an array without failing the whole array.
private struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

struct WatchLineDTO: Decodable {
    let kind: String?
    let text: String?
    let tone: String?

    private enum CodingKeys: String, CodingKey { case kind, text, tone }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try? c.decodeIfPresent(String.self, forKey: .kind)
        text = try? c.decodeIfPresent(String.self, forKey: .text)
        tone = try? c.decodeIfPresent(String.self, forKey: .tone)
    }
}

struct WatchViewDTO: Decodable {
    /// Payload version (this build speaks 1); any other value is not for it.
    let v: Int?
    let slug: String?
    let name: String?
    let score: Double?
    let limitedData: Bool?
    let lines: [WatchLineDTO]?
    let waterTempF: Double?
    let generatedAt: String?
    let capturedAt: String?
    let validUntil: String?

    private enum CodingKeys: String, CodingKey {
        case v, slug, name, score, limitedData, lines, waterTempF, generatedAt, capturedAt, validUntil
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        v = try? c.decodeIfPresent(Int.self, forKey: .v)
        slug = try? c.decodeIfPresent(String.self, forKey: .slug)
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        score = try? c.decodeIfPresent(Double.self, forKey: .score)
        limitedData = try? c.decodeIfPresent(Bool.self, forKey: .limitedData)
        lines = (try? c.decodeIfPresent([Lossy<WatchLineDTO>].self, forKey: .lines))?.compactMap { $0.value }
        waterTempF = try? c.decodeIfPresent(Double.self, forKey: .waterTempF)
        generatedAt = try? c.decodeIfPresent(String.self, forKey: .generatedAt)
        capturedAt = try? c.decodeIfPresent(String.self, forKey: .capturedAt)
        validUntil = try? c.decodeIfPresent(String.self, forKey: .validUntil)
    }
}

/// ISO-8601 with or without fractional seconds.
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

enum WatchViewDecoder {
    static let maxLines = 6
    static let maxLineLength = 80

    /// A whole number in `range`, or nil. Never traps on NaN, infinity or huge values.
    static func wholeNumber(_ x: Double?, in range: ClosedRange<Int>) -> Int? {
        guard let x, x.isFinite else { return nil }
        let r = x.rounded()
        guard r >= Double(range.lowerBound), r <= Double(range.upperBound) else { return nil }
        return Int(r)
    }

    static let supportedVersion = 1

    /// nil unless the body is a JSON object with `v == 1` whose slug, when present,
    /// is the beach that was asked for (a mismatched body must never fill another beach's cache).
    static func decode(_ data: Data, expectedSlug: String? = nil) -> WatchViewDTO? {
        guard let dto = try? JSONDecoder().decode(WatchViewDTO.self, from: data),
              dto.v == supportedVersion else { return nil }
        if let expectedSlug, let slug = dto.slug, slug != expectedSlug { return nil }
        return dto
    }

    /// Builds what the watch caches and draws. `slug` is the beach that was asked for.
    static func summary(from dto: WatchViewDTO, slug: String, fetchedAt: Date) -> BeachSummary {
        let lines: [SummaryLine] = (dto.lines ?? []).compactMap { raw in
            guard var text = raw.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
            // A line is never dropped for length: it is cut with an ellipsis.
            if text.count > maxLineLength { text = String(text.prefix(maxLineLength - 1)) + "\u{2026}" }
            return SummaryLine(
                kind: LineKind(rawValue: raw.kind ?? "") ?? .other,
                text: text,
                // An unknown or missing tone is not "all clear": show it as a caution.
                tone: Tone(rawValue: raw.tone ?? "") ?? .caution
            )
        }
        let name = dto.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let dataAt = ISODate.parse(dto.generatedAt) ?? ISODate.parse(dto.capturedAt) ?? fetchedAt
        // The server says when the view stops being current. Never trust it past
        // 15 minutes after the snapshot, and with no value assume exactly that.
        let ceiling = dataAt.addingTimeInterval(BeachSummary.maxValidity)
        let validUntil = min(ISODate.parse(dto.validUntil) ?? ceiling, ceiling)
        return BeachSummary(
            slug: slug,
            name: (name?.isEmpty == false ? name : nil) ?? prettify(slug),
            score: wholeNumber(dto.score, in: 0...100),
            limitedData: dto.limitedData ?? false,
            lines: Array(lines.prefix(maxLines)),
            waterTempF: wholeNumber(dto.waterTempF, in: -10...150),
            dataAt: dataAt,
            validUntil: validUntil,
            fetchedAt: fetchedAt
        )
    }

    /// "south-padre-island" -> "South Padre Island"
    static func prettify(_ slug: String) -> String {
        slug.split(separator: "-").map { $0.capitalized }.joined(separator: " ")
    }
}
