import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ActivityLogEntry } from "../lib/types";
import { useProjectStore } from "../store/project-store";
import { SideSheet } from "./ui/Surfaces";

export function ActivityLogPanel() {
  const { showActivityLog, setShowActivityLog, loadActivity } = useProjectStore(
    useShallow((s) => ({
      showActivityLog: s.showActivityLog,
      setShowActivityLog: s.setShowActivityLog,
      loadActivity: s.loadActivity,
    })),
  );
  const [entries, setEntries] = useState<ActivityLogEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!showActivityLog) return;
    setLoading(true);
    loadActivity()
      .then(setEntries)
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [showActivityLog, loadActivity]);

  return (
    <SideSheet
      open={showActivityLog}
      onClose={() => setShowActivityLog(false)}
      title="Activity log"
      subtitle="Every save, import and reset in this project"
      width="max-w-sm"
    >
      <div className="scroll flex-1 p-4">
        {loading ? (
          <p className="hint">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="hint">Nothing recorded yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="rounded-[12px] p-2.5 text-[12px]"
                style={{ background: "var(--fill)" }}
              >
                <p className="font-medium">
                  {entry.coder_name} · {entry.action}
                </p>
                <p style={{ color: "var(--ink-3)" }}>
                  {new Date(entry.created_at).toLocaleString()}
                </p>
                {entry.detail && (
                  <p className="mt-1" style={{ color: "var(--ink-2)" }}>
                    {entry.detail}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </SideSheet>
  );
}
