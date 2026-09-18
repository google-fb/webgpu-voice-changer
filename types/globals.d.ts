/// <reference types="@webgpu/types" />

// AudioContext.setSinkId (Chromium 110+) is not part of lib.dom yet.
interface AudioContext {
  setSinkId?(sinkId: string | { type: "none" }): Promise<void>;
  readonly sinkId?: string | { type: "none" };
}

// Minimal typing for the dedicated-worker global scope; lib.dom and
// lib.webworker cannot be combined, so the worker module casts `self`.
interface WorkerScopeLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
}
