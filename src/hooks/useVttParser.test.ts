import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetForTests, parseTranscriptFile } from "./useVttParser";
import type { SegmentInput } from "../lib/types";

class StubWorker {
  static instances: StubWorker[] = [];
  onmessage: ((e: MessageEvent<{ id: number; segments?: SegmentInput[]; format?: string; error?: string }>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted: unknown[] = [];
  constructor() {
    StubWorker.instances.push(this);
  }
  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }
  terminate(): void {}
  respond(payload: { id: number; segments?: SegmentInput[]; format?: string; error?: string }): void {
    this.onmessage?.(new MessageEvent("message", { data: payload }));
  }
  fail(message: string): void {
    this.onerror?.({ message } as unknown as ErrorEvent);
  }
}

beforeEach(() => {
  vi.stubGlobal("Worker", StubWorker);
  _resetForTests();
  StubWorker.instances = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  _resetForTests();
});

describe("useVttParser", () => {
  it("posts {raw, merge, id} to the worker and resolves with the segments payload", async () => {
    const segments: SegmentInput[] = [
      { speaker: "A", timestamp_start: "00:00:01.000", timestamp_end: "00:00:02.000", text: "hi", section_tag: null },
    ];
    const p = parseTranscriptFile("WEBVTT\n...", true);

    expect(StubWorker.instances).toHaveLength(1);
    const w = StubWorker.instances[0];
    expect(w.posted).toHaveLength(1);
    expect(w.posted[0]).toMatchObject({ raw: "WEBVTT\n...", merge: true });
    const id = (w.posted[0] as { id: number }).id;
    w.respond({ id, segments, format: "vtt" });

    expect(await p).toEqual({ segments, format: "vtt" });
  });

  it("reuses the same worker across multiple parseVttFile calls", () => {
    const p1 = parseTranscriptFile("WEBVTT\n...", true);
    const p2 = parseTranscriptFile("WEBVTT\n...", false);
    expect(StubWorker.instances).toHaveLength(1);
    const w = StubWorker.instances[0];
    w.respond({ id: 0, segments: [] });
    w.respond({ id: 1, segments: [] });
    return Promise.all([p1, p2]);
  });

  it("rejects when the worker posts an error payload", async () => {
    const p = parseTranscriptFile("WEBVTT\n...", true);
    const w = StubWorker.instances[0];
    const id = (w.posted[0] as { id: number }).id;
    w.respond({ id, error: "parse boom" });
    await expect(p).rejects.toThrow("parse boom");
  });

  it("rejects pending parses when the worker errors", async () => {
    const p1 = parseTranscriptFile("a", true);
    const p2 = parseTranscriptFile("b", true);
    StubWorker.instances[0].fail("worker crashed");
    await expect(p1).rejects.toThrow("worker crashed");
    await expect(p2).rejects.toThrow("worker crashed");
  });
});
