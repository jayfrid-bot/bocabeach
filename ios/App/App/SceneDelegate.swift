//
//  SceneDelegate.swift
//  App
//
//  iOS 27's linked-SDK runtime check requires UIScene lifecycle adoption
//  (apps built against the iOS 27 SDK crash at launch without it: UIKitCore
//  raises SIGTRAP in _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption).
//  This scene delegate keeps the existing storyboard-based bridge UI (Main.storyboard,
//  BeachBridgeViewController) as the window's root, and forwards the URL /
//  user-activity callbacks that used to run through AppDelegate to Capacitor's
//  ApplicationDelegateProxy, exactly as AppDelegate did before scenes.
//
import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        // The storyboard-based window (UISceneStoryboardFile = Main in Info.plist)
        // is created automatically by UIKit for a scene-based app, so `window`
        // is already set by the time this runs. Handle any URL or user activity
        // that launched the app, since didFinishLaunchingWithOptions no longer
        // sees these once scenes are adopted.
        if let urlContext = connectionOptions.urlContexts.first {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: urlContext.url, options: [:])
        }
        if let userActivity = connectionOptions.userActivities.first {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let urlContext = URLContexts.first else { return }
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: urlContext.url, options: [:])
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        // Mirrors AppDelegate.applicationDidBecomeActive (no-op previously).
    }

    func sceneWillResignActive(_ scene: UIScene) {
        // Mirrors AppDelegate.applicationWillResignActive (no-op previously).
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        // Mirrors AppDelegate.applicationWillEnterForeground (no-op previously).
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        // Mirrors AppDelegate.applicationDidEnterBackground (no-op previously).
    }
}
