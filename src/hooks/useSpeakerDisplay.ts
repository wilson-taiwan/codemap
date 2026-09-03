import { useCallback, useMemo } from "react";
import { useAppStore } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import {
  aliasForSpeaker,
  buildSpeakerAliases,
} from "../lib/speaker-alias";

/**
 * Speaker name for display under the active interview's redaction toggle.
 *
 * Returns a lookup: real name → what the UI, clipboard, and exports should
 * show. When redaction is off for this interview it is the identity function.
 * The underlying filter values and stored data always stay real names —
 * redaction is a view/export layer, never a rewrite.
 */
export function useSpeakerDisplay(): (name: string) => string {
  const segments = useProjectStore((s) => s.segments);
  const activeInterviewId = useProjectStore((s) => s.activeInterviewId);
  const redactionMap = useAppStore((s) => s.preferences.speaker_redaction);

  const aliases = useMemo(() => {
    if (!activeInterviewId || !(redactionMap?.[activeInterviewId] ?? false)) {
      return null;
    }
    const ordered = [...segments]
      .sort((a, b) => a.segment_index - b.segment_index)
      .map((seg) => seg.speaker);
    return buildSpeakerAliases(ordered);
  }, [segments, activeInterviewId, redactionMap]);

  return useCallback((name: string) => aliasForSpeaker(name, aliases), [aliases]);
}

/** Whether redaction is on for the active interview. */
export function useSpeakerRedactionOn(): boolean {
  const activeInterviewId = useProjectStore((s) => s.activeInterviewId);
  const redactionMap = useAppStore((s) => s.preferences.speaker_redaction);
  if (!activeInterviewId) return false;
  return redactionMap?.[activeInterviewId] ?? false;
}
