import { describe, it, expect } from "vitest";
import { checkOrchestrationPolicy } from "../src/engine/orchestration-policy.js";

describe("checkOrchestrationPolicy", () => {
  describe("self-targeting (hardcoded)", () => {
    it("denies any verb when sender === target", () => {
      for (const verb of ["start", "stop", "continue", "setAutonomy", "send"] as const) {
        const r = checkOrchestrationPolicy("<name>", verb, "<name>", undefined);
        expect(r.allowed).toBe(false);
        expect(r.reason).toMatch(/cannot .* itself/);
      }
    });

    it("denies self-targeting even with empty (permissive) policy", () => {
      const r = checkOrchestrationPolicy("<name>", "stop", "<name>", {});
      expect(r.allowed).toBe(false);
    });
  });

  describe("no policy (full access)", () => {
    it("allows all verbs against any peer when orchestration is undefined", () => {
      for (const verb of ["start", "stop", "continue", "setAutonomy", "send"] as const) {
        const r = checkOrchestrationPolicy("<name>", verb, "<name>", undefined);
        expect(r.allowed).toBe(true);
      }
    });

    it("allows all verbs when orchestration is empty object", () => {
      const r = checkOrchestrationPolicy("<name>", "start", "<name>", {});
      expect(r.allowed).toBe(true);
    });
  });

  describe("blacklist semantics", () => {
    it("denies when target is in deny_start", () => {
      const r = checkOrchestrationPolicy("<name>", "start", "<name>", {
        denyStart: ["<name>"],
      });
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/policy denies <name> → start → <name>/);
    });

    it("allows start when target is not in deny_start", () => {
      const r = checkOrchestrationPolicy("<name>", "start", "wolf", {
        denyStart: ["<name>"],
      });
      expect(r.allowed).toBe(true);
    });

    it("deny lists are per-verb independent", () => {
      const policy = { denyStop: ["<name>"] };
      // stop denied
      expect(
        checkOrchestrationPolicy("<name>", "stop", "<name>", policy).allowed
      ).toBe(false);
      // start allowed (no denyStart list)
      expect(
        checkOrchestrationPolicy("<name>", "start", "<name>", policy).allowed
      ).toBe(true);
      // send allowed (no denySend list)
      expect(
        checkOrchestrationPolicy("<name>", "send", "<name>", policy).allowed
      ).toBe(true);
    });

    it("empty deny list = no restriction", () => {
      const r = checkOrchestrationPolicy("<name>", "start", "<name>", {
        denyStart: [],
      });
      expect(r.allowed).toBe(true);
    });
  });
});
