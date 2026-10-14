//
//  WatchSyncPlugin.swift
//
//  Capacitor bridge that lets the web app tell the Apple Watch app which
//  beach is home (and which are favorites). The web code calls
//  `WatchSync.setBeaches({homeSlug, favorites})` whenever they change
//  (lib/watchSync.ts). This file keeps the latest values in the App Group and
//  sends them to the watch with WatchConnectivity `updateApplicationContext`,
//  which delivers only the newest state, even when the watch app is not
//  running or is installed later.
//
//  Registration: a LOCAL plugin, registered in code by
//  BeachBridgeViewController.capacitorDidLoad() (same reason as
//  BeachSessionActivityPlugin: `cap sync` rewrites packageClassList).
//
//  Every method resolves with `{ok, ...}` and never rejects. Calls are served
//  only when the WebView is on app.isitbeachday.com (or localhost in DEBUG).
//  Slugs are validated here and again on the watch (WatchSyncPayload.swift).
//

import Capacitor
import Foundation
import WatchConnectivity

/// Owns the WCSession on the phone. A singleton because a WCSession needs one
/// long-lived delegate, whatever the web view does.
final class WatchSyncHub: NSObject, WCSessionDelegate {
    static let shared = WatchSyncHub()

    private var latest: [String: Any]?
    private var started = false

    private var store: UserDefaults { UserDefaults(suiteName: WatchSync.appGroup) ?? .standard }

    func start() {
        guard !started else { return }
        started = true
        // Pick up what was sent before the app was killed, so a fresh
        // activation (or a newly installed watch app) still gets it.
        if let saved = store.dictionary(forKey: "watchSync.context") { latest = saved }
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    /// Returns false when the payload is unchanged (nothing to send).
    @discardableResult
    func send(home: String?, favorites: [String], lastViewed: String? = nil) -> Bool {
        start()
        var context: [String: Any] = [
            WatchSync.Key.version: WatchSync.payloadVersion,
            WatchSync.Key.favorites: favorites,
        ]
        if let home { context[WatchSync.Key.homeSlug] = home }
        if let lastViewed { context[WatchSync.Key.lastViewedSlug] = lastViewed }
        let unchanged = (latest as NSDictionary?)?.isEqual(to: context) ?? false
        latest = context
        store.set(context, forKey: "watchSync.context")
        // Same keys the watch app reads, for anything on the phone that wants them.
        if let home { store.set(home, forKey: WatchSync.Key.homeSlug) } else { store.removeObject(forKey: WatchSync.Key.homeSlug) }
        store.set(favorites, forKey: WatchSync.Key.favorites)
        if let lastViewed { store.set(lastViewed, forKey: WatchSync.Key.lastViewedSlug) } else { store.removeObject(forKey: WatchSync.Key.lastViewedSlug) }
        flush()
        return !unchanged
    }

    struct Status {
        var supported: Bool
        var activated: Bool
        var paired: Bool
        var watchAppInstalled: Bool
    }

    var status: Status {
        guard WCSession.isSupported() else { return Status(supported: false, activated: false, paired: false, watchAppInstalled: false) }
        let s = WCSession.default
        return Status(supported: true, activated: s.activationState == .activated,
                      paired: s.isPaired, watchAppInstalled: s.isWatchAppInstalled)
    }

    /// Hand the newest context to the system when a watch can take it.
    func flush() {
        guard WCSession.isSupported(), let latest else { return }
        let session = WCSession.default
        guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { return }
        do {
            try session.updateApplicationContext(latest)
        } catch {
            // Not fatal: the next state change or call tries again.
            NSLog("WatchSync: updateApplicationContext failed: %@", error.localizedDescription)
        }
    }

    // MARK: WCSessionDelegate

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        if activationState == .activated { flush() }
    }

    func sessionWatchStateDidChange(_ session: WCSession) { flush() }

    func sessionDidBecomeInactive(_ session: WCSession) {}

    func sessionDidDeactivate(_ session: WCSession) {
        // A different watch was paired: activate again for the new one.
        session.activate()
    }
}

@objc(WatchSyncPlugin)
public class WatchSyncPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WatchSyncPlugin"
    public let jsName = "WatchSync"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setBeaches", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise)
    ]

    private static let allowedHost = "app.isitbeachday.com"

    override public func load() {
        WatchSyncHub.shared.start()
    }

    private func originAllowed() -> Bool {
        guard let url = bridge?.webView?.url, let host = url.host, let scheme = url.scheme else { return false }
        if scheme == "https" && host == Self.allowedHost { return true }
        #if DEBUG
        if (scheme == "http" || scheme == "https") && (host == "localhost" || host == "127.0.0.1") { return true }
        #endif
        return false
    }

    /// `{homeSlug: string | null, favorites: string[], lastViewedSlug?: string | null}`
    @objc func setBeaches(_ call: CAPPluginCall) {
        guard originAllowed() else {
            call.resolve(["ok": false, "reason": "origin-not-allowed"])
            return
        }
        let clean = WatchSync.clean(home: call.options["homeSlug"], favorites: call.options["favorites"],
                                    lastViewed: call.options["lastViewedSlug"])
        WatchSyncHub.shared.send(home: clean.home, favorites: clean.favorites, lastViewed: clean.lastViewed)
        call.resolve(statusPayload(ok: true))
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        guard originAllowed() else {
            call.resolve(["ok": false, "reason": "origin-not-allowed"])
            return
        }
        call.resolve(statusPayload(ok: true))
    }

    private func statusPayload(ok: Bool) -> [String: Any] {
        let s = WatchSyncHub.shared.status
        return ["ok": ok, "supported": s.supported, "activated": s.activated,
                "paired": s.paired, "watchAppInstalled": s.watchAppInstalled]
    }
}
