//
//  SharedStore.swift
//
//  Everything the watch app and the watch widget share through the App
//  Group: which beach to show (home from the iPhone, optional pick made on
//  the watch) and the last conditions received per beach.
//
//  The App Group `group.com.isitbeachday.app` is enabled for the iPhone app, the
//  watch app and the widget (see scripts/ios-release/README.md).
//

import Foundation

enum SharedStore {
    /// The App Group's defaults. Declared in PrivacyInfo.xcprivacy as
    /// UserDefaults reason 1C8F.1. There is no `.standard` fallback: it would
    /// need a second declared reason, and a suite name that is not this app's
    /// own bundle id never returns nil.
    static let defaults: UserDefaults = UserDefaults(suiteName: WatchSync.appGroup)!
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

    /// Stores a payload from the phone. Returns true only when the beach the watch
    /// SHOWS changed: a changed favorite or last-viewed beach behind an unchanged
    /// display must not trigger a fetch or a widget reload. A new home beach on
    /// the phone clears a pick made on the watch, so the watch follows the phone.
    @discardableResult
    static func applySync(home rawHome: Any?, favorites rawFavorites: Any?, lastViewed rawLastViewed: Any? = nil, at date: Date = Date()) -> Bool {
        let clean = WatchSync.clean(home: rawHome, favorites: rawFavorites, lastViewed: rawLastViewed)
        let d = SharedStore.defaults
        let before = activeSlug
        if clean.home != homeSlug { d.removeObject(forKey: selectedKey) }
        if let home = clean.home { d.set(home, forKey: WatchSync.Key.homeSlug) } else { d.removeObject(forKey: WatchSync.Key.homeSlug) }
        d.set(clean.favorites, forKey: WatchSync.Key.favorites)
        if let last = clean.lastViewed { d.set(last, forKey: WatchSync.Key.lastViewedSlug) } else { d.removeObject(forKey: WatchSync.Key.lastViewedSlug) }
        d.set(date.timeIntervalSince1970, forKey: syncedAtKey)
        return activeSlug != before
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
