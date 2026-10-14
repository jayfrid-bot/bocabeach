//
//  PhoneLink.swift
//
//  Receives the home beach, favorites and last-viewed beach the iPhone app sends
//  with WatchConnectivity `updateApplicationContext` and keeps them in the App
//  Group. The latest context is delivered even if the watch app was not running
//  when the phone sent it.
//

import Foundation
import WatchConnectivity

extension Notification.Name {
    /// Posted on the main thread when the beach the watch SHOWS changed (BeachStore fetches
    /// and reloads the widget).
    static let beachSelectionChanged = Notification.Name("BeachSelectionChanged")
    /// Posted when only the home, favorites or last-viewed values changed (an open picker
    /// refreshes its lists; nothing is fetched).
    static let beachMetadataChanged = Notification.Name("BeachMetadataChanged")
}

final class PhoneLink: NSObject, WCSessionDelegate {
    static let shared = PhoneLink()

    /// Bounded retry for a failed activation: seconds before attempt 1, 2, 3, ...
    private static let retryDelays: [TimeInterval] = [2, 5, 15, 60, 180]
    private var retryAttempt = 0

    func start() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    private func retryActivation() {
        DispatchQueue.main.async {
            guard self.retryAttempt < Self.retryDelays.count else {
                NSLog("PhoneLink: giving up on activation until the next launch")
                return
            }
            let delay = Self.retryDelays[self.retryAttempt]
            self.retryAttempt += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { self.start() }
        }
    }

    /// WCSession delegate callbacks arrive on a background thread. The whole
    /// apply (several keys, then the notification) runs on the main queue so it
    /// cannot interleave with a selection change made on screen. This only STORES
    /// what the phone sent: BeachStore owns the fetch and the widget reload, and
    /// is told only when the beach shown actually changed.
    private func apply(_ context: [String: Any]) {
        guard !context.isEmpty else { return }
        guard ((context[WatchSync.Key.version] as? Int) ?? WatchSync.payloadVersion) <= WatchSync.payloadVersion else { return }
        DispatchQueue.main.async {
            let outcome = BeachSelection.applySyncOutcome(
                home: context[WatchSync.Key.homeSlug],
                favorites: context[WatchSync.Key.favorites],
                lastViewed: context[WatchSync.Key.lastViewedSlug]
            )
            if outcome.activeChanged {
                NotificationCenter.default.post(name: .beachSelectionChanged, object: nil)
            } else if outcome.metadataChanged {
                NotificationCenter.default.post(name: .beachMetadataChanged, object: nil)
            }
        }
    }

    // MARK: WCSessionDelegate

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        if let error { NSLog("PhoneLink: activation failed: %@", error.localizedDescription) }
        if activationState == .activated {
            DispatchQueue.main.async { self.retryAttempt = 0 }
            apply(session.receivedApplicationContext)
        } else {
            retryActivation()
        }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        apply(applicationContext)
    }
}
