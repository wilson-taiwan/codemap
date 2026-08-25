import type { SegmentInput } from "../lib/types";
import type { TranscriptFormat } from "../lib/transcript-parser";

interface WorkerResponse {
  id: number;
  segments?: SegmentInput[];
  format?: TranscriptFormat;
  error?: string;
}

export interface ParsedTranscript {
  segments: SegmentInput[];
  /** Which format the sniffer settled on, so the UI can say so. */
  format: TranscriptFormat;
}

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<
  number,
  { resolve: (r: ParsedTranscript) => void; reject: (e: Error) => void }
>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(
    new URL("../lib/vtt-parser.worker.ts", import.meta.url),
    { type: "module" },
  );
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const { id, segments, format, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve({ segments: segments ?? [], format: format ?? "text" });
  };
  worker.onerror = (e) => {
    const message = e.message || "Transcript worker error";
    for (const [, p] of pending) p.reject(new Error(message));
    pending.clear();
  };
  return worker;
}

export function parseTranscriptFile(
  raw: string,
  merge: boolean,
  filename?: string,
): Promise<ParsedTranscript> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, raw, merge, filename });
  });
}

export function _resetForTests(): void {
  if (worker) worker.terminate();
  worker = null;
  pending.clear();
  nextId = 0;
}
