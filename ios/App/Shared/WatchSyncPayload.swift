//
//  WatchSyncPayload.swift
//  Shared by the iPhone app, the watch app and the watch widget.
//
//  The one place that names the App Group, the sync keys and the slug rules.
//  The web app (lib/watchSync.ts) applies the same slug rule before it calls
//  the WatchSync plugin; the plugin and the watch check it again, because the
//  payload crosses a trust boundary at both ends.
//

import Foundation

enum WatchSync {
    /// App Group shared by the iPhone app, the watch app and the watch widget.
    /// It must be enabled for all three App IDs in the developer account
    /// (see scripts/ios-release/README.md, "Apple Watch app").
    static let appGroup = "group.com.isitbeachday.app"

    /// Bump only when a field is added or its meaning changes.
    static let payloadVersion = 1
    static let maxFavorites = 20

    enum Key {
        static let version = "v"
        static let homeSlug = "homeSlug"
        static let favorites = "favorites"
        /// The beach last opened in the iPhone app; the watch default when there is no home.
        static let lastViewedSlug = "lastViewedSlug"
    }

    /// `boca-raton`, `south-padre-island`: lowercase words joined by hyphens.
    /// Mirrors SLUG_PATTERN in lib/watchSync.ts.
    static func cleanSlug(_ raw: Any?) -> String? {
        guard let s = raw as? String, (1...64).contains(s.count) else { return nil }
        return s.range(of: "^[a-z0-9]+(-[a-z0-9]+)*$", options: .regularExpression) != nil ? s : nil
    }

    struct Clean: Equatable {
        var home: String?
        var favorites: [String]
        var lastViewed: String?
    }

    /// Drops anything that is not a valid slug, removes duplicates, keeps order
    /// and caps the list. Never throws: bad input becomes "no home, no favorites".
    static func clean(home: Any?, favorites: Any?, lastViewed: Any? = nil) -> Clean {
        var seen = Set<String>()
        var list: [String] = []
        for item in (favorites as? [Any]) ?? [] {
            guard let slug = cleanSlug(item), seen.insert(slug).inserted else { continue }
            list.append(slug)
            if list.count == maxFavorites { break }
        }
        return Clean(home: cleanSlug(home), favorites: list, lastViewed: cleanSlug(lastViewed))
    }
}
