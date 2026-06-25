import { describe, it, expect } from "vitest";
import { IterminalWorkspace } from "../src/transport/iterm.js";

describe("parseInputClear", () => {
  const workspace = Object.create(IterminalWorkspace.prototype) as IterminalWorkspace;

  it("returns true for empty prompt line", () => {
    const content = [
      "some output",
      "❯  ",
      "──────────────",
      "  Opus 4.6 (1M context)",
      " ",
      "",
    ].join("\n");
    expect(workspace.parseInputClear(content)).toBe(true);
  });

  it("returns false when user has typed text", () => {
    const content = [
      "some output",
      "❯ hello world",
      "──────────────",
      "  Opus 4.6 (1M context)",
      " ",
      "",
    ].join("\n");
    expect(workspace.parseInputClear(content)).toBe(false);
  });

  it("returns false when injected message sits on prompt line", () => {
    const content = [
      "some output",
      "❯ [Broadcast from ians-cc-assistant]                                    ",
      "──────────────",
      " ",
      "",
    ].join("\n");
    expect(workspace.parseInputClear(content)).toBe(false);
  });

  it("returns true when no ❯ found (non-Claude-Code pane)", () => {
    const content = [
      "$ some shell",
      "output here",
      "",
    ].join("\n");
    expect(workspace.parseInputClear(content)).toBe(true);
  });

  it("handles prompt with only whitespace after ❯", () => {
    const content = [
      "❯   ",
      "──────────────",
      "",
    ].join("\n");
    expect(workspace.parseInputClear(content)).toBe(true);
  });

  it("handles bare ❯ with no trailing space", () => {
    const content = [
      "❯",
      "──────────────",
      "",
    ].join("\n");
    expect(workspace.parseInputClear(content)).toBe(true);
  });

  it("uses the LAST ❯ line when multiple exist", () => {
    const content = [
      "❯ old input that was submitted",
      "some claude output",
      "❯  ",
      "──────────────",
      "",
    ].join("\n");
    expect(workspace.parseInputClear(content)).toBe(true);
  });

  it("detects typing even when last ❯ has text and earlier one is empty", () => {
    const content = [
      "❯  ",
      "some claude output",
      "❯ new typing here",
      "──────────────",
      "",
    ].join("\n");
    expect(workspace.parseInputClear(content)).toBe(false);
  });
});
