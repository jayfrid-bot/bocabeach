//
//  BeachCatalog.swift
//
//  The beaches the watch can show: Beaches.json (generated from
//  config/locations.ts by scripts/ios-watch/export-beaches.mjs) bundled in the
//  app. A beach added in the admin console reaches the watch with the next
//  iPhone-app release; until then the phone's home beach still works because
//  the API accepts any slug.
//

import Foundation

struct Beach: Codable, Identifiable, Hashable {
    let slug: String
    let name: String
    let region: String
    let lat: Double
    let lon: Double
    let shore: [[Double]]?

    var id: String { slug }
}

enum BeachCatalog {
    static let all: [Beach] = {
        guard let url = Bundle.main.url(forResource: "Beaches", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let list = try? JSONDecoder().decode([Beach].self, from: data) else { return [] }
        return list
    }()

    static func beach(_ slug: String) -> Beach? { all.first { $0.slug == slug } }

    /// Name for a slug, falling back to a readable form of the slug itself.
    static func displayName(_ slug: String) -> String {
        beach(slug)?.name ?? slug.split(separator: "-").map { $0.capitalized }.joined(separator: " ")
    }

    static func nearest(toLat lat: Double, lon: Double) -> (beach: Beach, miles: Double)? {
        all.map { ($0, distanceMiles(lat: lat, lon: lon, to: $0)) }
            .min { $0.1 < $1.1 }
            .map { (beach: $0.0, miles: $0.1) }
    }

    /// Miles from a point to the closest point on the beach's shoreline (or its pin).
    static func distanceMiles(lat: Double, lon: Double, to beach: Beach) -> Double {
        let points: [(Double, Double)] = (beach.shore ?? []).compactMap { $0.count == 2 ? ($0[0], $0[1]) : nil }
        guard points.count >= 2 else { return haversine(lat, lon, beach.lat, beach.lon) }
        var best = Double.greatestFiniteMagnitude
        for i in 0..<(points.count - 1) {
            best = min(best, distanceToSegment(lat, lon, points[i], points[i + 1]))
        }
        return best
    }

    private static func distanceToSegment(_ lat: Double, _ lon: Double,
                                          _ a: (Double, Double), _ b: (Double, Double)) -> Double {
        // Flat local projection around the point; fine for the few miles that matter here.
        let kx = cos(lat * .pi / 180)
        let ax = (a.1 - lon) * kx, ay = a.0 - lat
        let bx = (b.1 - lon) * kx, by = b.0 - lat
        let dx = bx - ax, dy = by - ay
        let len2 = dx * dx + dy * dy
        let t = len2 == 0 ? 0 : max(0, min(1, -(ax * dx + ay * dy) / len2))
        let px = ax + t * dx, py = ay + t * dy
        return hypot(px, py) * 69.0
    }

    private static func haversine(_ lat1: Double, _ lon1: Double, _ lat2: Double, _ lon2: Double) -> Double {
        let r = 3958.8
        let dLat = (lat2 - lat1) * .pi / 180, dLon = (lon2 - lon1) * .pi / 180
        let a = sin(dLat / 2) * sin(dLat / 2)
            + cos(lat1 * .pi / 180) * cos(lat2 * .pi / 180) * sin(dLon / 2) * sin(dLon / 2)
        return 2 * r * asin(min(1, sqrt(a)))
    }
}
