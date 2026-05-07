import { promises as fs } from "node:fs";
import path from "node:path";

// Claims shape: { "[owner]/[repo]#<issue_number>": "<ISO timestamp>" }
export interface AfkClaimsStore {
  claims: Record<string, string>;
}

const CLAIMS_FILE = "/data/.clawdbot/afk-claims.json";
const CLAIM_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

let _store: AfkClaimsStore = { claims: {} };
let _loaded = false;

async function ensureDir(): Promise<void> {
  const dir = path.dirname(CLAIMS_FILE);
  await fs.mkdir(dir, { recursive: true });
}

async function load(): Promise<void> {
  if (_loaded) return;
  try {
    const raw = await fs.readFile(CLAIMS_FILE, "utf-8");
    _store = JSON.parse(raw) as AfkClaimsStore;
  } catch {
    _store = { claims: {} };
  }
  _loaded = true;
}

async function persist(): Promise<void> {
  await ensureDir();
  await fs.writeFile(CLAIMS_FILE, JSON.stringify(_store, null, 2), "utf-8");
}

function claimKey(owner: string, repo: string, issueNumber: number): string {
  return `${owner}/${repo}#${issueNumber}`;
}

/**
 * Remove entries older than 2 hours.
 */
export function expireClaims(): void {
  const now = Date.now();
  for (const key of Object.keys(_store.claims)) {
    const age = now - new Date(_store.claims[key]).getTime();
    if (age > CLAIM_TTL_MS) {
      delete _store.claims[key];
    }
  }
}

/**
 * Attempt to claim an issue. Returns true if newly claimed, false if already claimed
 * (including if the previous claim has since expired — expired entries are removed first).
 */
export async function claimIssue(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<boolean> {
  await load();
  expireClaims();

  const key = claimKey(owner, repo, issueNumber);
  if (key in _store.claims) {
    // Already claimed (and not expired — expireClaims already cleaned stale ones)
    return false;
  }

  _store.claims[key] = new Date().toISOString();
  await persist();
  return true;
}

/**
 * Check whether an issue is currently claimed (ignores expiry — use claimIssue to handle expiry).
 */
export async function isClaimed(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<boolean> {
  await load();
  // Don't auto-expire here — this is a read-only check per the spec
  const key = claimKey(owner, repo, issueNumber);
  return key in _store.claims;
}

/**
 * Reset store (for testing).
 */
export function __testingResetStore(): void {
  _store = { claims: {} };
  _loaded = false;
}

/**
 * Seed store with raw data (for testing). Returns the stringified store content
 * so tests can also seed the fs mock if needed.
 */
export function __testingSeedStore(data: Record<string, string>): string {
  _store = { claims: { ...data } };
  _loaded = true;
  return JSON.stringify(_store);
}
