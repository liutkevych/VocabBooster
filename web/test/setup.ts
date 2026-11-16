import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, expect, vi } from "vitest";
import { cleanup } from "@testing-library/react";

expect.extend(matchers);
afterEach(() => cleanup());

// jsdom has no Web Speech API: record what would be spoken.
export const spoken: string[] = [];
class FakeUtterance {
  lang = "";
  rate = 1;
  voice: unknown = null;
  constructor(public text: string) {}
}
Object.assign(globalThis, { SpeechSynthesisUtterance: FakeUtterance });
Object.defineProperty(window, "speechSynthesis", {
  configurable: true,
  value: {
    speak: vi.fn((u: FakeUtterance) => spoken.push(u.text)),
    cancel: vi.fn(),
    getVoices: () => [],
  },
});
