import { basename } from "node:path";
import readline from "node:readline/promises";
import type { AutomationMode } from "@actalk/inkos-core";
import type { ExecutionStatus } from "@actalk/inkos-core";

export interface TuiFrameState {
  readonly projectName: string;
  readonly activeBookTitle?: string;
  readonly automationMode: AutomationMode;
  readonly status: ExecutionStatus;
}

export function renderTuiFrame(state: TuiFrameState): string {
  const lines = [
    `Project: ${state.projectName}`,
    `Book: ${state.activeBookTitle ?? "none"}`,
    `Mode: ${state.automationMode}`,
    `Stage: ${state.status}`,
    "",
    "> ",
  ];

  return lines.join("\n");
}

export async function launchTui(projectRoot: string): Promise<void> {
  const frame = renderTuiFrame({
    projectName: basename(projectRoot),
    automationMode: "semi",
    status: "idle",
  });

  process.stdout.write(frame);

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    await rl.question("");
  } finally {
    rl.close();
  }
}
