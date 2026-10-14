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
///
/// All state lives on one serial queue (`queue`). Capacitor calls plugin methods
/// on its own queue and WatchConnectivity calls the delegate on a background
/// thread; both hop onto `queue` before touching anything here.
final class WatchSyncHub: NSObject, WCSessionDelegate {
    static let shared = WatchSyncHub()

    enum SendResult: Equatable {
        /// Nothing more to do: delivered, unchanged, or no watch to deliver to yet.
        case ok
        /// The system refused the context; the web side should try again later.
        case failed(String)
    }

    private let queue = DispatchQueue(label: "com.isitbeachday.watchsync")

    // Only touched on `queue`.
    private var latest: [String: Any]?
    /// The last context handed to the system successfully.
    private var delivered: [String: Any]?
    private var loaded = false
    private var activating = false

    private var store: UserDefaults { UserDefaults(suiteName: WatchSync.appGroup)! }

    /// Warm up the session (called when the plugin loads).
    func start() {
        queue.async { self.ensureActivated() }
    }

    /// Calls `completion` on `queue` once the payload has been handed to the system,
    /// found unchanged, or found to have nowhere to go yet.
    func send(home: String?, favorites: [String], lastViewed: String? = nil,
              completion: @escaping (SendResult) -> Void = { _ in }) {
        queue.async {
            self.loadSavedIfNeeded()
            var context: [String: Any] = [
                WatchSync.Key.version: WatchSync.payloadVersion,
                WatchSync.Key.favorites: favorites,
            ]
            if let home { context[WatchSync.Key.homeSlug] = home }
            if let lastViewed { context[WatchSync.Key.lastViewedSlug] = lastViewed }
            self.latest = context
            self.store.set(context, forKey: "watchSync.context")
            // Same keys the watch app reads, for anything on the phone that wants them.
            if let home { self.store.set(home, forKey: WatchSync.Key.homeSlug) } else { self.store.removeObject(forKey: WatchSync.Key.homeSlug) }
            self.store.set(favorites, forKey: WatchSync.Key.favorites)
            if let lastViewed { self.store.set(lastViewed, forKey: WatchSync.Key.lastViewedSlug) } else { self.store.removeObject(forKey: WatchSync.Key.lastViewedSlug) }
            completion(self.flush())
        }
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

    // MARK: On `queue` only

    private func loadSavedIfNeeded() {
        guard !loaded else { return }
        loaded = true
        // What was sent before the app was killed, so a fresh activation (or a
        // newly installed watch app) still gets it.
        if latest == nil, let saved = store.dictionary(forKey: "watchSync.context") { latest = saved }
    }

    /// Starts activation unless it is running or done. An activation that failed
    /// leaves `activating` false, so the next call tries again.
    private func ensureActivated() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        if session.activationState != .activated && !activating {
            activating = true
            session.activate()
        }
    }

    /// Hands the newest context to the system when a watch can take it.
    private func flush() -> SendResult {
        loadSavedIfNeeded()
        guard WCSession.isSupported(), let latest else { return .ok }
        ensureActivated()
        let session = WCSession.default
        // Not activated yet, or no watch to receive it: kept, and flushed from the
        // delegate callbacks below when that changes.
        guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { return .ok }
        if let delivered, (delivered as NSDictionary).isEqual(to: latest) { return .ok }
        do {
            try session.updateApplicationContext(latest)
            delivered = latest
            return .ok
        } catch {
            NSLog("WatchSync: updateApplicationContext failed: %@", error.localizedDescription)
            return .failed(error.localizedDescription)
        }
    }

    // MARK: WCSessionDelegate (background thread; hop to `queue`)

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        queue.async {
            self.activating = false
            if let error { NSLog("WatchSync: activation failed: %@", error.localizedDescription) }
            if activationState == .activated {
                // A new activation can mean a different or reset counterpart: resend.
                self.delivered = nil
                _ = self.flush()
            }
            // On failure `activating` is false, so the next send() activates again.
        }
    }

    func sessionWatchStateDidChange(_ session: WCSession) {
        queue.async {
            // A newly installed watch app has not seen the last context yet.
            self.delivered = nil
            _ = self.flush()
        }
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}

    func sessionDidDeactivate(_ session: WCSession) {
        // A different watch was paired: activate again for the new one.
        queue.async {
            self.activating = false
            self.delivered = nil
            self.ensureActivated()
        }
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

    /// `WKWebView.url` is main-thread state; Capacitor calls plugin methods on its own queue.
    private func originAllowed() -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let url = bridge?.webView?.url, let host = url.host, let scheme = url.scheme else { return false }
        if scheme == "https" && host == Self.allowedHost { return true }
        #if DEBUG
        if (scheme == "http" || scheme == "https") && (host == "localhost" || host == "127.0.0.1") { return true }
        #endif
        return false
    }

    /// `{homeSlug: string | null, favorites: string[], lastViewedSlug?: string | null}`
    /// Resolves `{ok: false, reason}` when the system refused the payload, so the
    /// web side does not mark it sent and tries again.
    @objc func setBeaches(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.originAllowed() else {
                call.resolve(["ok": false, "reason": "origin-not-allowed"])
                return
            }
            let clean = WatchSync.clean(home: call.options["homeSlug"], favorites: call.options["favorites"],
                                        lastViewed: call.options["lastViewedSlug"])
            WatchSyncHub.shared.send(home: clean.home, favorites: clean.favorites, lastViewed: clean.lastViewed) { result in
                switch result {
                case .ok:
                    call.resolve(self.statusPayload(ok: true))
                case .failed(let reason):
                    call.resolve(["ok": false, "reason": "send-failed", "detail": reason])
                }
            }
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.originAllowed() else {
                call.resolve(["ok": false, "reason": "origin-not-allowed"])
                return
            }
            call.resolve(self.statusPayload(ok: true))
        }
    }

    private func statusPayload(ok: Bool) -> [String: Any] {
        let s = WatchSyncHub.shared.status
        return ["ok": ok, "supported": s.supported, "activated": s.activated,
                "paired": s.paired, "watchAppInstalled": s.watchAppInstalled]
    }
}
