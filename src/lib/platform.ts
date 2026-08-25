/**
 * Platform detection for the parts of the UI that cannot be platform-neutral.
 *
 * Deliberately reads the user agent rather than `@tauri-apps/plugin-os`. The
 * plugin's `platform()` is async and needs its own capability grant, and the
 * two things this module feeds — a CSS attribute on <html> and the modifier
 * symbol in shortcut hints — are both needed synchronously during the first
 * render. A wrong answer for one frame is a visible layout jump.
 *
 * Tauri embeds WKWebView on macOS and WebView2 on Windows, so the UA strings
 * are the platform's own and reliable here in a way they are not on the open
 * web. Anything unrecognised is treated as not-macOS, which is the safer
 * default: the macOS branch reserves 78px for traffic lights that would not
 * be there.
 */

export type Platform = "macos" | "windows" | "other";

function detect(): Platform {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Mac OS X|Macintosh/.test(ua)) return "macos";
  if (/Windows/.test(ua)) return "windows";
  return "other";
}

export const platform: Platform = detect();
export const isMac = platform === "macos";
export const isWindows = platform === "windows";

/**
 * Stamp the platform onto <html> so CSS can branch without JS in the render
 * path. Call once at boot, before first paint.
 */
export function applyPlatformAttribute(): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.platform = platform;
  }
}

/** The primary shortcut modifier — Command on macOS, Control everywhere else. */
export const modKey = isMac ? "⌘" : "Ctrl";

/**
 * Render a shortcut hint for the current platform.
 *
 * Written as tokens rather than literal strings so a hint is defined once:
 * `shortcut("mod", "shift", "E")` is "⌘⇧E" on macOS and "Ctrl+Shift+E" on
 * Windows. macOS composes symbols with no separator by convention; Windows
 * spells the modifiers out and joins them with "+".
 */
export function shortcut(...tokens: string[]): string {
  const mac: Record<string, string> = { mod: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃" };
  const win: Record<string, string> = { mod: "Ctrl", shift: "Shift", alt: "Alt", ctrl: "Ctrl" };
  const table = isMac ? mac : win;
  const parts = tokens.map((t) => table[t] ?? t.toUpperCase());
  return isMac ? parts.join("") : parts.join("+");
}

/**
 * True when the event carries the platform's primary modifier.
 *
 * `metaKey` alone was the old test, which on Windows means the Windows key —
 * so every shortcut guarded by it was dead there.
 */
export function hasModKey(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey;
}

/** What the OS calls its file manager. Used in menu labels and button text. */
export const fileManagerName = isMac ? "Finder" : isWindows ? "File Explorer" : "Files";

/** What the OS calls its trash / recycle bin. */
export function trashName(): string {
  if (isMac) return "Trash";
  if (isWindows) return "Recycle Bin";
  return "the trash";
}

// Path basenames live in lib/format's `basename`, which was already
// separator-agnostic. Do not add a second one here.
