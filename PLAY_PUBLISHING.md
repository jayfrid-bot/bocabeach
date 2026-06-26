# Publishing to Google Play (one-command via fastlane)

`fastlane/` is wired so a release upload is a single command. The only missing
piece is a **Play service-account key** — a one-time setup you do in your own
Google account (jayfdu@gmail.com). After that, uploads are automatic.

## One-time setup — create the service account + key

1. **Open the API access page.** In the [Play Console](https://play.google.com/console)
   (on the **jayfdu@gmail.com** account), type **"API access"** in the top search
   bar (or: Settings → Developer account → API access).
2. **Link a Google Cloud project** if prompted (create a new one, or link the
   existing Firebase project `is-it-beach-day-4b85f`).
3. **Create the service account.** On the API access page → "Service accounts" →
   **Create new service account** → follow the link into Google Cloud Console →
   IAM & Admin → Service Accounts → **Create service account** (name it
   `play-publisher`). You do **not** need to grant it any Google Cloud roles — skip
   that step and click Done.
4. **Download the JSON key.** In Google Cloud Console → Service Accounts → click
   `play-publisher@…iam.gserviceaccount.com` → **Keys** → Add key → Create new key
   → **JSON** → Create. A `.json` file downloads. **This is the secret — treat it
   like the keystore.**
5. **Grant Play access.** Back in Play Console → API access (the account now shows
   up) → **Grant access** → give it at minimum **"Release to testing tracks"** +
   **"Manage testing track releases"** for "Is It Beach Day" (or Admin for
   simplicity), then Apply/Invite.
6. **Enable the API** if it isn't already: Google Cloud Console → APIs & Services →
   Library → **Google Play Android Developer API** → Enable.
7. **Drop the key in the repo** (it's git-ignored, won't be committed):

   ```
   mv ~/Downloads/play-publisher-*.json ~/Projects/bocabeach/fastlane/play-store-key.json
   ```

Confirm it authenticates (no upload happens):

```
cd ~/Projects/bocabeach
fastlane run validate_play_store_json_key json_key:fastlane/play-store-key.json
```

## Every release

1. **Bump** `versionCode` (and usually `versionName`) in
   `android/app/build.gradle` — Play rejects a duplicate versionCode.
2. **Build** the signed AAB:

   ```
   cd ~/Projects/bocabeach
   JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
   ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
     sh -c 'cd android && ./gradlew bundleRelease'
   ```

3. **Upload:**

   ```
   fastlane android internal   # → Internal testing track
   fastlane android closed     # → Closed testing (alpha) track
   ```

## Notes

- If fastlane warns about locale, prefix the commands with
  `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8` (it needs a UTF-8 locale).
- The app must already exist on Play with ≥1 prior build (it does — versionCode 1
  on Internal testing), so the API can add new versions.
- This is a **remote-URL shell** (loads `main--bocabeachrats.netlify.app`), so a new
  AAB ships **no behavior change** — web/server changes are already live on every
  install. Re-upload only to advance toward production or refresh the store version.
- **Going public** needs more than an upload: Google requires new personal accounts
  to run a **closed test (≥12 testers, ~14 days)** before production, plus completed
  **App content** (Data safety, content rating, privacy policy, target audience).
- Reference: fastlane supply setup — https://docs.fastlane.tools/getting-started/android/setup/
