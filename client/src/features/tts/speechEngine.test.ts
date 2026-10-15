import { describe, expect, it } from "vitest";
import { chooseSpeechEngine } from "./speechEngine";

const env = { override: null, mobile: false, kokoroUnsafe: false };

describe("chooseSpeechEngine", () => {
  it("uses on-device Kokoro on desktops", () => {
    expect(chooseSpeechEngine(env)).toBe("kokoro");
  });

  it("uses the cloud voice on phones", () => {
    expect(chooseSpeechEngine({ ...env, mobile: true })).toBe("cloud");
  });

  it("uses the cloud voice when Kokoro took the page down before on this device", () => {
    expect(chooseSpeechEngine({ ...env, kokoroUnsafe: true })).toBe("cloud");
  });

  it("lets ?voice= override either way", () => {
    expect(chooseSpeechEngine({ ...env, mobile: true, override: "kokoro" })).toBe("kokoro");
    expect(chooseSpeechEngine({ ...env, override: "cloud" })).toBe("cloud");
  });

  it("ignores unknown override values", () => {
    expect(chooseSpeechEngine({ ...env, mobile: true, override: "bogus" })).toBe("cloud");
  });
});
