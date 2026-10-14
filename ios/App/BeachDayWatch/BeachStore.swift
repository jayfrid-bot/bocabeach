//
//  BeachStore.swift
//
//  The app's one source of truth: which beach is active, the last conditions
//  for it, and whether a refresh is running or failed.
//

import Foundation
import SwiftUI
import WidgetKit

@MainActor
final class BeachStore: ObservableObject {
    enum Phase: Equatable {
        case idle
        case loading
        case failed(ConditionsError)
    }

    @Published private(set) var activeSlug: String?
    @Published private(set) var home: String?
    @Published private(set) var lastViewed: String?
    @Published private(set) var favorites: [String] = []
    @Published private(set) var summary: BeachSummary?
    @Published private(set) var phase: Phase = .idle

    /// A refresh newer than this is reused when the app comes forward.
    private let reuseWindow: TimeInterval = 120

    private var observer: NSObjectProtocol?

    init() {
        loadSelection()
        observer = NotificationCenter.default.addObserver(
            forName: .beachSelectionChanged, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.loadSelection()
                await self?.refresh(force: true)
            }
        }
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
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

    /// Foreground refresh: skip when the data is already fresh.
    func refreshIfNeeded() async {
        loadSelection()
        if let summary, summary.slug == activeSlug,
           Date().timeIntervalSince(summary.fetchedAt) < reuseWindow, phase == .idle {
            return
        }
        await refresh(force: false)
    }

    func refresh(force: Bool) async {
        guard let slug = activeSlug, phase != .loading else { return }
        phase = .loading
        do {
            let fresh = try await ConditionsClient.fetch(slug: slug)
            // The user may have switched beaches while this was in flight.
            guard activeSlug == slug else { return }
            summary = fresh
            phase = .idle
            WidgetCenter.shared.reloadAllTimelines()
        } catch let error as ConditionsError {
            guard activeSlug == slug else { return }
            phase = .failed(error)
        } catch {
            guard activeSlug == slug else { return }
            phase = .failed(.badData)
        }
    }

    /// Pick a beach on the watch (nil or the home beach = follow home).
    func select(_ slug: String?) async {
        BeachSelection.select(slug)
        loadSelection()
        WidgetCenter.shared.reloadAllTimelines()
        await refresh(force: true)
    }
}
