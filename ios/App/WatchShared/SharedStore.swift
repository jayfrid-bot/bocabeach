//
//  SharedStore.swift
//
//  Everything the watch app and the watch widget share through the App
//  Group: which beach to show (home from the iPhone, optional pick made on
//  the watch) and the last conditions received per beach.
//
//  If the App Group is not enabled for these App IDs yet (it needs the
//  developer account), `UserDefaults(suiteName:)` still works but the app and
//  the widget would each see their own copy. The app still works; the widget
//  then shows "Open Beach Day to choose a beach". See scripts/ios-release/README.md.
//

import Foundation

enum SharedStore {
    static let defaults: UserDefaults = UserDefaults(suiteName: WatchSync.appGroup) ?? .standard
}

enum BeachSelection {
    private static let selectedKey = "selectedSlug"
    private static let syncedAtKey = "syncedAt"

    /// The beach the iPhone app says is home.
    static var homeSlug: String? {
        WatchSync.cleanSlug(SharedStore.defaults.string(forKey: WatchSync.Key.homeSlug))
    }

    static var favorites: [String] {
        WatchSync.clean(home: nil, favorites: SharedStore.defaults.array(forKey: WatchSync.Key.favorites)).favorites
    }

    /// The beach last opened in the iPhone app. Used only when there is no home.
    static var lastViewedSlug: String? {
        WatchSync.cleanSlug(SharedStore.defaults.string(forKey: WatchSync.Key.lastViewedSlug))
    }

    /// What the watch shows when nothing was picked on it: home, else last viewed.
    static var defaultSlug: String? { homeSlug ?? lastViewedSlug }

    /// A beach picked on the watch. It wins over home until the user resets it
    /// or changes their home beach on the phone.
    static var selectedSlug: String? {
        WatchSync.cleanSlug(SharedStore.defaults.string(forKey: selectedKey))
    }

    /// The beach the app and the complications show:
    /// a beach picked on the watch, else the iPhone's home beach, else the beach
    /// last viewed on the iPhone.
    static var activeSlug: String? { selectedSlug ?? defaultSlug }

    static var lastSyncedAt: Date? {
        let t = SharedStore.defaults.double(forKey: syncedAtKey)
        return t > 0 ? Date(timeIntervalSince1970: t) : nil
    }

    /// Stores a payload from the phone. Returns true when anything changed.
    /// A new home beach on the phone clears a pick made on the watch, so the
    /// watch follows the phone.
    @discardableResult
    static func applySync(home rawHome: Any?, favorites rawFavorites: Any?, lastViewed rawLastViewed: Any? = nil, at date: Date = Date()) -> Bool {
        let clean = WatchSync.clean(home: rawHome, favorites: rawFavorites, lastViewed: rawLastViewed)
        let d = SharedStore.defaults
        let changed = clean.home != homeSlug || clean.favorites != favorites || clean.lastViewed != lastViewedSlug
        if clean.home != homeSlug { d.removeObject(forKey: selectedKey) }
        if let home = clean.home { d.set(home, forKey: WatchSync.Key.homeSlug) } else { d.removeObject(forKey: WatchSync.Key.homeSlug) }
        d.set(clean.favorites, forKey: WatchSync.Key.favorites)
        if let last = clean.lastViewed { d.set(last, forKey: WatchSync.Key.lastViewedSlug) } else { d.removeObject(forKey: WatchSync.Key.lastViewedSlug) }
        d.set(date.timeIntervalSince1970, forKey: syncedAtKey)
        return changed
    }

    /// Pick a beach on the watch. Passing the default beach (or nil) goes back to following the phone.
    static func select(_ slug: String?) {
        let d = SharedStore.defaults
        if let slug = WatchSync.cleanSlug(slug), slug != defaultSlug {
            d.set(slug, forKey: selectedKey)
        } else {
            d.removeObject(forKey: selectedKey)
        }
    }
}

/// The last conditions received, per beach.
enum SummaryCache {
    private static func key(_ slug: String) -> String { "summary.\(slug)" }

    static func load(_ slug: String) -> BeachSummary? {
        guard let data = SharedStore.defaults.data(forKey: key(slug)) else { return nil }
        return try? JSONDecoder().decode(BeachSummary.self, from: data)
    }

    static func save(_ summary: BeachSummary) {
        guard let data = try? JSONEncoder().encode(summary) else { return }
        SharedStore.defaults.set(data, forKey: key(summary.slug))
    }
}
