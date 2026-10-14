//
//  BeachStore.swift
//
//  The app's one source of truth AND the only owner of fetching and of reloading
//  the widget. PhoneLink only stores what the phone sent and posts a notification;
//  nothing else fetches for the app or reloads the widget, so one change causes
//  one fetch and one reload, on every path (including failure).
//
//  Rules:
//    - one request per beach at a time: a refresh asked for while one is running for
//      the same beach JOINS it, so a foreground refresh never supersedes (and so never
//      swallows the widget reload owed to) a selection-triggered request;
//    - a request that changed, or might change, what the widget shows (a new beach was
//      chosen) owes the widget exactly one reload when it finishes, success or failure,
//      so a widget waiting on "choose a beach" is never stranded;
//    - a foreground refresh reloads the widget only when it saved new data;
//    - the shared cache is written here, after the check that the answer is the newest;
//    - while the app is open it refreshes again when the server's validUntil passes.
//

import Foundation
import SwiftUI
import WidgetKit

@MainActor
final class BeachStore: ObservableObject {
    /// One instance for the whole process, created at launch (even a background
    /// launch from WatchConnectivity), so the notification observers always exist.
    static let shared = BeachStore()

    enum Phase: Equatable {
        case idle
        case loading
        case failed(ConditionsError)
    }

    /// Why a refresh runs. A change of beach always owes the widget a reload.
    enum Reason { case foreground, selection }

    @Published private(set) var activeSlug: String?
    @Published private(set) var home: String?
    @Published private(set) var lastViewed: String?
    @Published private(set) var favorites: [String] = []
    @Published private(set) var summary: BeachSummary?
    @Published private(set) var phase: Phase = .idle

    /// One request per beach: A, then B, then A again joins the A request still running.
    private var inFlight: [String: Task<Void, Never>] = [:]
    /// A selection-reason refresh is running or was joined: one widget reload is owed.
    private var reloadOwed = false
    private var expiryTask: Task<Void, Never>?
    /// Failures in a row while the app is open; each doubles the next automatic retry.
    private var failureStreak = 0
    private var observers: [NSObjectProtocol] = []
    private let fetcher: Fetcher
    private let reloadWidget: () -> Void

    typealias Fetcher = @Sendable (String) async throws -> BeachSummary

    /// The soonest the open app refreshes on its own, so an expiry that keeps landing
    /// "now" cannot spin.
    nonisolated static let expiryFloor: TimeInterval = 60
    nonisolated static let retryCeiling: TimeInterval = 15 * 60

    /// The pause before the next automatic refresh: until validUntil, never under the floor,
    /// and doubling (1, 2, 4, ... up to 15 minutes) after each failure in a row.
    nonisolated static func nextRefreshDelay(validUntil: Date, now: Date = Date(), failures: Int) -> TimeInterval {
        let backoff = min(expiryFloor * pow(2, Double(min(max(failures, 0), 10))), retryCeiling)
        let untilExpiry = validUntil.timeIntervalSince(now)
        return failures > 0 ? max(backoff, untilExpiry) : max(expiryFloor, untilExpiry)
    }

    private convenience init() {
        self.init(
            fetcher: { try await ConditionsClient.fetch(slug: $0, save: false) },
            reloadWidget: { WidgetCenter.shared.reloadAllTimelines() },
            observeNotifications: true
        )
    }

    /// The fetch and the widget reload are injected so tests can drive the request rules.
    init(fetcher: @escaping Fetcher, reloadWidget: @escaping () -> Void, observeNotifications: Bool) {
        self.fetcher = fetcher
        self.reloadWidget = reloadWidget
        loadSelection()
        guard observeNotifications else { return }
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: .beachSelectionChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.loadSelection()
                await self.refresh(.selection)
            }
        })
        observers.append(center.addObserver(forName: .beachMetadataChanged, object: nil, queue: .main) { [weak self] _ in
            // Home, favorites or last viewed changed behind an unchanged display: refresh the lists only.
            Task { @MainActor in self?.loadSelection() }
        })
        scheduleExpiryRefresh()
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
            scheduleExpiryRefresh()
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
            if reason == .selection { reloadWidget() }
            return
        }
        if reason == .selection { reloadOwed = true }
        // Join a request already running for this beach rather than starting a second one.
        if let current = inFlight[slug] {
            await current.value
            return
        }
        phase = .loading
        let task = Task { @MainActor in await self.run(slug: slug) }
        inFlight[slug] = task
        await task.value
    }

    private func run(slug: String) async {
        var saved = false
        var failure: ConditionsError?
        do {
            let fresh = try await fetcher(slug)
            // Only a request for the beach on screen publishes or writes the shared cache,
            // and the cache keeps the NEWEST answer by the server's own time (so an older
            // one finishing last cannot win, here or in the widget's process).
            if activeSlug == slug {
                summary = SummaryCache.store(fresh)
                phase = .idle
                saved = true
                failureStreak = 0
                scheduleExpiryRefresh()
            }
        } catch let error as ConditionsError {
            failure = error
        } catch {
            failure = .badData
        }
        inFlight[slug] = nil
        // The user moved to another beach meanwhile: that beach's own request owns the outcome
        // and the one widget reload that is owed.
        guard activeSlug == slug else { return }
        if let failure {
            phase = .failed(failure)
            failureStreak += 1
            scheduleExpiryRefresh() // the cached reading (if any) is kept; try again, backing off
        }
        // The one widget reload: for new data, and for any request that owed one.
        if saved || reloadOwed {
            reloadOwed = false
            reloadWidget()
        }
    }

    /// While the app is open, refresh again when the server's validUntil passes (never sooner
    /// than the floor). A background watch app is suspended; the scene activation covers that.
    private func scheduleExpiryRefresh() {
        expiryTask?.cancel()
        expiryTask = nil
        guard let summary, summary.slug == activeSlug else { return }
        let wait = Self.nextRefreshDelay(validUntil: summary.validUntil, failures: failureStreak)
        expiryTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            await self.refreshIfNeeded()
        }
    }

    /// Pick a beach on the watch (nil or the default beach = follow the phone).
    func select(_ slug: String?) async {
        BeachSelection.select(slug)
        loadSelection()
        await refresh(.selection)
    }
}
