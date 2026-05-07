import { AfkSemaphore, acquire, release } from "./afk-orchestrator/afk-semaphore.js";
import { AfkSlackNotifier, SlackThread } from "./afk-slack-notifier.js";

export interface AgentRunContext {
  owner: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  comments: string;
  worktreePath: string;
  branchName: string;
  slackThread: SlackThread;
  semaphore: AfkSemaphore;
}

export interface SpawnResult {
  success: boolean;
  runId?: string;
  error?: string;
}

const GATEWAY_PORT = process.env.OPENCLAW_PORT ?? "18789";
const GATEWAY_TOKEN = process.env.OPENCLAW_TOKEN ?? "";

async function spawnSession(
  cwd: string,
  task: string,
  runTimeoutSeconds = 3600,
): Promise<{ runId: string }> {
  const url = `http://localhost:${GATEWAY_PORT}/v1/sessions`;
  const body = JSON.stringify({
    agentId: "coder",
    runtime: "subagent",
    cwd,
    task,
    runTimeoutSeconds,
  });

  const result = await execCurl([
    "-s",
    "-X",
    "POST",
    "-H",
    `Authorization: Bearer ${GATEWAY_TOKEN}`,
    "-H",
    "Content-Type: application/json",
    "-d",
    body,
    url,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`Session spawn failed: ${result.stderr || result.stdout}`);
  }

  const parsed = JSON.parse(result.stdout) as { id?: string; error?: string };
  if (!parsed.id) {
    throw new Error(`Session spawn returned no id: ${JSON.stringify(parsed)}`);
  }

  return { runId: parsed.id };
}

async function pollForCompletion(runId: string, timeoutMs = 3600 * 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() > deadline) {
      throw new Error(`Session ${runId} timed out after ${timeoutMs}ms`);
    }
    const status = await fetchSessionStatus(runId);
    if (status === "done" || status === "failed") {
      return;
    }
    // Poll every 5 seconds
    await sleep(5000);
  }
}

async function fetchSessionStatus(runId: string): Promise<string> {
  const url = `http://localhost:${GATEWAY_PORT}/v1/sessions/${runId}`;
  const result = await execCurl(["-s", "-H", `Authorization: Bearer ${GATEWAY_TOKEN}`, url]);

  if (result.exitCode !== 0) {
    return "unknown";
  }

  const parsed = JSON.parse(result.stdout) as { status?: string };
  return parsed.status ?? "unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function execCurl(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { exec } = await import("node:child_process");
  return new Promise((resolve) => {
    exec(["curl", ...args].join(" "), (error, stdout, stderr) => {
      resolve({ stdout, stderr, exitCode: error ? 1 : 0 });
    });
  });
}

/**
 * Main entry point for running an agent on a single issue.
 *
 * Lifecycle:
 * 1. Acquire semaphore slot
 * 2. Post "started" milestone to Slack
 * 3. Spawn subagent session via gateway HTTP API
 * 4. Poll until COMPLETE or error
 * 5. Post "done" or "error" milestone
 * 6. Release semaphore (in finally)
 */
export async function runAgentForIssue(ctx: AgentRunContext): Promise<SpawnResult> {
  const { semaphore, slackThread, issueNumber, issueTitle, worktreePath } = ctx;

  // 1. Acquire semaphore slot
  await acquire(semaphore, slackThread.issueKey);

  try {
    // 2. Notify Slack that agent started
    await ctx.slackThread.postMilestone({
      type: "started",
      issueNumber,
      title: issueTitle,
    });

    // 3. Construct task prompt
    const task = [
      `Fix issue #${issueNumber}: ${issueTitle}`,
      "",
      ctx.issueBody,
      "",
      "---",
      "Comments:",
      ctx.comments || "(no comments)",
      "",
      "When done, type COMPLETE on its own line.",
    ].join("\n");

    // 4. Spawn agent session with retry
    let runId: string | undefined;
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const result = await spawnSession(worktreePath, task);
        runId = result.runId;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < 3) {
          await sleep(10_000);
        }
      }
    }

    if (!runId) {
      const errorMsg = lastError ?? "Failed to spawn session after 3 attempts";
      await slackThread.postMilestone({ type: "error", issueNumber, error: errorMsg });
      return { success: false, error: errorMsg };
    }

    // 5. Poll for completion
    await pollForCompletion(runId);

    // 6. Fetch final transcript to check for COMPLETE keyword
    const done = await fetchDoneOutput(runId);
    if (done) {
      await slackThread.postMilestone({
        type: "done",
        issueNumber,
        prUrl: "", // PR URL resolved later via branch manager
      });
      return { success: true, runId };
    } else {
      await slackThread.postMilestone({
        type: "error",
        issueNumber,
        error: "Agent did not report COMPLETE",
      });
      return { success: false, error: "Agent did not report COMPLETE" };
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await slackThread.postMilestone({ type: "error", issueNumber, error: errorMsg });
    return { success: false, error: errorMsg };
  } finally {
    // 7. Always release semaphore
    release(semaphore, slackThread.issueKey);
  }
}

async function fetchDoneOutput(runId: string): Promise<boolean> {
  const url = `http://localhost:${GATEWAY_PORT}/v1/sessions/${runId}/transcript`;
  const result = await execCurl(["-s", "-H", `Authorization: Bearer ${GATEWAY_TOKEN}`, url]);

  if (result.exitCode !== 0) return false;

  const transcript = result.stdout;
  return transcript.includes("COMPLETE");
}
