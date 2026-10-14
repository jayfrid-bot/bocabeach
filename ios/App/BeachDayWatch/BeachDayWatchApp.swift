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
    @StateObject private var store: BeachStore

    init() {
        #if DEBUG
        DebugHooks.applyLaunchArguments()
        #endif
        PhoneLink.shared.start()
        _store = StateObject(wrappedValue: BeachStore())
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
