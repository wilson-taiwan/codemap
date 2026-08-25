import { useEffect, useState } from "react";
import { basename } from "../lib/format";

export function OpeningOverlay({ path }: { path: string | null }) {
  const [mounted, setMounted] = useState(false);
  const [stageElapsed, setStageElapsed] = useState(0);

  // 150ms threshold: opens completing under 150ms show no overlay at all
  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), 150);
    return () => clearTimeout(timer);
  }, []);

  // Stage dwell timer for slow open warnings
  useEffect(() => {
    setStageElapsed(0);
    const interval = setInterval(() => {
      setStageElapsed((prev) => prev + 500);
    }, 500);
    return () => clearInterval(interval);
  }, []);

  if (!mounted) return null;

  const projectName = path ? basename(path) : "Project";

  return (
    <div
      role="status"
      aria-live="polite"
      className="anim-fade-in fixed inset-0 z-[100] flex flex-col bg-[var(--g1)] select-none"
      style={{ opacity: 1 }}
    >
      {/* 52px Toolbar Skeleton */}
      <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-[var(--g-rim)] px-4 bg-[var(--g2)]">
        <div className="flex items-center gap-3">
          <div className="h-6 w-6 rounded-md bg-[var(--fill-hi)] opacity-60 animate-pulse" />
          <div className="h-4 w-32 rounded bg-[var(--fill-hi)] opacity-60 animate-pulse" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-7 w-48 rounded-lg bg-[var(--fill)] opacity-60 animate-pulse" />
          <div className="h-7 w-7 rounded-lg bg-[var(--fill)] opacity-60 animate-pulse" />
        </div>
      </header>

      {/* Main Workspace Skeleton */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left Rail (Codebook) Skeleton */}
        <aside className="w-[248px] shrink-0 border-r border-[var(--g-rim)] p-3 flex flex-col gap-2.5 bg-[var(--g1)]">
          <div className="flex items-center justify-between pb-1">
            <div className="h-3 w-16 rounded bg-[var(--fill-hi)] opacity-70 animate-pulse" />
            <div className="h-5 w-5 rounded bg-[var(--fill)] opacity-50" />
          </div>
          {[40, 65, 50, 80, 55, 70].map((width, i) => (
            <div key={i} className="flex items-center gap-2 p-1.5 rounded-lg bg-[var(--fill)] opacity-50">
              <span className="h-2.5 w-2.5 rounded-full bg-[var(--fill-hi)] shrink-0" />
              <div className="h-3 rounded bg-[var(--fill-hi)]" style={{ width: `${width}%` }} />
            </div>
          ))}
        </aside>

        {/* Center Transcript Skeleton */}
        <main className="flex-1 flex flex-col min-h-0 overflow-hidden bg-[var(--reading-bg,#ffffff)]">
          {/* Header */}
          <div className="border-b border-[var(--g-rim)] px-8 py-4 bg-[var(--g1)]/70 flex flex-col gap-2">
            <div className="flex items-center justify-between text-[12.5px]">
              <span className="font-medium text-[var(--ink)] flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-[var(--accent)] animate-ping" />
                Opening project…
              </span>
              <span className="text-[var(--ink-4)] font-mono text-[11.5px] tabular-nums">
                {projectName}
              </span>
            </div>

            {/* Progress bar */}
            <div
              role="progressbar"
              aria-label="Loading project"
              className="h-[3px] w-full rounded-full overflow-hidden bg-[var(--fill)]"
            >
              <div className="h-full w-1/3 bg-[var(--accent)] animate-pulse" />
            </div>

            {/* Progressive reassurance messages on slow opens */}
            {stageElapsed >= 20000 ? (
              <p className="text-[11.5px] text-[var(--danger,#b03a34)] animate-pulse">
                Taking unusually long. Your data is safe; you can quit and reopen if you need to.
              </p>
            ) : stageElapsed >= 6000 ? (
              <p className="text-[11.5px] text-[var(--ink-3)]">
                Still working — larger projects or network drives can take a few seconds to load.
              </p>
            ) : null}
          </div>

          {/* 6 Shimmering Passages */}
          <div className="flex-1 p-8 space-y-6 overflow-hidden max-w-xl mx-auto w-full opacity-60">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="space-y-2.5 animate-pulse">
                <div className="flex items-center gap-2">
                  <div className="h-3 w-20 rounded bg-[var(--fill-hi)]" />
                  <div className="h-2.5 w-12 rounded bg-[var(--fill)]" />
                </div>
                <div className="space-y-1.5 pl-1">
                  <div className="h-3.5 w-full rounded bg-[var(--fill)]" />
                  <div
                    className="h-3.5 rounded bg-[var(--fill)]"
                    style={{ width: `${75 + (i % 3) * 10}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
