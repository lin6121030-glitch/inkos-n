import {
  RuntimeStateDeltaSchema,
  type RuntimeStateDelta,
} from "../models/runtime-state.js";

export interface SettlerDeltaOutput {
  readonly postSettlement: string;
  readonly runtimeStateDelta: RuntimeStateDelta;
}

function sanitizeJSON(str: string): string {
  return str
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/,\s*([}\]])/g, "$1");
}

export function parseSettlerDeltaOutput(content: string, logger?: { info: (msg: string) => void; warn: (msg: string) => void }): SettlerDeltaOutput {
  const extract = (tag: string): string => {
    const regex = new RegExp(
      `=== ${tag} ===\\s*([\\s\\S]*?)(?==== [A-Z_]+ ===|$)`,
    );
    const match = content.match(regex);
    return match?.[1]?.trim() ?? "";
  };

  const rawDelta = extract("RUNTIME_STATE_DELTA");
  if (!rawDelta) {
    logger?.warn("[Settler解析] RUNTIME_STATE_DELTA 区块缺失");
    throw new Error("runtime state delta block is missing");
  }

  logger?.info(`[Settler解析] RUNTIME_STATE_DELTA 原始内容:\n${rawDelta.slice(0, 500)}...`);

  const jsonPayload = stripCodeFence(rawDelta);
  let parsed: unknown;
  try {
    parsed = JSON.parse(sanitizeJSON(jsonPayload));
  } catch (error) {
    logger?.warn(`[Settler解析] JSON解析失败: ${error}`);
    throw new Error(`runtime state delta is not valid JSON: ${String(error)}`);
  }

  try {
    const delta = RuntimeStateDeltaSchema.parse(parsed);
    
    // 打印关键状态变更
    if (delta.currentStatePatch) {
      logger?.info(`[Settler解析] 状态变更(Patch): ${JSON.stringify(delta.currentStatePatch)}`);
    }
    if (delta.hookOps?.upsert) {
      logger?.info(`[Settler解析] 伏笔操作: ${JSON.stringify(delta.hookOps.upsert)}`);
    }
    if (delta.hookOps?.resolve?.length) {
      logger?.info(`[Settler解析] 伏笔回收: ${JSON.stringify(delta.hookOps.resolve)}`);
    }
    if (delta.chapterSummary) {
      logger?.info(`[Settler解析] 章节摘要: ${JSON.stringify(delta.chapterSummary)}`);
    }
    if (delta.newHookCandidates?.length) {
      logger?.info(`[Settler解析] 新伏笔候选: ${JSON.stringify(delta.newHookCandidates)}`);
    }

    return {
      postSettlement: extract("POST_SETTLEMENT"),
      runtimeStateDelta: delta,
    };
  } catch (error) {
    logger?.warn(`[Settler解析] Schema验证失败: ${error}`);
    throw new Error(`runtime state delta failed schema validation: ${String(error)}`);
  }
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}
