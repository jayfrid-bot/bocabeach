//
//  DebugHooks.swift
//
//  DEBUG-only launch arguments for simulator checks and screenshots. None of
//  this is compiled into a Release build.
//
//    -debugHome <slug>        pretend the iPhone synced this home beach
//    -debugFavorites a,b,c    pretend the iPhone synced these favorites
//    -debugLastViewed <slug>  pretend the iPhone synced this last-viewed beach
//    -debugReset 1            forget the sync, the watch pick and the cache
//    -debugOffline 1          make every fetch fail (shows cache, stale and error states)
//    -debugAgeCache <min>     age the cached reading of the home beach by this many minutes
//    -debugScreen picker      open the beach picker
//    -debugScroll <id>        scroll the picker to "favorites" or "all"
//    -debugNearest 1          tap "Nearest beach" once the picker opens
//    -debugScreen complications   show the three complication faces
//

#if DEBUG
import SwiftUI
import WidgetKit

enum DebugHooks {
    static func applyLaunchArguments() {
        let d = UserDefaults.standard
        if d.bool(forKey: "debugReset") {
            let shared = SharedStore.defaults
            for key in shared.dictionaryRepresentation().keys { shared.removeObject(forKey: key) }
        }
        if d.string(forKey: "debugHome") != nil || d.string(forKey: "debugLastViewed") != nil {
            let favs = d.string(forKey: "debugFavorites")?.split(separator: ",").map(String.init) ?? []
            BeachSelection.applySync(home: d.string(forKey: "debugHome"), favorites: favs,
                                     lastViewed: d.string(forKey: "debugLastViewed"))
        }
        let age = d.double(forKey: "debugAgeCache")
        if age > 0, let slug = BeachSelection.activeSlug, var cached = SummaryCache.load(slug) {
            cached.dataAt = cached.dataAt.addingTimeInterval(-age * 60)
            SummaryCache.save(cached)
        }
    }

    @ViewBuilder static func overlay(store: BeachStore) -> some View {
        switch UserDefaults.standard.string(forKey: "debugScreen") {
        case "complications": ComplicationGallery(store: store)
        default: EmptyView()
        }
    }
}

struct ComplicationGallery: View {
    @ObservedObject var store: BeachStore

    var body: some View {
        let content: ComplicationContent = store.summary.map(ComplicationContent.summary) ?? .unavailable
        ScrollView {
            VStack(spacing: 8) {
                Text("Complications").font(.caption).foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    CircularComplication(content: content).frame(width: 64, height: 64)
                    InlineComplication(content: content).font(.caption2)
                }
                RectangularComplication(content: content)
                    .padding(8)
                    .background(.black.opacity(0.5), in: RoundedRectangle(cornerRadius: 12))
            }
        }
        .background(.black)
    }
}
#endif
