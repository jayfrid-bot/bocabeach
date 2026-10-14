// The capability header every current app build sends to the install-token
// routes. The server only logs it (lib/db/installTokenAuth.ts
// `noteMissingToken`), so the "request had no install token" count can tell an
// older WebView (no header) from a current one whose storage refused a token.
export const CLIENT_CAP_HEADER = "x-client-cap";
export const CLIENT_CAP_VALUE = "install-token-v1";
export const clientCapHeaders = (): Record<string, string> => ({ [CLIENT_CAP_HEADER]: CLIENT_CAP_VALUE });
