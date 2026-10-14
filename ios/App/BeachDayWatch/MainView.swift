//
//  MainView.swift
//
//  The main screen: big score, rating word and a few short lines.
//

import SwiftUI

struct MainView: View {
    @EnvironmentObject private var store: BeachStore
    @State private var showPicker = false
    @ScaledMetric(relativeTo: .largeTitle) private var scoreSize: CGFloat = 60

    var body: some View {
        content
            .navigationDestination(isPresented: $showPicker) { PickerView() }
            .containerBackground(backgroundColor.gradient.opacity(0.35), for: .navigation)
            .task {
                #if DEBUG
                if UserDefaults.standard.string(forKey: "debugScreen") == "picker" { showPicker = true }
                #endif
            }
            #if DEBUG
            .overlay { DebugHooks.overlay(store: store) }
            #endif
    }

    private var backgroundColor: Color {
        if let score = store.summary?.displayScore, store.summary?.slug == store.activeSlug {
            return ScoreBands.band(for: score).color
        }
        return .blue
    }

    @ViewBuilder private var content: some View {
        if store.activeSlug == nil {
            SetupView(showPicker: $showPicker)
        } else if let summary = store.summary, summary.slug == store.activeSlug {
            ScrollView {
                VStack(spacing: 6) {
                    header(name: summary.name)
                    scoreBlock(summary)
                    lines(summary)
                    footer(summary)
                }
                .padding(.horizontal, 4)
            }
            .refreshable { await store.refresh(force: true) }
        } else if case .failed(let error) = store.phase {
            ErrorView(message: error.message, name: store.activeName ?? "this beach") {
                Task { await store.refresh(force: true) }
            } change: { showPicker = true }
        } else {
            VStack(spacing: 8) {
                Text(store.activeName ?? "Beach Day").font(.headline).lineLimit(2).multilineTextAlignment(.center)
                ProgressView()
                Text("Loading conditions").font(.footnote).foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
        }
    }

    private func header(name: String) -> some View {
        Button { showPicker = true } label: {
            HStack(spacing: 4) {
                Text(name).font(.headline).lineLimit(1).minimumScaleFactor(0.7)
                Image(systemName: "chevron.down").font(.caption2.weight(.bold))
            }
            .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(name). Choose another beach")
    }

    @ViewBuilder private func scoreBlock(_ s: BeachSummary) -> some View {
        if let score = s.displayScore, let rating = s.rating {
            let band = ScoreBands.band(for: score)
            VStack(spacing: -4) {
                Text("\(score)")
                    .font(.system(size: scoreSize, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .minimumScaleFactor(0.5)
                    .foregroundStyle(band.color)
                Text(rating).font(.headline)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(s.scoreSpokenLabel)
        } else {
            VStack(spacing: 2) {
                Text("--")
                    .font(.system(size: scoreSize, weight: .bold, design: .rounded))
                    .foregroundStyle(.secondary)
                Text("Conditions unavailable").font(.footnote).foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(s.scoreSpokenLabel)
        }
    }

    @ViewBuilder private func lines(_ s: BeachSummary) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(Array(s.lines.enumerated()), id: \.offset) { _, line in
                InfoRow(symbol: symbol(for: line), text: line.text, tone: line.tone, kind: spokenKind(line.kind))
            }
            if s.limitedData {
                InfoRow(symbol: "exclamationmark.circle", text: "Limited data", tone: .calm, kind: "Data")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 4)
    }

    private func symbol(for line: SummaryLine) -> String {
        switch line.kind {
        case .hazard:
            let t = line.text.lowercased()
            if t.hasPrefix("lightning") { return "bolt.fill" }
            if t.contains("rain") || t.contains("thunderstorm") { return "cloud.rain.fill" }
            return "exclamationmark.triangle.fill"
        case .safety: return "flag.fill"
        case .water: return "thermometer.medium"
        case .best: return "clock"
        case .other: return "info.circle"
        }
    }

    private func spokenKind(_ kind: LineKind) -> String {
        switch kind {
        case .hazard: return "Alert"
        case .safety: return "Beach safety"
        case .water: return "Water temperature"
        case .best: return "Best time"
        case .other: return "Note"
        }
    }

    @ViewBuilder private func footer(_ s: BeachSummary) -> some View {
        VStack(spacing: 2) {
            if case .failed = store.phase {
                Text("Couldn't refresh. Showing data as of \(s.asOfText()).")
                    .font(.caption2).foregroundStyle(.orange)
                    .multilineTextAlignment(.center)
            } else if s.isStale() {
                Text("as of \(s.asOfText())")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if store.phase == .loading {
                ProgressView().controlSize(.small)
            } else {
                Button { Task { await store.refresh(force: true) } } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .font(.footnote)
            }
        }
        .padding(.top, 6)
    }
}

/// One short line with an icon. Color follows how serious it is.
struct InfoRow: View {
    let symbol: String
    let text: String
    let tone: Tone
    /// Spoken prefix for VoiceOver; the icon is decorative.
    let kind: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: symbol)
                .font(.footnote)
                .foregroundStyle(color)
                .frame(width: 18)
                .accessibilityHidden(true)
            Text(text)
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
                .lineLimit(3)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(kind): \(text)")
    }

    private var color: Color {
        switch tone {
        case .calm: return .secondary
        case .caution: return .orange
        case .danger: return .red
        }
    }
}

struct SetupView: View {
    @Binding var showPicker: Bool

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                Image(systemName: "beach.umbrella.fill")
                    .font(.largeTitle)
                    .foregroundStyle(.cyan)
                    .accessibilityHidden(true)
                Text("Choose your beach").font(.headline)
                Text("Or open a beach in Beach Day on your iPhone and it shows up here.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button("Choose a beach") { showPicker = true }
            }
        }
    }
}

struct ErrorView: View {
    let message: String
    let name: String
    let retry: () -> Void
    let change: () -> Void

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.title2).foregroundStyle(.orange)
                    .accessibilityHidden(true)
                Text("Can't load \(name)").font(.headline).multilineTextAlignment(.center)
                Text(message).font(.footnote).foregroundStyle(.secondary)
                Button("Try again", action: retry)
                Button("Choose another beach", action: change).font(.footnote)
            }
        }
    }
}
