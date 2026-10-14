import { describe, expect, it } from "vitest";
import { safeTapTarget } from "@/lib/push/tapTarget";

const ORIGINS = ["https://app.isitbeachday.com", "http://localhost:3000"];

describe("safeTapTarget", () => {
  it("opens the owner review on the alert, from the absolute address the owner push carries", () => {
    expect(safeTapTarget("https://app.isitbeachday.com/admin/review?alert=12", ORIGINS)).toBe("/admin/review?alert=12");
    expect(safeTapTarget("/admin/review?alert=12", ORIGINS)).toBe("/admin/review?alert=12");
    expect(safeTapTarget("http://localhost:3000/admin/review?alert=5", ORIGINS)).toBe("/admin/review?alert=5");
  });

  it("drops anything but a plain alert number from the review link", () => {
    expect(safeTapTarget("/admin/review?alert=12&x=//evil.example", ORIGINS)).toBe("/admin/review?alert=12");
    for (const bad of ["abc", "0", "-1", "1.5", "12345678901", "1e3", ""]) {
      expect(safeTapTarget(`/admin/review?alert=${bad}`, ORIGINS), bad).toBe("/admin/review");
    }
    expect(safeTapTarget("/admin/review", ORIGINS)).toBe("/admin/review");
    expect(safeTapTarget("/admin/report", ORIGINS)).toBe("/admin/report");
  });

  it("keeps the beach pages every other alert opens", () => {
    expect(safeTapTarget("/boca-raton", ORIGINS)).toBe("/boca-raton");
    expect(safeTapTarget("https://app.isitbeachday.com/deerfield-beach", ORIGINS)).toBe("/deerfield-beach");
    expect(safeTapTarget("/boca-raton?utm=x#top", ORIGINS)).toBe("/boca-raton");
  });

  it("refuses another host, another scheme, and a protocol-relative address", () => {
    for (const bad of [
      "https://evil.example/admin/review?alert=1",
      "https://app.isitbeachday.com.evil.example/admin/review",
      "http://app.isitbeachday.com/admin/review", // wrong scheme for the production origin
      "//evil.example/boca-raton",
      "///evil.example",
      "javascript:alert(1)",
      "data:text/html,hi",
      "https://user:pw@app.isitbeachday.com/boca-raton",
      "\\\\evil.example",
      "/\\evil.example",
    ]) {
      expect(safeTapTarget(bad, ORIGINS), bad).toBeNull();
    }
  });

  it("refuses other paths: other admin pages, deep paths, dots, and api routes", () => {
    for (const bad of ["/admin", "/admin/", "/admin/other", "/admin/review/x", "/api/quality/owner/list", "/a/b", "/../admin/review", "/.hidden", "/boca raton", "/Boca-Raton"]) {
      expect(safeTapTarget(bad, ORIGINS), bad).toBeNull();
    }
  });

  it("refuses what is not a string", () => {
    for (const bad of [undefined, null, 5, {}, ["/boca-raton"], "", "x".repeat(400)]) expect(safeTapTarget(bad, ORIGINS)).toBeNull();
  });
});
