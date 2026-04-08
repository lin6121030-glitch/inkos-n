/* ── InkOS TUI — persistent REPL with themed animations ── */

import { basename } from "node:path";
import readline from "node:readline/promises";
import {
  appendInteractionMessage,
  processProjectInteractionInput,
  routeNaturalLanguageIntent,
  type InteractionRuntimeTools,
} from "@actalk/inkos-core";
import {
  loadProjectSession,
  persistProjectSession,
  resolveSessionActiveBook,
} from "./session-store.js";
import { createInteractionTools } from "./tools.js";
import { formatTuiResult } from "./output.js";
import { ensureProject, interactiveLlmSetup } from "./setup.js";
import {
  c, bold, dim, cyan, green, yellow, gray, red, brightCyan, brightWhite,
  showCursor, reset, box,
} from "./ansi.js";
import {
  ThemedSpinner,
  animateStartup,
  formatResultCard,
  intentToTheme,
  printStyledHelp,
  printStyledStatus,
  printInputSeparator,
} from "./effects.js";

/* ── Version ── */

async function readVersion(): Promise<string> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf-8"));
    return pkg.version ?? "dev";
  } catch {
    return "dev";
  }
}

/* ── Process input with themed spinner ── */

async function processInput(
  projectRoot: string,
  input: string,
  tools: InteractionRuntimeTools,
): Promise<{ summary: string; intent: string } | undefined> {
  // Detect intent for themed spinner
  const session = await loadProjectSession(projectRoot);
  const activeBookId = await resolveSessionActiveBook(projectRoot, session);
  const routed = routeNaturalLanguageIntent(input, { activeBookId });
  const themeName = intentToTheme(routed.intent);

  const spinner = new ThemedSpinner(themeName);
  const intentLabels: Record<string, string> = {
    write_next: "writing chapter",
    revise_chapter: "revising chapter",
    rewrite_chapter: "rewriting chapter",
    update_focus: "updating focus",
    explain_status: "checking status",
    explain_failure: "investigating",
    pause_book: "pausing book",
    list_books: "listing books",
    select_book: "selecting book",
    switch_mode: "switching mode",
    rename_entity: "renaming entity",
    patch_chapter_text: "patching text",
    edit_truth: "editing truth file",
  };
  spinner.start(intentLabels[routed.intent] ?? "processing");

  try {
    const result = await processProjectInteractionInput({
      projectRoot,
      input,
      tools,
    });
    const summary = formatTuiResult({
      intent: result.request.intent,
      status: result.session.currentExecution?.status ?? "completed",
      bookId: result.session.activeBookId,
      mode: result.request.mode,
      responseText: result.responseText,
    });
    const nextSession = appendInteractionMessage(result.session, {
      role: "assistant",
      content: summary,
      timestamp: Date.now(),
    });
    await persistProjectSession(projectRoot, nextSession);
    spinner.succeed(c(summary, dim));
    return { summary, intent: result.request.intent };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    spinner.fail(c(msg, red));
    return undefined;
  }
}

/* ── Legacy exports for tests ── */

export interface TuiFrameState {
  readonly projectName: string;
  readonly activeBookTitle?: string;
  readonly automationMode: string;
  readonly status: string;
  readonly messages?: ReadonlyArray<string>;
  readonly events?: ReadonlyArray<string>;
}

export function renderTuiFrame(state: TuiFrameState): string {
  const lines = [
    `Project: ${state.projectName}`,
    `Book: ${state.activeBookTitle ?? "none"}`,
    `Mode: ${state.automationMode}`,
    `Stage: ${state.status}`,
    "",
    "Messages:",
    ...(state.messages?.length
      ? state.messages.slice(-3).map((message) => `- ${message}`)
      : ["- (empty)"]),
    "",
    "Events:",
    ...(state.events?.length
      ? state.events.slice(-3).map((event) => `- ${event}`)
      : ["- (empty)"]),
    "",
    "> ",
  ];
  return lines.join("\n");
}

export async function processTuiInput(
  projectRoot: string,
  input: string,
  tools: InteractionRuntimeTools,
) {
  const result = await processProjectInteractionInput({
    projectRoot,
    input,
    tools,
  });
  const summary = formatTuiResult({
    intent: result.request.intent,
    status: result.session.currentExecution?.status ?? "completed",
    bookId: result.session.activeBookId,
    mode: result.request.mode,
    responseText: result.responseText,
  });
  const nextSession = appendInteractionMessage(result.session, {
    role: "assistant",
    content: summary,
    timestamp: Date.now(),
  });
  await persistProjectSession(projectRoot, nextSession);
  return { ...result, session: nextSession };
}

/* ── Main REPL ── */

export async function launchTui(
  projectRoot: string,
  toolsOverride?: InteractionRuntimeTools,
): Promise<void> {
  // 1. Auto-setup
  const { hasLlmConfig } = await ensureProject(projectRoot);

  // 2. LLM config if missing
  if (!hasLlmConfig) {
    console.log();
    console.log(c("  No LLM configuration found.", yellow));
    console.log(c("  Let's set up your API provider first.", dim));
    await interactiveLlmSetup(projectRoot);
  }

  // 3. Load session
  const session = await loadProjectSession(projectRoot);
  const activeBookId = await resolveSessionActiveBook(projectRoot, session);
  const version = await readVersion();

  // 4. Animated welcome
  await animateStartup(version, basename(projectRoot), activeBookId);

  // 5. Bail if not interactive
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return;
  }

  // 6. Build tools
  let tools: InteractionRuntimeTools;
  try {
    tools = toolsOverride ?? (await createInteractionTools(projectRoot));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(c(`  ${c("✗", red, bold)} Failed to initialize: ${msg}`, red));
    console.log(c("  Check your .env or run: inkos config set-global", dim));
    console.log();
    return;
  }

  // 7. REPL loop
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `  ${c("❯", brightCyan)} `,
  });

  const cleanup = () => {
    process.stdout.write(showCursor);
    rl.close();
  };

  process.on("SIGINT", () => {
    console.log();
    console.log(c("  ◇ goodbye", dim));
    console.log();
    cleanup();
    process.exit(0);
  });

  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      continue;
    }

    // Built-in TUI commands
    if (/^\/quit$/i.test(input) || /^\/exit$/i.test(input) || /^(quit|exit|bye)$/i.test(input)) {
      console.log(c("  ◇ goodbye", dim));
      console.log();
      break;
    }

    if (/^\/help$/i.test(input) || /^(help|帮助)$/i.test(input)) {
      printStyledHelp();
      printInputSeparator();
      console.log();
      rl.prompt();
      continue;
    }

    if (/^\/status$/i.test(input) || /^(status|状态)$/i.test(input)) {
      try {
        const s = await loadProjectSession(projectRoot);
        const bId = await resolveSessionActiveBook(projectRoot, s);
        printStyledStatus({
          mode: s.automationMode,
          bookId: bId,
          status: s.currentExecution?.status ?? "idle",
          events: s.events,
        });
      } catch {
        console.log(c("  Could not load session.", dim));
      }
      printInputSeparator();
      console.log();
      rl.prompt();
      continue;
    }

    if (/^\/clear$/i.test(input)) {
      console.clear();
      rl.prompt();
      continue;
    }

    // Delegate to interaction layer with themed animation
    await processInput(projectRoot, input, tools);
    console.log();
    printInputSeparator();
    console.log();

    rl.prompt();
  }

  cleanup();
}
