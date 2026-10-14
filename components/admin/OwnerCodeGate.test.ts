import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OwnerCodeGate } from "@/components/admin/OwnerCodeGate";

const html = (initialError: string | null = null) => renderToStaticMarkup(createElement(OwnerCodeGate, { initialError, onEnrolled: () => {} }));

describe("OwnerCodeGate", () => {
  it("is one labelled password box and one Enroll button, and nothing else", () => {
    const m = html();
    expect(m).toContain("Owner code");
    expect(m).toContain('type="password"');
    expect(m).toContain("Enroll");
    expect(m).toContain('autoComplete="off"');
    expect((m.match(/<input/g) ?? []).length).toBe(1);
    expect((m.match(/<button/g) ?? []).length).toBe(1);
    expect(m).not.toMatch(/quality|review|report|alert|beach/i);
    expect(m).not.toContain("role=\"alert\""); // no message until a try fails
  });

  it("shows a refusal as one plain sentence, from a failed #enroll= link too", () => {
    expect(html("bad-code")).toContain("That did not work.");
    expect(html("too-many-attempts")).toContain("Too many tries");
    expect(html("bad-code")).not.toContain("bad-code");
  });
});
