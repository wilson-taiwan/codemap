/**
 * Code swatch palette.
 *
 * These are **data colours, not theme colours.** The app's chrome is grey and
 * gold; codes are a categorical scale and their whole job is to be told apart,
 * so collapsing them into shades of the accent would make the codebook
 * unreadable to buy a little visual consistency. What the retheme changes is
 * the lead — gold first, and the vivid blue/violet pair that used to open the
 * scale is gone.
 *
 * 🔑 Every value clears **4.5:1 against the white chip text**, verified rather
 * than eyeballed; the previous palette's comment claimed this without it being
 * true of its lighter entries. Anything brighter fails: a legible gold behind
 * white text has to be this dark, which is why the bright gold in the theme
 * appears only in dark mode where it sits on a dark ground.
 *
 * Hues are spread wide enough to stay separable at chip size, and the order is
 * the order codes are created in, so the first few codes in a codebook are the
 * most distinct from each other.
 */
export const CODE_PALETTE = [
  "#8a6410", // gold — the theme's own hue leads the scale
  "#1f7a5e", // teal green
  "#b03a34", // red
  "#3d6f96", // slate blue
  "#a35a22", // burnt orange
  "#7a5aa0", // muted plum
  "#5f6f28", // olive
  "#8d3f6a", // magenta plum
  "#2e6b7d", // deep cyan
  "#844820", // rust
  "#4c6491", // indigo
  "#2d7846", // forest green
  "#9c3b4d", // berry rose
  "#69528e", // royal violet
  "#736818", // dark ochre
  "#426b52", // sage pine
] as const;

/** Next colour for a codebook that already holds `count` codes. */
export function nextCodeColor(count: number): string {
  return CODE_PALETTE[count % CODE_PALETTE.length];
}

// ── Making a code colour usable against either theme ─────────────────────────
//
// The palette above is tuned for one job: a chip background behind white text.
// That forces every entry dark. Used the other way round — as *foreground*, or
// as a rule under highlighted text on a dark ground — those same values are
// nearly invisible, and in dark mode a dark code colour on a dark background is
// simply unreadable.
//
// So a code has one stored colour and two presentations, and which one applies
// depends on the theme rather than on the code.

function channels(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function toHex(rgb: [number, number, number]): string {
  return (
    "#" +
    rgb
      .map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0"))
      .join("")
  );
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function mix(from: string, to: string, amount: number): string {
  const a = channels(from);
  const b = channels(to);
  return toHex([
    a[0] + (b[0] - a[0]) * amount,
    a[1] + (b[1] - a[1]) * amount,
    a[2] + (b[2] - a[2]) * amount,
  ]);
}

/**
 * A version of `color` that stays legible as foreground against `background`.
 *
 * Blends toward the background's opposite in small steps until the pair clears
 * 4.5:1, rather than applying a fixed lightening — the palette spans a range of
 * luminances, so one fixed amount would over-correct some entries and leave
 * others unreadable. Returns the original when it already passes, which is the
 * usual case in light mode.
 */
export function readableOn(color: string, background: string): string {
  if (contrast(color, background) >= 4.5) return color;

  const target = luminance(background) > 0.5 ? "#000000" : "#ffffff";
  for (let amount = 0.1; amount <= 1; amount += 0.1) {
    const candidate = mix(color, target, amount);
    if (contrast(candidate, background) >= 4.5) return candidate;
  }
  return target;
}
