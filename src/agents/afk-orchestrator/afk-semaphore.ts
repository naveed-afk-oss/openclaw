import fs from "node:fs";
import path from "node:path";

const STATE_DIR =
  process.env.AFK_STATE_DIR ??
  `${process.env.OPENCLAW_STATE_DIR ?? process.env.HOME ?? "$HOME"}/.openclaw/afk-state`;
const SEMAPHORE_DIR = STATE_DIR;
const SEMAPHORE_FILE = "afk-semaphore.json";

function ensureDir(): void {
  if (!fs.existsSync(SEMAPHORE_DIR)) {
    fs.mkdirSync(SEMAPHORE_DIR, { recursive: true });
  }
}

function semaphorePath(): string {
  return path.join(SEMAPHORE_DIR, SEMAPHORE_FILE);
}

export interface AfkSemaphore {
  maxSlots: number;
}

interface SemaphoreData {
  slots: number;
  maxSlots: number;
  holders: string[];
}

function readSemaphore(): SemaphoreData {
  ensureDir();
  if (!fs.existsSync(semaphorePath())) {
    return { slots: 0, maxSlots: 2, holders: [] };
  }
  const raw = fs.readFileSync(semaphorePath(), "utf-8");
  return JSON.parse(raw) as SemaphoreData;
}

function writeSemaphore(data: SemaphoreData): void {
  ensureDir();
  const tmp = semaphorePath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data), "utf-8");
  fs.renameSync(tmp, semaphorePath());
}

export function createSemaphore(maxSlots: number): AfkSemaphore {
  const data = readSemaphore();
  data.maxSlots = maxSlots;
  writeSemaphore(data);
  return { maxSlots };
}

/** Synchronous wait-for-slot loop backed by fs reads. */
function waitForSlotSync(issueKey: string, maxSlots: number): boolean {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data = readSemaphore();
    if (data.slots < maxSlots) {
      data.slots++;
      data.holders.push(issueKey);
      writeSemaphore(data);
      return true;
    }
    // Slot unavailable — spin, re-reading until one frees up.
    // In production a real async queue / file-watcher would replace this.
  }
}

export function acquire(semaphore: AfkSemaphore, issueKey: string): Promise<boolean> {
  return Promise.resolve(waitForSlotSync(issueKey, semaphore.maxSlots));
}

export function release(semaphore: AfkSemaphore, issueKey: string): void {
  const data = readSemaphore();
  const idx = data.holders.indexOf(issueKey);
  if (idx === -1) return;
  data.holders.splice(idx, 1);
  data.slots = Math.max(0, data.slots - 1);
  writeSemaphore(data);
}

export function isAcquired(semaphore: AfkSemaphore, issueKey: string): boolean {
  const data = readSemaphore();
  return data.holders.includes(issueKey);
}
