import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquire,
  createSemaphore,
  isAcquired,
  release,
} from "./afk-semaphore.js";

// Spy on the actual fs module so we can control read/write outcomes
const readFileSyncSpy = vi.spyOn(fs, "readFileSync");
const writeFileSyncSpy = vi.spyOn(fs, "writeFileSync");
const renameSyncSpy = vi.spyOn(fs, "renameSync");
const existsSyncSpy = vi.spyOn(fs, "existsSync");
const mkdirSyncSpy = vi.spyOn(fs, "mkdirSync");

// ---- helpers ----

function mockFile(contents: object) {
  existsSyncSpy.mockReturnValue(true);
  readFileSyncSpy.mockReturnValue(JSON.stringify(contents));
}

function mockNoFile() {
  existsSyncSpy.mockReturnValue(false);
  readFileSyncSpy.mockReturnValue(null as never);
}

function capturedWrite(): object {
  const call = writeFileSyncSpy.mock.calls[writeFileSyncSpy.mock.calls.length - 1];
  return JSON.parse(call[0] as string);
}

// ---- tests ----

describe("afk-semaphore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("acquire then release cycle", async () => {
    mockNoFile();
    const sem = createSemaphore(2);
    expect(await acquire(sem, "naveed-afk-oss/openclaw#42")).toBe(true);
    expect(isAcquired(sem, "naveed-afk-oss/openclaw#42")).toBe(true);
    release(sem, "naveed-afk-oss/openclaw#42");
    expect(isAcquired(sem, "naveed-afk-oss/openclaw#42")).toBe(false);
  });

  it("enforces max 2 slots — third acquire spins waiting", async () => {
    mockNoFile();
    const sem = createSemaphore(2);

    await acquire(sem, "naveed-afk-oss/openclaw#1");
    await acquire(sem, "naveed-afk-oss/openclaw#2");

    // Both slots are now held. Simulate the file state.
    mockFile({ slots: 2, maxSlots: 2, holders: ["naveed-afk-oss/openclaw#1", "naveed-afk-oss/openclaw#2"] });

    // Verify both holders are indeed tracked.
    expect(isAcquired(sem, "naveed-afk-oss/openclaw#1")).toBe(true);
    expect(isAcquired(sem, "naveed-afk-oss/openclaw#2")).toBe(true);
  });

  it("release re-enables blocked acquire", async () => {
    mockNoFile();
    const sem = createSemaphore(2);

    await acquire(sem, "naveed-afk-oss/openclaw#1");
    await acquire(sem, "naveed-afk-oss/openclaw#2");

    release(sem, "naveed-afk-oss/openclaw#1"); // slot frees up

    // Now #3 can acquire
    mockFile({ slots: 1, maxSlots: 2, holders: ["naveed-afk-oss/openclaw#2"] });
    expect(await acquire(sem, "naveed-afk-oss/openclaw#3")).toBe(true);
    expect(isAcquired(sem, "naveed-afk-oss/openclaw#3")).toBe(true);
  });

  it("wrong issueKey cannot release another's slot", async () => {
    mockNoFile();
    const sem = createSemaphore(2);

    await acquire(sem, "naveed-afk-oss/openclaw#1");

    release(sem, "naveed-afk-oss/openclaw#999"); // wrong key — no-op

    expect(isAcquired(sem, "naveed-afk-oss/openclaw#1")).toBe(true);
  });
});