//
//  PhoneLink.swift
//
//  Receives the home beach and favorites the iPhone app sends with
//  WatchConnectivity `updateApplicationContext`, keeps them in the App Group
//  and tells the app and the widget. The latest context is delivered even if
//  the watch app was not running when the phone sent it.
//

import Foundation
import WatchConnectivity
import WidgetKit

extension Notification.Name {
    /// Posted on the main thread when the home beach or favorites changed.
    static let beachSelectionChanged = Notification.Name("BeachSelectionChanged")
}

final class PhoneLink: NSObject, WCSessionDelegate {
    static let shared = PhoneLink()

    func start() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    private func apply(_ context: [String: Any]) {
        guard !context.isEmpty else { return }
        guard ((context[WatchSync.Key.version] as? Int) ?? WatchSync.payloadVersion) <= WatchSync.payloadVersion else { return }
        let changed = BeachSelection.applySync(
            home: context[WatchSync.Key.homeSlug],
            favorites: context[WatchSync.Key.favorites],
            lastViewed: context[WatchSync.Key.lastViewedSlug]
        )
        guard changed else { return }
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: .beachSelectionChanged, object: nil)
        }
        WidgetCenter.shared.reloadAllTimelines()
    }

    // MARK: WCSessionDelegate

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        if activationState == .activated { apply(session.receivedApplicationContext) }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        apply(applicationContext)
    }
}
