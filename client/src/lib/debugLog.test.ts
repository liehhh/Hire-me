import { describe, expect, it } from "vitest";
import { describePreviousSession } from "./debugLog";

const base = { sid: "abc123", href: "/", stage: "worker: warm-up start", alive: 1_000_000, visibility: "visible", clean: false };

describe("describePreviousSession", () => {
  it("returns null with no previous session", () => {
    expect(describePreviousSession(null)).toBeNull();
  });

  it("reports a normal exit when pagehide fired", () => {
    expect(describePreviousSession({ ...base, clean: true })).toMatch(/ended normally/);
  });

  it("reports a kill, with where it happened, when pagehide never fired", () => {
    const text = describePreviousSession(base, 1_020_000);
    expect(text).toMatch(/WITHOUT pagehide/);
    expect(text).toMatch(/FOREGROUND/);
    expect(text).toMatch(/20s ago at "worker: warm-up start"/);
    expect(text).toMatch(/not an app navigation/);
  });

  it("tells a background eviction apart from a foreground crash", () => {
    expect(describePreviousSession({ ...base, visibility: "hidden" })).toMatch(/BACKGROUND/);
  });
});
