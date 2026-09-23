//
//  BeachSessionActivityBundle.swift
//  BeachSessionActivity
//
//  Widget Extension entry point. This extension carries ONLY the Beach
//  Session Live Activity in v1 — no home-screen widget.
//

import WidgetKit
import SwiftUI

@main
struct BeachSessionActivityBundle: WidgetBundle {
    var body: some Widget {
        if #available(iOS 16.2, *) {
            BeachSessionLiveActivity()
        }
    }
}
