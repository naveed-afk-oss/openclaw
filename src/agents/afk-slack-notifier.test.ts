import { describe, it, expect, beforeEach, vi } from "vitest";
import { AfkSlackNotifier, MilestoneEvent, SlackThread } from "./afk-slack-notifier.js";

const MOCK_TS = "1234567890.123456";
const CHANNEL_ID = "C0B30NE82KA";

// ── helpers ───────────────────────────────────────────────────────────────────

function mockCurl(response: { ok?: boolean; ts?: string; error?: string } | string) {
  const json = typeof response === "string" ? response : JSON.stringify(response);
  return vi
    .spyOn(AfkSlackNotifier.prototype, "execCurl")
    .mockImplementation(async () => ({ stdout: json, stderr: "", exitCode: 0 }));
}

// ── shared beforeEach ────────────────────────────────────────────────────────

beforeEach(() => {
  vi.spyOn(AfkSlackNotifier.prototype, "execCurl").mockImplementation(async () => ({
    stdout: JSON.stringify({ ok: true, ts: MOCK_TS }),
    stderr: "",
    exitCode: 0,
  }));
});

// ── formatMessage ─────────────────────────────────────────────────────────────

describe("formatMessage", () => {
  it("formats started event", () => {
    const notifier = new AfkSlackNotifier(CHANNEL_ID);
    const msg = notifier.formatMessage({
      type: "started",
      issueNumber: 42,
      title: "Fix the bug",
    });
    expect(msg).toBe("🤖 Agent started on issue #42: Fix the bug");
  });

  it("formats progress event", () => {
    const notifier = new AfkSlackNotifier(CHANNEL_ID);
    const msg = notifier.formatMessage({
      type: "progress",
      milestone: "branch created",
      issueNumber: 99,
    });
    expect(msg).toBe("📝 branch created — issue #99");
  });

  it("formats done event", () => {
    const notifier = new AfkSlackNotifier(CHANNEL_ID);
    const msg = notifier.formatMessage({
      type: "done",
      issueNumber: 7,
      prUrl: "https://github.com/org/repo/pull/7",
    });
    expect(msg).toBe("✅ Issue #7 resolved — PR: https://github.com/org/repo/pull/7");
  });

  it("formats error event", () => {
    const notifier = new AfkSlackNotifier(CHANNEL_ID);
    const msg = notifier.formatMessage({
      type: "error",
      issueNumber: 3,
      error: "rate limit exceeded",
    });
    expect(msg).toBe("❌ Issue #3 failed: rate limit exceeded");
  });
});

// ── createThread ──────────────────────────────────────────────────────────────

describe("createThread", () => {
  it("returns SlackThread with correct shape", async () => {
    const notifier = new AfkSlackNotifier(CHANNEL_ID);
    const thread = await notifier.createThread("naveed-afk-oss/openclaw#42", 42);

    expect(thread).toHaveProperty("issueKey", "naveed-afk-oss/openclaw#42");
    expect(thread).toHaveProperty("threadTs", MOCK_TS);
    expect(thread).toHaveProperty("channelId", CHANNEL_ID);
  });

  it("calls Slack API without thread_ts (new channel thread)", async () => {
    const execCurlSpy = vi.spyOn(AfkSlackNotifier.prototype, "execCurl");
    const notifier = new AfkSlackNotifier(CHANNEL_ID);

    await notifier.createThread("org/repo#1", 1);

    const call: string[] = execCurlSpy.mock.calls[0]![0];
    const body = JSON.parse(call[call.indexOf("-d") + 1]);
    expect(body).toHaveProperty("channel", CHANNEL_ID);
    expect(body).not.toHaveProperty("thread_ts");
    expect(body).toHaveProperty("text");
  });
});

// ── postMilestone ─────────────────────────────────────────────────────────────

describe("postMilestone", () => {
  it("posts to existing thread with thread_ts", async () => {
    const notifier = new AfkSlackNotifier(CHANNEL_ID);
    const execCurlSpy = vi.spyOn(AfkSlackNotifier.prototype, "execCurl");

    const thread: SlackThread = {
      issueKey: "org/repo#5",
      threadTs: MOCK_TS,
      channelId: CHANNEL_ID,
    };

    const event: MilestoneEvent = { type: "started", issueNumber: 5, title: "Fix thing" };
    await notifier.postMilestone(thread, event);

    // Find the call that includes thread_ts in the -d JSON body (the second curl call to postMessageToThread)
    const threadCall = execCurlSpy.mock.calls.find((call) => {
      const args = call[0] as string[];
      return args.some((arg) => typeof arg === "string" && arg.includes('"thread_ts"'));
    });
    expect(threadCall).toBeDefined();
    const callArgs: string[] = threadCall![0];
    const bodyIdx = callArgs.indexOf("-d");
    const body = JSON.parse(callArgs[bodyIdx + 1]);
    expect(body).toHaveProperty("thread_ts", MOCK_TS);
    expect(body).toHaveProperty("text", "🤖 Agent started on issue #5: Fix thing");
  });

  it("throws when Slack API returns ok:false", async () => {
    const notifier = new AfkSlackNotifier(CHANNEL_ID);
    vi.spyOn(AfkSlackNotifier.prototype, "execCurl").mockImplementation(async () => ({
      stdout: JSON.stringify({ ok: false, error: "channel_not_found" }),
      stderr: "",
      exitCode: 0,
    }));

    const thread: SlackThread = {
      issueKey: "org/repo#5",
      threadTs: MOCK_TS,
      channelId: "INVALID",
    };

    const event: MilestoneEvent = { type: "started", issueNumber: 5, title: "x" };
    await expect(notifier.postMilestone(thread, event)).rejects.toThrow(
      "Slack API error: channel_not_found",
    );
  });
});

// ── default milestones ────────────────────────────────────────────────────────

describe("default milestones list", () => {
  it("defaults to ['started', 'done', 'error']", () => {
    const notifier = new AfkSlackNotifier(CHANNEL_ID);
    expect(notifier.milestonesToTrack).toEqual(["started", "done", "error"]);
  });

  it("accepts custom milestones via constructor", () => {
    const notifier = new AfkSlackNotifier(CHANNEL_ID, ["started", "progress"]);
    expect(notifier.milestonesToTrack).toEqual(["started", "progress"]);
  });
});
