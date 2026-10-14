//
//  BeachDayWatchApp.swift
//  Beach Day for Apple Watch
//
//  Shows the Beach Day score for one beach. The home beach comes from the
//  iPhone app (PhoneLink); the watch can also pick any beach itself.
//

import SwiftUI

@main
struct BeachDayWatchApp: App {
    @StateObject private var store = BeachStore.shared

    init() {
        #if DEBUG
        DebugHooks.applyLaunchArguments()
        #endif
        // Create the store before the phone link starts, so a delivery that wakes the
        // app in the background finds its observer.
        _ = BeachStore.shared
        PhoneLink.shared.start()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var store: BeachStore
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack {
            MainView()
        }
        .task { await store.refreshIfNeeded() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await store.refreshIfNeeded() } }
        }
    }
}
