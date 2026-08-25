import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyPlatformAttribute } from "./lib/platform";
import "./index.css";

// Before first paint: the traffic-light gutter is CSS-gated on this attribute,
// and setting it after render would show 78px of empty toolbar for a frame on
// every non-macOS launch.
applyPlatformAttribute();

// Browser-only design harness. Tree-shaken out of production builds, and a
// no-op the moment a real Tauri bridge is present.
if (import.meta.env.DEV) {
  const { installDevMock } = await import("./lib/dev-mock");
  installDevMock();
  const { useProjectStore } = await import("./store/project-store");
  (window as unknown as Record<string, unknown>).useProjectStore = useProjectStore;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Measures painted contrast, not declared tokens — the only thing that would
// have caught the unlayered reset that silently blacked out every control's
// colour. Prints a table for anything below AA; also exposed on `window` so it
// can be re-run by hand after switching theme, since a whole class of these
// only fails in one theme.
if (import.meta.env.DEV) {
  const { startContrastAudit, auditContrast } = await import(
    "./lib/contrast-audit"
  );
  (window as unknown as Record<string, unknown>).auditContrast = auditContrast;
  void startContrastAudit();
}
