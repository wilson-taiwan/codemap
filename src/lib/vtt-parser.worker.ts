/// <reference lib="webworker" />
import { cuesToSegments } from "./vtt-parser";
import { parseTranscript } from "./transcript-parser";

interface ParseRequest {
  id: number;
  raw: string;
  merge: boolean;
  filename?: string;
}

self.onmessage = (e: MessageEvent<ParseRequest>) => {
  const { id, raw, merge, filename } = e.data;
  try {
    // Off the main thread because a long interview is a lot of string work and
    // the format sniffing now runs over it too.
    const { cues, format } = parseTranscript(raw, filename);
    const segments = cuesToSegments(cues, merge);
    (self as unknown as Worker).postMessage({ id, segments, format });
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
