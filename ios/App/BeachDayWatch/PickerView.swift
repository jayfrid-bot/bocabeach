//
//  PickerView.swift
//
//  Choose a beach: the nearest one (location only on tap), home and
//  favorites from the iPhone, then every beach with search.
//

import SwiftUI

struct PickerView: View {
    @EnvironmentObject private var store: BeachStore
    @Environment(\.dismiss) private var dismiss
    @StateObject private var locator = NearestLocator()
    @State private var query = ""

    private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    private var results: [Beach] {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return BeachCatalog.all }
        return BeachCatalog.all.filter {
            $0.name.localizedCaseInsensitiveContains(q) || $0.region.localizedCaseInsensitiveContains(q)
        }
    }

    var body: some View {
        ScrollViewReader { proxy in list.task { debugActions(proxy) } }
    }

    private var list: some View {
        List {
            if !searching {
                nearestSection
                if let home = store.home { homeSection(home) }
                else if let last = store.lastViewed { lastViewedSection(last) }
                favoritesSection
            }
            Section(searching ? "Results" : "All beaches") {
                ForEach(results) { beach in row(slug: beach.slug, name: beach.name, detail: beach.region) }
                if results.isEmpty {
                    Text("No beach matches \"\(query)\"").font(.footnote).foregroundStyle(.secondary)
                }
            }
            .id("all")
        }
        .navigationTitle("Beaches")
        .searchable(text: $query, prompt: "Search")
    }

    private func debugActions(_ proxy: ScrollViewProxy) {
        #if DEBUG
        let d = UserDefaults.standard
        if d.bool(forKey: "debugNearest") { locator.locate() }
        if let id = d.string(forKey: "debugScroll") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { proxy.scrollTo(id, anchor: .top) }
        }
        #endif
    }

    // MARK: Sections

    @ViewBuilder private var nearestSection: some View {
        Section {
            switch locator.state {
            case .idle, .failed:
                Button { locator.locate() } label: { Label("Nearest beach", systemImage: "location.fill") }
                if locator.state == .failed {
                    Text("Couldn't find your location. Try again.").font(.footnote).foregroundStyle(.secondary)
                }
            case .locating:
                HStack { ProgressView(); Text("Finding you").font(.footnote) }
                    .accessibilityElement(children: .combine)
            case .denied:
                Text("Location is off for Beach Day. Turn it on in the Watch app on your iPhone.")
                    .font(.footnote).foregroundStyle(.secondary)
            case .found(let slug, let name, let miles):
                let distance = miles < 1 ? "under 1 mi" : "\(Int(miles.rounded())) mi"
                Button { choose(slug) } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Label("Nearest: \(name)", systemImage: "location.fill")
                        Text(distance + " away").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                .accessibilityLabel("Nearest beach: \(name), \(distance) away")
            }
        }
    }

    private func homeSection(_ home: String) -> some View {
        Section("Home") {
            row(slug: home, name: BeachCatalog.displayName(home), detail: nil, isHome: true)
        }
    }

    private func lastViewedSection(_ slug: String) -> some View {
        Section("Last viewed on iPhone") {
            row(slug: slug, name: BeachCatalog.displayName(slug), detail: nil)
        }
    }

    @ViewBuilder private var favoritesSection: some View {
        let favs = store.favorites.filter { $0 != store.home }
        if !favs.isEmpty {
            Section("Favorites") {
                ForEach(favs, id: \.self) { slug in
                    row(slug: slug, name: BeachCatalog.displayName(slug), detail: nil)
                }
            }
            .id("favorites")
        }
    }

    private func row(slug: String, name: String, detail: String?, isHome: Bool = false) -> some View {
        Button { choose(slug) } label: {
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text(name).lineLimit(2)
                    if let detail { Text(detail).font(.caption2).foregroundStyle(.secondary).lineLimit(1) }
                }
                Spacer(minLength: 0)
                if slug == store.activeSlug {
                    Image(systemName: "checkmark").foregroundStyle(.cyan).accessibilityHidden(true)
                }
            }
        }
        .accessibilityLabel(name + (isHome ? ", home" : "") + (slug == store.activeSlug ? ", selected" : ""))
    }

    private func choose(_ slug: String) {
        Task { await store.select(slug) }
        dismiss()
    }
}
