//
//  BeachSessionDemo.swift
//  App
//
//  DEBUG-only, Phase-1 simulator demo for the Beach Session Live Activity.
//  Launch with `--demo-live-activity` (see AppDelegate.swift) to start a
//  fixture activity, update it with a lightning hero after ~20s (score
//  capped low, the common beach-anchored case), a SECOND lightning update
//  after ~40s (score stays high, the device/beach-mismatch case — see that
//  block's comment), mark it unavailable at ~60s, and end it at ~90s total.
//  This proves the UI end-to-end in the simulator with NO Capacitor plugin,
//  NO server, and NO push tokens — those are Phase 2/3.
//
//  Everything here is guarded so a device/OS that can't run Live Activities
//  never crashes; it only prints why it didn't start.
//

#if DEBUG
import ActivityKit
import Foundation

enum BeachSessionDemo {

    static func run() {
        guard #available(iOS 16.2, *) else {
            print("[BeachSessionDemo] skipped: iOS < 16.2")
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            print("[BeachSessionDemo] skipped: Live Activities not enabled for this app/device")
            return
        }

        // A prior demo run (or a host kill that orphaned one) leaves its
        // activity behind; ActivityKit doesn't cap us to one, so relaunching
        // would otherwise stack duplicates. End every existing one first so
        // only this run's activity is ever active.
        Task {
            for existing in Activity<BeachSessionAttributes>.activities {
                await existing.end(existing.content, dismissalPolicy: .immediate)
                print("[BeachSessionDemo] ended stale activityId=\(existing.id) before starting a new demo")
            }
            startDemo()
        }
    }

    @available(iOS 16.2, *)
    private static func startDemo() {
        let sessionStart = Date()
        let attributes = BeachSessionAttributes(
            beachName: "South Beach",
            slug: "south-beach-demo",
            sessionStart: sessionStart
        )

        let sunsetAt = sessionStart.addingTimeInterval(3 * 3600 + 12 * 60)
        let tideAt = sessionStart.addingTimeInterval(2 * 3600 + 14 * 60)

        let initialState = BeachSessionAttributes.ContentState(
            v: 1,
            seq: 0,
            score: 84,
            windMph: 9,
            gustMph: 14,
            windDeg: 68, // ENE
            waveFt: 1.3,
            clarity: "clear",
            seaweed: "low",
            nextTideAt: tideAt,
            nextTideKind: "low",
            sunsetAt: sunsetAt,
            lightning: nil,
            updatedAt: sessionStart,
            unavailable: false
        )

        let content = ActivityContent(state: initialState, staleDate: sessionStart.addingTimeInterval(20 * 60))

        let activity: Activity<BeachSessionAttributes>
        do {
            activity = try Activity.request(
                attributes: attributes,
                content: content,
                pushType: nil // Phase 1: no push, local demo only.
            )
            print("[BeachSessionDemo] started activityId=\(activity.id) score=84 wind=9mph ENE gust=14 wave=1.3ft tide=low@+2h14m sunset=+3h12m")
        } catch {
            print("[BeachSessionDemo] start FAILED: \(error)")
            return
        }

        // T+20s: lightning breaks through and becomes the hero — the COMMON
        // case, where the lightning read is beach-anchored (matches what
        // score.ts itself scored against). Score drops to match what
        // lib/score.ts actually does when GOES GLM observes a strike within
        // 5 mi at the beach — it bottoms the score at 10 (see score.ts's
        // lightningWithin5mi cap). The old fixture kept score at 84 here,
        // which exposed a rendering bug where the score digit went red
        // purely from the lightning flag while the (contradictory)
        // green-band verdict text stayed "Yes — good beach day" — see
        // BeachSessionActivityLiveActivity.swift's scoreAccent doc comment.
        // NOTE: this beach-anchored case is common but NOT universal — see
        // the T+40s block below for the device/beach-mismatch case, where a
        // real lightning-active state does NOT imply a low score.
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
            let now = Date()
            let lightningState = BeachSessionAttributes.ContentState(
                v: 1,
                seq: 1,
                score: 8,
                windMph: 9,
                gustMph: 14,
                windDeg: 68,
                waveFt: 1.3,
                clarity: "clear",
                seaweed: "low",
                nextTideAt: tideAt,
                nextTideKind: "low",
                sunsetAt: sunsetAt,
                lightning: .init(
                    active: true,
                    latched: true,
                    miles: 4.8,
                    bearingDeg: 225, // SW
                    observedAt: now.addingTimeInterval(-2 * 60),
                    holdUntil: now.addingTimeInterval(30 * 60)
                ),
                updatedAt: now,
                unavailable: false
            )
            let content = ActivityContent(state: lightningState, staleDate: now.addingTimeInterval(20 * 60))
            Task {
                await activity.update(content)
                print("[BeachSessionDemo] updated seq=1: score=8 lightning active 4.8mi bearing=225deg holdUntil=+30m")
            }
        }

        // T+40s: a SEPARATE, more subtle case — lightning active from a
        // DEVICE-anchored point read (lib/liveActivity/state.ts's
        // `lightningPoint` branch: the CURRENT `/api/hazards` read for
        // wherever the phone actually is) while the score stays high,
        // because score.ts's own cap only ever keys off the BEACH-anchored
        // reading (`snap.lightning`), not the device's. A beach's forecast
        // can be sunny while a storm cell sits over the user's current
        // location a few miles inland — real, not contrived. This is the
        // scenario the rendering fix actually has to get right: the score
        // digit must stay green/84 (score-band color, never lightning-flag
        // color) and the header must read "Beach score 84", never a verdict
        // word — see scoreAccent's and headerVerdictText's doc comments in
        // BeachSessionActivityLiveActivity.swift.
        DispatchQueue.main.asyncAfter(deadline: .now() + 40) {
            let now = Date()
            let mismatchState = BeachSessionAttributes.ContentState(
                v: 1,
                seq: 2,
                score: 84,
                windMph: 9,
                gustMph: 14,
                windDeg: 68,
                waveFt: 1.3,
                clarity: "clear",
                seaweed: "low",
                nextTideAt: tideAt,
                nextTideKind: "low",
                sunsetAt: sunsetAt,
                lightning: .init(
                    active: true,
                    latched: true,
                    miles: 4.8,
                    bearingDeg: 225, // SW
                    observedAt: now.addingTimeInterval(-2 * 60),
                    holdUntil: now.addingTimeInterval(30 * 60)
                ),
                updatedAt: now,
                unavailable: false
            )
            let content = ActivityContent(state: mismatchState, staleDate: now.addingTimeInterval(20 * 60))
            Task {
                await activity.update(content)
                print("[BeachSessionDemo] updated seq=2: score=84 (device/beach lightning mismatch) lightning active 4.8mi bearing=225deg holdUntil=+30m")
            }
        }

        // T+60s: conditions unavailable.
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
            let now = Date()
            let unavailableState = BeachSessionAttributes.ContentState(
                v: 1,
                seq: 3,
                score: 84,
                windMph: 9,
                gustMph: 14,
                windDeg: 68,
                waveFt: 1.3,
                clarity: "clear",
                seaweed: "low",
                nextTideAt: tideAt,
                nextTideKind: "low",
                sunsetAt: sunsetAt,
                lightning: nil,
                updatedAt: now,
                unavailable: true
            )
            // Do not advance freshness on stale/unavailable data (plan rule).
            let content = ActivityContent(state: unavailableState, staleDate: now)
            Task {
                await activity.update(content)
                print("[BeachSessionDemo] updated seq=3: unavailable=true (conditions unavailable)")
            }
        }

        // T+90s: mark the session ended (surfaces show "Session ended" for
        // ~10s before the activity is dismissed) so the ended layout is
        // visible in the OS log / on screen, not just a final teardown.
        DispatchQueue.main.asyncAfter(deadline: .now() + 90) {
            let now = Date()
            let endedState = BeachSessionAttributes.ContentState(
                v: 1,
                seq: 4,
                score: 84,
                windMph: 9,
                gustMph: 14,
                windDeg: 68,
                waveFt: 1.3,
                clarity: "clear",
                seaweed: "low",
                nextTideAt: tideAt,
                nextTideKind: "low",
                sunsetAt: sunsetAt,
                lightning: nil,
                updatedAt: now,
                unavailable: false,
                ended: true
            )
            let content = ActivityContent(state: endedState, staleDate: now)
            Task {
                await activity.update(content)
                print("[BeachSessionDemo] updated seq=4: ended=true (session ended)")
            }
        }

        // T+100s (90s + 10s of the ended layout): dismiss the activity.
        DispatchQueue.main.asyncAfter(deadline: .now() + 100) {
            let now = Date()
            let finalState = BeachSessionAttributes.ContentState(
                v: 1,
                seq: 5,
                score: 84,
                windMph: 9,
                gustMph: 14,
                windDeg: 68,
                waveFt: 1.3,
                clarity: "clear",
                seaweed: "low",
                nextTideAt: tideAt,
                nextTideKind: "low",
                sunsetAt: sunsetAt,
                lightning: nil,
                updatedAt: now,
                unavailable: false,
                ended: true
            )
            let content = ActivityContent(state: finalState, staleDate: now)
            Task {
                await activity.end(content, dismissalPolicy: .immediate)
                print("[BeachSessionDemo] ended activityId=\(activity.id)")
            }
        }
    }
}
#endif
