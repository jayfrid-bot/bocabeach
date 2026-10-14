# App Store Connect privacy answers for Is It Beach Day (1.3, with the watch app)

These answers must match `ios/App/App/PrivacyInfo.xcprivacy`. Source of truth for what
the app collects: `app/privacy/page.tsx` (effective October 12, 2026) and the code it
describes. Reconcile App Privacy in App Store Connect to this list.

**Tracking: No.** No data is combined with other companies' data for ads or sold to
brokers; there are no ads and no ad SDKs. `NSPrivacyTracking` is false and there are no
tracking domains.

**Data collected** (each: collected, linked to the user or device, used to track = No):

| ASC data type | Manifest key | Linked to the user/device | Purposes | Where it comes from |
| --- | --- | --- | --- | --- |
| Precise Location | `PreciseLocation` | Yes (stored with the device id) | App Functionality | Beach Mode only (Plus, opt in): `POST /api/presence` and `/api/hazards`. Latitude, longitude, accuracy, fix time; kept at most 8 hours; removed when Beach Mode is turned off. |
| Coarse Location | `CoarseLocation` | No | Analytics | PostHog derives a rough location from the network address (`PostHogInit.tsx`; the policy says "rough location from your network address"). |
| Device ID | `DeviceID` | Yes | App Functionality, Analytics | The random device id (`lib/deviceId.ts`) that ties score profile, alert settings and Plus status to the device; the APNs push token (`/api/devices`, Live Activity tokens); and the scrambled form of the id in the once-a-day app-open count (`/api/open`, Analytics, not linkable to settings). |
| Product Interaction | `ProductInteraction` | No | Analytics | PostHog: pages opened, time on page, taps (autocapture), no session recording; plus the daily app-open count. |
| Purchase History | `PurchaseHistory` | Yes | App Functionality | RevenueCat receives purchase and subscription status for Beach Day Plus (`/api/revenuecat`). |
| Other Data Types | `OtherDataTypes` | Yes | App Functionality | Score profile, alert settings, home beach and time zone saved with the device record (`/api/devices`). |

**Not collected:** name, email, phone, address, contacts, photos, health, financial info,
browsing history, search history, user content, diagnostics (crash data and performance
data), advertising data, sensitive info.

**Things to check when you reconcile**
- PostHog project settings (outside this repo): web vitals, network performance and
  exception autocapture should be OFF. If any is ON, add `PerformanceData` (and
  `CrashData` for exceptions) to the manifest and to this table.
- "Find my nearest beach" and the watch's "Nearest" use the location on the device only
  and send nothing to our servers, so they are not "collected".
- The Apple Watch app and its widget collect nothing: they send only a beach slug to
  `GET /api/watch/<slug>` (public conditions, no identifier). Their manifests declare no
  collected data. Their only required-reason API is UserDefaults in the shared App Group
  (`1C8F.1`).
- Capacitor ships its own privacy manifests (file timestamps and similar). RevenueCat,
  Geolocation and Push Notifications are SPM packages; Xcode merges their manifests into
  the privacy report for the archive, so check the report (Product, Archive, Generate
  Privacy Report) lists no data type that is missing here.
- Keep `app/privacy/page.tsx` in step with this table. It does not yet name the
  scrambled device id in the app-open count as a Device ID, or Purchase History in the
  RevenueCat paragraph in these words (it does describe both).
