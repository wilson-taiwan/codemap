import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  joinConnectReady,
  joinPasswordProblem,
  joinRailSteps,
  parseRecoveryPaste,
} from "../lib/join-flow";

describe("join-flow fuzz invariants", () => {
  it("connect step needs a trimmed name when signed in", () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        const ready = joinConnectReady({
          signedIn: true,
          hideServer: true,
          setupFilled: false,
          coderName: name,
        });
        expect(ready).toBe(name.trim().length > 0);
      }),
    );
  });

  it("password problems are symmetric for new and recover modes", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const p1 = joinPasswordProblem("new", a, b);
        const p2 = joinPasswordProblem("recover", a, b);
        expect(Boolean(p1)).toBe(Boolean(p2));
      }),
    );
  });

  it("recovery paste never returns both otp and hash", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const parsed = parseRecoveryPaste(raw);
        if (parsed.kind === "otp") {
          expect(parsed).not.toHaveProperty("tokenHash");
        }
        if (parsed.kind === "hash") {
          expect(parsed).not.toHaveProperty("token");
        }
      }),
    );
  });

  it("join rail always ends at transcripts when a key is present", () => {
    fc.assert(
      fc.property(fc.boolean(), (signedIn) => {
        const steps = joinRailSteps({ hasKey: true, signedIn });
        expect(steps[steps.length - 1]?.id).toBe("transcripts");
      }),
    );
  });
});
