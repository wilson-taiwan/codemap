import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contrast } from "./code-colors";
import { THEME_GROUND } from "../hooks/useTheme";

/**
 * The ink ramp, checked against the ground it is painted on.
 *
 * This exists because the accent was verified to four decimals and the ink
 * ramp — used an order of magnitude more often, carrying every hint, eyebrow,
 * timestamp and placeholder — never was, and shipped at 3.40:1 and 2.22:1 for
 * several releases. A comment claiming a ratio is not a ratio.
 *
 * ⚠️ This test reads the *declarations*. That is necessary but not sufficient:
 * it would have passed happily while the app painted every button black,
 * because that failure lived in the cascade, not in the values. lib/
 * contrast-audit.ts is the other half, and it runs against the real DOM.
 */

// ⚠️ node:fs, not `import "../index.css?raw"`. Vitest stubs CSS modules by
// default, and the stub applies to `?raw` too — the import resolves to an
// empty string and every assertion below passes against nothing. A test that
// cannot fail is worse than no test, which is the whole subject of this file.
const css = readFileSync(
  fileURLToPath(new URL("../index.css", import.meta.url)),
  "utf8",
);

/**
 * Read one brace-balanced block starting at the first `{` after `pattern`.
 *
 * ⚠️ Takes a regex, not a string. This used to match a literal containing a
 * newline, which passed on macOS and **failed on Windows every time**: git
 * checks out CRLF there, so `\n` was never found and the whole suite threw.
 * A contrast guard that cannot run on the platform the second coder uses is
 * not a guard. Match whitespace flexibly and it holds on both.
 */
function block(pattern: RegExp): string {
  const match = pattern.exec(css);
  if (!match) throw new Error(`no block matching ${pattern}`);
  const start = match.index;
  let i = css.indexOf("{", start);
  let depth = 0;
  const from = i;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(from + 1, i);
  }
  throw new Error(`unbalanced block for ${pattern}`);
}

function tokens(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of source.matchAll(
    /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi,
  )) {
    out[name] = value.trim();
  }
  return out;
}

function alpha(value: string): number {
  const match = value.match(/,\s*([0-9.]+)\s*\)$/);
  return Number(match?.[1] ?? 0);
}

const light = tokens(block(/:root\s*\{/));
const dark = tokens(block(/:root\[data-theme="dark"\]\s*\{/));
// The dark palette is declared twice; this is the copy that sits inside
// `@media (prefers-color-scheme: dark)` for `data-theme="system"`. Both the
// selector and the `color-scheme` line are matched so it cannot accidentally
// pick up the light `data-theme="system"` block above it.
const darkSystem = tokens(
  block(/:root\[data-theme="system"\]\s*\{\s*color-scheme:\s*dark;/),
);

// Small text: everything the ramp below tier 2 carries is 10.5–12px, so AA is
// 4.5:1 across the board. None of it qualifies as "large text".
const AA = 4.5;

describe.each([
  ["light", light, THEME_GROUND.light],
  ["dark", dark, THEME_GROUND.dark],
])("%s theme ink ramp", (_name, t, ground) => {
  it.each(["--ink", "--ink-2", "--ink-3", "--ink-4"])(
    "%s clears AA against the composited ground",
    (token) => {
      expect(contrast(t[token], ground)).toBeGreaterThanOrEqual(AA);
    },
  );

  it("keeps the ramp ordered — each tier dimmer than the last", () => {
    const ratios = ["--ink", "--ink-2", "--ink-3", "--ink-4"].map((k) =>
      contrast(t[k], ground),
    );
    for (let i = 1; i < ratios.length; i++) {
      expect(ratios[i]).toBeLessThan(ratios[i - 1]);
    }
  });

  it("renders readable text on the primary button", () => {
    expect(contrast(t["--accent-ink"], t["--accent"])).toBeGreaterThanOrEqual(AA);
  });

  it("renders the accent as readable text on the ground", () => {
    expect(contrast(t["--accent"], ground)).toBeGreaterThanOrEqual(AA);
  });

  it("declares find match tokens", () => {
    expect(t["--find-ring"]).toBeTruthy();
    expect(t["--find-on"]).toBeTruthy();
  });
});

/**
 * The dark palette is declared twice — once for an explicit `data-theme="dark"`
 * and once under `prefers-color-scheme: dark` for `data-theme="system"` —
 * because a media query cannot be nested in the selector this webview targets.
 * Two copies is two places to forget.
 */
it("keeps both dark blocks byte-identical", () => {
  expect(darkSystem).toEqual(dark);
});

describe("light chrome", () => {
  it("keeps the paper reading page while giving chrome a visible rim", () => {
    expect(light["--reading-bg"]).toBe("#ffffff");
    expect(alpha(light["--g-rim"])).toBeGreaterThanOrEqual(0.14);
    expect(alpha(light["--g-hairline"])).toBeGreaterThanOrEqual(0.12);
    expect(light["--g1"]).not.toBe("#ffffff");
    expect(alpha(light["--fill"])).toBeGreaterThanOrEqual(0.05);
    expect(alpha(light["--fill-hi"])).toBeGreaterThanOrEqual(0.08);
  });
});

/**
 * The wash is opaque unless the platform is known to composite it over
 * something. This is the Windows dark-mode bug as an assertion: a translucent
 * wash there composited over the webview's default white and resolved the
 * "dark" ground to roughly rgb(87, 87, 86), which took --ink-3 to 2.00:1.
 */
describe("ambient wash", () => {
  it("defaults to opaque", () => {
    expect(light["--amb-alpha"]).toBe("1");
  });

  it("gives the reading page opaque paper in light mode", () => {
    expect(light["--reading-bg"]).toBe("#ffffff");
  });

  it("keeps light mode opaque even on a vibrant macOS window", () => {
    // A light reader must not inherit a dark desktop through the window. The
    // platform gate still exists for dark mode, where translucency is a
    // deliberate effect rather than a surprise grey page.
    expect(light["--amb-alpha-vibrant"]).toBe("1");
  });

  it("only lets macOS opt into translucency", () => {
    const gate = block(/:root\[data-platform="macos"\]\s*\{/);
    expect(tokens(gate)["--amb-alpha"]).toBe("var(--amb-alpha-vibrant)");
    // and nothing else may set it — one gate, one direction
    const setters = [...css.matchAll(/--amb-alpha\s*:/g)].length;
    expect(setters).toBe(2);
  });

  it("declares a vibrant value for both themes", () => {
    expect(light["--amb-alpha-vibrant"]).toBeTruthy();
    expect(dark["--amb-alpha-vibrant"]).toBeTruthy();
  });
});
