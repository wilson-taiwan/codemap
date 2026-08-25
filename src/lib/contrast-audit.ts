/**
 * Runtime contrast audit — the half a token test cannot do.
 *
 * 🔑 Written after a one-line unlayered reset (`button, input, select,
 * textarea { color: inherit }`) silently overrode the `color` on every
 * `.btn-*` and `.chip-*` in `@layer components`. Unlayered CSS beats every
 * layered rule regardless of specificity, so the primary button painted
 * `--ink` on `--accent` — 1.67:1 in dark mode — while every token involved was
 * correct and every component referenced the right one. Reading index.css
 * would have confirmed the design system as sound. Only `getComputedStyle` on
 * the running app found it.
 *
 * So this measures what is painted, not what is declared: it composites each
 * control's real background up the ancestor chain (the glass surfaces are
 * translucent, so the nearest background-color is rarely the ground) and
 * checks the pair against WCAG AA at the element's own font size.
 *
 * Dev only. It walks the DOM and is not cheap; it never ships.
 */

import { contrast } from "./code-colors";

type Rgba = [number, number, number, number];

function parse(color: string): Rgba | null {
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) return null;
  return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
}

/** `over` composited under `src`. */
function over(src: Rgba, dst: Rgba): Rgba {
  const a = src[3] + dst[3] * (1 - src[3]);
  if (a === 0) return [0, 0, 0, 0];
  const ch = (i: number) =>
    (src[i] * src[3] + dst[i] * dst[3] * (1 - src[3])) / a;
  return [ch(0), ch(1), ch(2), a];
}

