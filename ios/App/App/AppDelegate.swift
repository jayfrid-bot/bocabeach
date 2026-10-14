import UIKit
import Capacitor
#if DEBUG
import ActivityKit
#endif

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--demo-live-activity") {
            BeachSessionDemo.run()
        }
        if ProcessInfo.processInfo.arguments.contains("--probe-live-activity-plugin") {
            BeachSessionActivityPlugin.runProbe()
        }
        if ProcessInfo.processInfo.arguments.contains("--probe-live-activity-start-only") {
            BeachSessionActivityPlugin.runProbeStartOnly()
        }
        // Sends a home beach + favorites to a paired watch, the same path the
        // WatchSync plugin takes: --probe-watch-sync <home|-> [fav,fav] [lastViewed].
        if let i = ProcessInfo.processInfo.arguments.firstIndex(of: "--probe-watch-sync"),
           ProcessInfo.processInfo.arguments.count > i + 1 {
            let args = ProcessInfo.processInfo.arguments
            let favs = args.count > i + 2 ? args[i + 2].split(separator: ",").map(String.init) : []
            let last = args.count > i + 3 ? args[i + 3] : nil
            WatchSyncHub.shared.send(home: WatchSync.cleanSlug(args[i + 1]),
                                     favorites: WatchSync.clean(home: nil, favorites: favs).favorites,
                                     lastViewed: WatchSync.cleanSlug(last))
        }
        #endif
        return true
    }

    // applicationWillResignActive / DidEnterBackground / WillEnterForeground /
    // DidBecomeActive were no-op stubs here and now live as no-op stubs in
    // SceneDelegate (the app is scene-based as of iOS 27 support), so they are
    // removed rather than duplicated.

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    // Required by @capacitor/push-notifications: forward the APNs device-token
    // callbacks to Capacitor, which surfaces them to the JS `registration` /
    // `registrationError` listeners. Without these, register() hangs forever.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    // application(_:open:options:) and application(_:continue:restorationHandler:)
    // moved to SceneDelegate.scene(_:openURLContexts:) / scene(_:continue:) and
    // scene(_:willConnectTo:options:) for the connectionOptions.urlContexts /
    // userActivities case (cold launch via URL or Universal Link). A scene-based
    // app routes these to the scene delegate, so keeping them here too would
    // risk double-handling.

}
