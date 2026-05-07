import { exec } from "node:child_process";

export type MilestoneEvent =
  | { type: "started"; issueNumber: number; title: string }
  | { type: "progress"; milestone: string; issueNumber: number }
  | { type: "done"; issueNumber: number; prUrl: string }
  | { type: "error"; issueNumber: number; error: string };

export interface SlackThread {
  issueKey: string; // e.g. "naveed-afk-oss/openclaw#42"
  threadTs: string; // Slack thread timestamp
  channelId: string; // e.g. "C0B30NE82KA"
}

const DEFAULT_MILESTONES = ["started", "done", "error"];

export class AfkSlackNotifier {
  private channelId: string;
  private milestones: string[];

  constructor(channelId: string, milestones: string[] = [...DEFAULT_MILESTONES]) {
    this.channelId = channelId;
    this.milestones = milestones;
  }

  get milestonesToTrack(): string[] {
    return this.milestones;
  }

  formatMessage(event: MilestoneEvent): string {
    switch (event.type) {
      case "started":
        return `🤖 Agent started on issue #${event.issueNumber}: ${event.title}`;
      case "progress":
        return `📝 ${event.milestone} — issue #${event.issueNumber}`;
      case "done":
        return `✅ Issue #${event.issueNumber} resolved — PR: ${event.prUrl}`;
      case "error":
        return `❌ Issue #${event.issueNumber} failed: ${event.error}`;
    }
  }

  async createThread(issueKey: string, issueNumber: number): Promise<SlackThread> {
    const text = `🧵 Thread opened for ${issueKey}`;
    const threadTs = await this.postMessage(text);
    return {
      issueKey,
      threadTs,
      channelId: this.channelId,
    };
  }

  async postMilestone(thread: SlackThread, event: MilestoneEvent): Promise<void> {
    const text = this.formatMessage(event);
    await this.postMessageToThread(thread.threadTs, text);
  }

  private async postMessage(text: string): Promise<string> {
    const body = JSON.stringify({
      channel: this.channelId,
      text,
    });
    const result = await this.execCurl([
      "-s",
      "-X",
      "POST",
      "-H",
      `Authorization: Bearer ${process.env.SLACK_BOT_TOKEN ?? ""}`,
      "-H",
      "Content-Type: application/json",
      "-d",
      body,
      "https://slack.com/api/chat.postMessage",
    ]);
    const parsed = JSON.parse(result.stdout) as { ts?: string; ok: boolean; error?: string };
    if (!parsed.ok) {
      throw new Error(`Slack API error: ${parsed.error ?? "unknown"}`);
    }
    return parsed.ts ?? "";
  }

  private async postMessageToThread(threadTs: string, text: string): Promise<void> {
    const body = JSON.stringify({
      channel: this.channelId,
      thread_ts: threadTs,
      text,
    });
    const result = await this.execCurl([
      "-s",
      "-X",
      "POST",
      "-H",
      `Authorization: Bearer ${process.env.SLACK_BOT_TOKEN ?? ""}`,
      "-H",
      "Content-Type: application/json",
      "-d",
      body,
      "https://slack.com/api/chat.postMessage",
    ]);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; error?: string };
    if (!parsed.ok) {
      throw new Error(`Slack API error: ${parsed.error ?? "unknown"}`);
    }
  }

  async execCurl(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const { exec } = await import("node:child_process");
    return new Promise((resolve) => {
      exec(["curl", ...args].join(" "), (error, stdout, stderr) => {
        resolve({ stdout, stderr, exitCode: error ? 1 : 0 });
      });
    });
  }
}
