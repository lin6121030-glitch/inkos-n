/* ── Auto-init & environment detection for TUI ── */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import readline from "node:readline/promises";
import {
  c, bold, dim, italic,
  cyan, green, yellow, gray, red,
  brightCyan, brightGreen, brightWhite,
} from "./ansi.js";
import { GLOBAL_ENV_PATH } from "../utils.js";

const PROVIDERS = ["openai", "anthropic", "custom"] as const;

interface SetupResult {
  readonly projectRoot: string;
  readonly hasLlmConfig: boolean;
}

export async function ensureProject(cwd: string): Promise<SetupResult> {
  const configPath = join(cwd, "inkos.json");
  const hasConfig = await fileExists(configPath);

  if (!hasConfig) {
    await autoInit(cwd);
  }

  const hasLlm = await hasLlmConfig(cwd);
  return { projectRoot: cwd, hasLlmConfig: hasLlm };
}

export async function interactiveLlmSetup(
  projectRoot: string,
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log();
    console.log(`  ${c("◈", brightCyan)} ${c("LLM Setup", bold, brightWhite)}`);
    console.log(c("  Configure your model provider to start writing.", dim));
    console.log();

    // Provider
    console.log(`  ${c("1", cyan)}  ${c("Provider", gray)}`);
    console.log(c("     openai / anthropic / custom (OpenAI-compatible proxy)", dim));
    const providerInput = await rl.question(`     ${c("❯", cyan)} `);
    const provider = PROVIDERS.includes(providerInput.trim() as typeof PROVIDERS[number])
      ? providerInput.trim()
      : "openai";
    console.log(`     ${c("✓", brightGreen)} ${provider}`);
    console.log();

    // Base URL
    console.log(`  ${c("2", cyan)}  ${c("Base URL", gray)}`);
    console.log(c("     Your API endpoint", dim));
    const baseUrl = await rl.question(`     ${c("❯", cyan)} `);
    console.log(`     ${c("✓", brightGreen)} ${baseUrl.trim() || "(default)"}`);
    console.log();

    // API Key
    console.log(`  ${c("3", cyan)}  ${c("API Key", gray)}`);
    const apiKey = await rl.question(`     ${c("❯", cyan)} `);
    const maskedKey = apiKey.trim().length > 8
      ? apiKey.trim().slice(0, 4) + "···" + apiKey.trim().slice(-4)
      : "···";
    console.log(`     ${c("✓", brightGreen)} ${maskedKey}`);
    console.log();

    // Model
    console.log(`  ${c("4", cyan)}  ${c("Model", gray)}`);
    console.log(c("     e.g. gpt-4o, claude-sonnet-4-20250514, deepseek-chat", dim));
    const model = await rl.question(`     ${c("❯", cyan)} `);
    console.log(`     ${c("✓", brightGreen)} ${model.trim()}`);
    console.log();

    // Scope
    console.log(`  ${c("5", cyan)}  ${c("Save scope", gray)}`);
    console.log(c("     global = all projects, project = this directory only", dim));
    const scope = await rl.question(`     ${c("❯", cyan)} ${c("[global]", dim)} `);
    const useGlobal = scope.trim().toLowerCase() !== "project";

    const envContent = [
      `INKOS_LLM_PROVIDER=${provider}`,
      `INKOS_LLM_BASE_URL=${baseUrl.trim()}`,
      `INKOS_LLM_API_KEY=${apiKey.trim()}`,
      `INKOS_LLM_MODEL=${model.trim()}`,
    ].join("\n");

    if (useGlobal) {
      const globalDir = join(GLOBAL_ENV_PATH, "..");
      await mkdir(globalDir, { recursive: true });
      await writeFile(GLOBAL_ENV_PATH, envContent + "\n", "utf-8");
      console.log();
      console.log(`  ${c("✓", brightGreen, bold)} ${c("Saved to", dim)} ${c(GLOBAL_ENV_PATH, gray)}`);
    } else {
      await writeFile(join(projectRoot, ".env"), envContent + "\n", "utf-8");
      console.log();
      console.log(`  ${c("✓", brightGreen, bold)} ${c("Saved to", dim)} ${c(".env", gray)}`);
    }
    console.log();
  } finally {
    rl.close();
  }
}

async function autoInit(cwd: string): Promise<void> {
  const projectName = basename(cwd);
  console.log();
  console.log(`  ${c("◌", cyan)} ${c(`Initializing project in ${projectName}/ ...`, dim)}`);

  await mkdir(join(cwd, "books"), { recursive: true });
  await mkdir(join(cwd, "radar"), { recursive: true });

  const config = {
    name: projectName,
    version: "0.1.0",
    language: "zh",
    llm: {
      provider: process.env.INKOS_LLM_PROVIDER ?? "openai",
      baseUrl: process.env.INKOS_LLM_BASE_URL ?? "",
      model: process.env.INKOS_LLM_MODEL ?? "",
    },
    notify: [],
    daemon: {
      schedule: {
        radarCron: "0 */6 * * *",
        writeCron: "*/15 * * * *",
      },
      maxConcurrentBooks: 3,
    },
  };

  await writeFile(
    join(cwd, "inkos.json"),
    JSON.stringify(config, null, 2),
    "utf-8",
  );

  const hasGlobal = await hasGlobalConfig();
  if (!hasGlobal) {
    await writeFile(
      join(cwd, ".env"),
      [
        "# LLM Configuration — run inkos tui to configure interactively",
        "INKOS_LLM_PROVIDER=openai",
        "INKOS_LLM_BASE_URL=",
        "INKOS_LLM_API_KEY=",
        "INKOS_LLM_MODEL=",
      ].join("\n"),
      "utf-8",
    );
  }

  await writeFile(
    join(cwd, ".gitignore"),
    [".env", "node_modules/", ".DS_Store"].join("\n"),
    "utf-8",
  );

  console.log(`  ${c("✓", brightGreen, bold)} ${c("Project initialized", dim)}`);
}

async function hasLlmConfig(projectRoot: string): Promise<boolean> {
  const projectEnv = join(projectRoot, ".env");
  if (await checkEnvForKey(projectEnv)) return true;
  return checkEnvForKey(GLOBAL_ENV_PATH);
}

async function hasGlobalConfig(): Promise<boolean> {
  return checkEnvForKey(GLOBAL_ENV_PATH);
}

async function checkEnvForKey(envPath: string): Promise<boolean> {
  try {
    const content = await readFile(envPath, "utf-8");
    const match = content.match(/INKOS_LLM_API_KEY=(.+)/);
    return !!match && match[1]!.trim().length > 0 && !match[1]!.includes("your-api-key");
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
