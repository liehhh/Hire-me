import { beforeEach, describe, expect, it } from "vitest";
import {
  UNSAFE_FOR_MS,
  beginKokoroAttempt,
  endKokoroAttempt,
  isKokoroUnsafe,
  resetKokoroGuard,
  resetKokoroGuardForTests,
} from "./kokoroGuard";

// A "page load" is simulated by resetting the module's per-load state while
// keeping localStorage, which is what survives a reload.
const reloadPage = () => {
  const saved = localStorage.getItem("kokoro-guard");
  resetKokoroGuardForTests();
  if (saved) localStorage.setItem("kokoro-guard", saved);
};

describe("kokoroGuard", () => {
  beforeEach(() => {
    resetKokoroGuardForTests();
  });

  it("is safe by default", () => {
    expect(isKokoroUnsafe()).toBe(false);
  });

  it("flags the device when a page died mid-attempt (no endKokoroAttempt)", () => {
    beginKokoroAttempt();
    reloadPage(); // killed: no pagehide, so the attempt is still recorded
    expect(isKokoroUnsafe()).toBe(true);
  });

  it("does not flag the device when the attempt ended (first audio, error, or pagehide)", () => {
    beginKokoroAttempt();
    endKokoroAttempt();
    reloadPage();
    expect(isKokoroUnsafe()).toBe(false);
  });

  it("clears pagehide's attempt, so closing the tab mid-load is not a crash", () => {
    beginKokoroAttempt();
    window.dispatchEvent(new Event("pagehide"));
    reloadPage();
    expect(isKokoroUnsafe()).toBe(false);
  });

  it("expires the verdict after 24 hours", () => {
    beginKokoroAttempt();
    reloadPage();
    const now = Date.now();
    expect(isKokoroUnsafe(now)).toBe(true);
    expect(isKokoroUnsafe(now + UNSAFE_FOR_MS + 1)).toBe(false);
  });

  it("can be reset manually", () => {
    beginKokoroAttempt();
    reloadPage();
    expect(isKokoroUnsafe()).toBe(true);
    resetKokoroGuard();
    expect(isKokoroUnsafe()).toBe(false);
  });

  it("evaluates a leftover attempt before a new attempt overwrites it", () => {
    beginKokoroAttempt();
    reloadPage();
    beginKokoroAttempt(); // e.g. the diagnostics page starting its own load
    expect(isKokoroUnsafe()).toBe(true);
  });
});
