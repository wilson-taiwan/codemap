import { useEffect, useState } from "react";
import { useAppStore } from "../store/app-store";

/**
 * Whether the app is currently rendering dark.
 *
 * 🔑 This asks the *resolved* theme, not the operating system. The two are only
 * the same under `data-theme="system"` — the app defaults to light, so on a
 * Mac set to dark the OS query says "dark" while the app is painting light.
 * Anything computing a colour in JavaScript that trusted the OS query would
 * then correct for a dark background that is not there, and produce washed-out
 * highlights on a light page.
 *
 * The OS listener is still needed, because under "system" the answer changes
 * without any click — macOS switches appearance on a schedule.
 */
export function usePrefersDark(): boolean {
  const theme = useAppStore((s) => s.preferences.theme);
  const [osDark, setOsDark] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches === true,
  );

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const onChange = (e: MediaQueryListEvent) => setOsDark(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  if (theme === "dark") return true;
  if (theme === "system") return osDark;
  // "light", null, or anything unrecognised.
  return false;
}

/**
 * The page background each theme actually composites, for contrast decisions.
 *
 * 🔑 These are the surfaces text actually sits on. Highlights live on
 * `.reading-page` (`--reading-bg`), not on the ambient wash — feeding
 * `readableOn()` the wash made it correct about a colour the reader never
 * sees. Light is opaque paper (`#ffffff`). Dark is the composited raised
 * panel over `--amb-base`.
 *
 * Re-measure these if `--reading-bg`, `--amb-base`, `--amb-alpha` or any
 * `--amb-N` changes: `getComputedStyle` on a control, not the declarations.
 * See lib/contrast-audit.ts.
 */
export const THEME_GROUND = { light: "#ffffff", dark: "#0f0f0e" } as const;
