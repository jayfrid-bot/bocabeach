// Where "get the app" points. Pure constants — safe to import from anywhere.
//
// Conversion surfaces on the web link to GET_APP_PATH, not straight to Apple,
// so the tap is counted and can be matched to the install that follows it (see
// lib/db/scanFunnel.ts). That means the three places a web visitor is asked to
// GET the app: the AppStoreBand, the dashboard footer, and PlusInAppCard (the
// Plus pitch shown only off-app). Places that send someone who ALREADY has the
// app to their own store page — the support page, the in-app paywall — keep
// linking to APP_STORE_URL directly.

export const APP_STORE_URL = "https://apps.apple.com/us/app/id6779072992";

/** Counts the tap, then redirects to APP_STORE_URL. See app/get-app/route.ts. */
export const GET_APP_PATH = "/get-app";