function hex(c: Rgba): string {
  return (
    "#" +
    c
      .slice(0, 3)
      .map((v) => Math.round(v).toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * The colour actually behind `el`, composited through every translucent
 * ancestor. Returns premultiplied-out RGBA rather than a hex string — an
 * earlier version returned hex here and the caller fed it back through
 * `parse()`, which only matches `rgb()`/`rgba()`; a cast made that typecheck
 * and it threw on the first real element. Keep the colour in one
 * representation until the moment it is printed.
 *
 * Falls back to the ambient wash's base, the only thing in the app guaranteed
 * opaque once the platform gate has run.
 */
function effectiveBackground(el: Element): Rgba {
  let acc: Rgba = [0, 0, 0, 0];
  let node: Element | null = el;
  while (node) {
    const bg = parse(getComputedStyle(node).backgroundColor);
    if (bg && bg[3] > 0) {
      acc = over(acc, bg);
      if (acc[3] >= 0.999) return acc;
    }
    node = node.parentElement;
  }
  return over(acc, ambientGround());
}

/**
 * The ground under everything: the `.ambient` wash.
 *
 * ⚠️ `.ambient` is `position: fixed; z-index: -1` — it sits *behind* the
 * content, not above it in the tree, so walking `parentElement` never reaches
 * it and body is `background: transparent`. Without this the walk terminates
 * on the browser's default white and reports every dark-mode label as failing.
 *
 * Reconstructed from the tokens instead. The backdrop under the wash is the
 * wash's own base: on Windows `--amb-alpha` is 1 so that is exact, and on
 * macOS the "sidebar" vibrancy material is tuned to the theme, so it is the
 * right approximation. That equivalence is only true while the platform gate
 * holds — see the `--amb-alpha` assertions in contrast-tokens.test.ts.
 */
function ambientGround(): Rgba {
  const root = getComputedStyle(document.documentElement);
  const base = root
    .getPropertyValue("--amb-base")
    .split(",")
    .map((n) => Number(n.trim()));
  if (base.length !== 3 || base.some(Number.isNaN)) return [255, 255, 255, 1];
  const alpha = Number(root.getPropertyValue("--amb-alpha")) || 1;
  const opaqueBase: Rgba = [base[0], base[1], base[2], 1];
  return over([base[0], base[1], base[2], alpha], opaqueBase);
}

/** WCAG's large-text threshold: ≥24px, or ≥18.66px at 700+. */
function threshold(style: CSSStyleDeclaration): number {
  const size = parseFloat(style.fontSize);
  const weight = Number(style.fontWeight) || 400;
  const large = size >= 24 || (size >= 18.66 && weight >= 700);
  return large ? 3 : 4.5;
}

export interface ContrastFinding {
  selector: string;
  text: string;
  color: string;
  background: string;
  ratio: number;
  required: number;
  fontSize: string;
}

/** Everything that carries text the reader has to read. */
const AUDITED = [
  ".btn",
  ".chip",
  ".hint",
  ".eyebrow",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "p",
  "h1",
  "h2",
  "h3",
  "li",
  "td",
  "th",
].join(",");

export function auditContrast(root: ParentNode = document): ContrastFinding[] {
  const findings: ContrastFinding[] = [];

  for (const el of Array.from(root.querySelectorAll(AUDITED))) {
    const text = (el.textContent ?? "").trim();
    if (!text) continue;
    // Only leaf-ish text: a wrapper's textContent is its children's, and
    // reporting both makes every finding look like several.
    if (el.querySelector(AUDITED)) continue;

    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") continue;
    if (parseFloat(style.opacity) < 0.5) continue; // :disabled is 0.4 by design

    const fg = parse(style.color);
    if (!fg || fg[3] === 0) continue;

    const bg = effectiveBackground(el);
    // Text can itself be translucent, so composite the foreground over its own
    // background before measuring — `color: rgba(...)` at 0.6 is not the
    // colour the reader sees.
    const ratio = contrast(hex(over(fg, bg)), hex(bg));
    const required = threshold(style);

    if (ratio < required) {
      findings.push({
        selector:
          el.tagName.toLowerCase() +
          (el.className && typeof el.className === "string"
            ? "." + el.className.trim().split(/\s+/).join(".")
            : ""),
        text: text.slice(0, 48),
        color: style.color,
        background: hex(bg),
        ratio: Math.round(ratio * 100) / 100,
        required,
        fontSize: style.fontSize,
      });
    }
  }

  return findings.sort((a, b) => a.ratio - b.ratio);
}

/**
 * Wait for in-flight CSS transitions before measuring.
 *
 * ⚠️ Not optional. Measured 400ms into a theme switch this audit reported 20
 * failures that do not exist: `.btn` transitions `background` but not `color`,
 * so the button read the new ink on the old accent, and the token-derived
 * ground snapped to the new theme while transitioning text had not. Every one
 * of them cleared on its own a second later. A checker that cries wolf during
 * an animation is a checker people learn to ignore.
 *
 * Related trap when measuring by hand: in a throttled or hidden tab
 * transitions never advance, so transitioned properties (`.btn` background,
 * box-shadow) stay pinned at the old theme's values while untransitioned ones
 * (color) update instantly, and you read a control that is half light and half
 * dark. Switch the theme first, then build the probe element — a node created
 * after the switch has nothing to transition from.
 */
async function settle(timeoutMs = 2000): Promise<void> {
  const running = document
    .getAnimations()
    .map((a) => a.finished.catch(() => undefined));
  await Promise.race([
    Promise.all(running),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

/**
 * Audit once things have settled, and print anything failing. Wired into
 * main.tsx behind `import.meta.env.DEV`; `window.auditContrast()` is the
 * synchronous version for console use — call it after switching theme, since a
 * whole class of these only fails in one theme, and give the switch a moment.
 */
export async function startContrastAudit(): Promise<void> {
  await settle();
  const findings = auditContrast();
  if (findings.length === 0) {
    console.info("[contrast] no AA failures in the current view");
    return;
  }
  console.warn(
    `[contrast] ${findings.length} element(s) below WCAG AA — measured, not declared:`,
  );
  console.table(findings);
}
