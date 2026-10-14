//
//  BeachStore.swift
//
//  The app's one source of truth AND the only owner of fetching and of reloading
//  the widget. PhoneLink only stores what the phone sent and posts a notification;
//  nothing else fetches for the app or reloads the widget, so one change causes
//  one fetch and one reload, on every path (including failure).
//

import Foundation
import SwiftUI
import WidgetKit

@MainActor
final class BeachStore: ObservableObject {
    /// One instance for the whole process, created at launch (even a background
    /// launch from WatchConnectivity), so the notification observer always exists.
    static let shared = BeachStore()

    enum Phase: Equatable {
        case idle
        case loading
        case failed(ConditionsError)
    }

    /// Why a refresh runs. Only a change of beach must always reload the widget;
    /// a foreground refresh reloads it only when new data was saved.
    enum Reason { case foreground, selection }

    @Published private(set) var activeSlug: String?
    @Published private(set) var home: String?
    @Published private(set) var lastViewed: String?
    @Published private(set) var favorites: [String] = []
    @Published private(set) var summary: BeachSummary?
    @Published private(set) var phase: Phase = .idle

    /// Bumped by every refresh; a completion that is not the newest is dropped,
    /// so two overlapping requests for the SAME beach cannot finish out of order.
    private var generation = 0

    private var observer: NSObjectProtocol?

    private init() {
        loadSelection()
        observer = NotificationCenter.default.addObserver(
            forName: .beachSelectionChanged, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.loadSelection()
                await self.refresh(.selection)
            }
        }
    }

    var activeName: String? {
        guard let slug = activeSlug else { return nil }
        return summary?.slug == slug ? summary?.name : BeachCatalog.displayName(slug)
    }

    /// Re-read the selection from the App Group and show whatever is cached.
    func loadSelection() {
        home = BeachSelection.homeSlug
        lastViewed = BeachSelection.lastViewedSlug
        favorites = BeachSelection.favorites
        let slug = BeachSelection.activeSlug
        if slug != activeSlug || summary?.slug != slug {
            activeSlug = slug
            summary = slug.flatMap(SummaryCache.load)
            phase = .idle
        }
    }

    /// Foreground refresh: skip when the cached reading is still current by the server's clock.
    func refreshIfNeeded() async {
        loadSelection()
        if let summary, summary.slug == activeSlug, summary.isFresh(), phase == .idle { return }
        await refresh(.foreground)
    }

    func refresh(_ reason: Reason) async {
        guard let slug = activeSlug else {
            // Nothing chosen (the phone cleared it): the widget must show setup, once.
            if reason == .selection { WidgetCenter.shared.reloadAllTimelines() }
            return
        }
        generation += 1
        let mine = generation
        phase = .loading
        var saved = false
        do {
            let fresh = try await ConditionsClient.fetch(slug: slug)
            if mine == generation, activeSlug == slug {
                summary = fresh
                phase = .idle
                saved = true
            }
        } catch let error as ConditionsError {
            if mine == generation, activeSlug == slug { phase = .failed(error) }
        } catch {
            if mine == generation, activeSlug == slug { phase = .failed(.badData) }
        }
        guard mine == generation else { return } // a newer refresh owns the outcome
        // The one widget reload. After a change of beach it happens even when the
        // fetch failed, so the widget never stays on "choose a beach"; it then plans
        // its own fetch from the cache or the network.
        if saved || reason == .selection { WidgetCenter.shared.reloadAllTimelines() }
    }

    /// Pick a beach on the watch (nil or the default beach = follow the phone).
    func select(_ slug: String?) async {
        BeachSelection.select(slug)
        loadSelection()
        await refresh(.selection)
    }
}
