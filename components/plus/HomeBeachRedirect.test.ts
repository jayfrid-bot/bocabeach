import { describe, it, expect } from "vitest";
import { homeRedirectTarget } from "@/components/plus/HomeBeachRedirect";

const SERVED = [{ slug: "boca-raton" }, { slug: "deerfield-beach" }, { slug: "delray-beach" }];
const FLAGSHIP = "boca-raton";

describe("homeRedirectTarget", () => {
  it("sends the front door to the saved home beach", () => {
    expect(homeRedirectTarget("/", "deerfield-beach", FLAGSHIP, SERVED)).toBe("/deerfield-beach");
  });

  it("stays put when the home beach IS the beach '/' already renders", () => {
    expect(homeRedirectTarget("/", FLAGSHIP, FLAGSHIP, SERVED)).toBeNull();
  });

  it("stays put with no home beach saved", () => {
    expect(homeRedirectTarget("/", null, FLAGSHIP, SERVED)).toBeNull();
  });

  it("never fires anywhere but the front door", () => {
    expect(homeRedirectTarget("/delray-beach", "deerfield-beach", FLAGSHIP, SERVED)).toBeNull();
    expect(homeRedirectTarget("/find", "deerfield-beach", FLAGSHIP, SERVED)).toBeNull();
  });

  it("ignores a home beach the app no longer serves", () => {
    // A retired or renamed slug used to send every launch to a 404 — and the
    // 404's way home is "/", which redirected straight back to it.
    expect(homeRedirectTarget("/", "boca-inlet-old", FLAGSHIP, SERVED)).toBeNull();
  });

  it("does nothing before the beach list has arrived", () => {
    expect(homeRedirectTarget("/", "deerfield-beach", FLAGSHIP, [])).toBeNull();
  });
});
