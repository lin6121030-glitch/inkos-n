import {
  RuntimeStateDeltaSchema,
  type RuntimeStateDelta,
} from "../models/runtime-state.js";

export interface SettlerDeltaOutput {
  readonly postSettlement: string;
  readonly runtimeStateDelta: RuntimeStateDelta;
}

export interface RetryableError extends Error {
  canRetry: boolean;
  rawContent: string;
}

function sanitizeJSON(str: string): string {
  return str
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/["""]/g, '"');  // 只替换中文引号为英文引号
}

export function parseSettlerDeltaOutput(content: string, logger?: { info: (msg: string) => void; warn: (msg: string) => void }): SettlerDeltaOutput {
  const extract = (tag: string): string => {
    const regex = new RegExp(
      `=== ${tag} ===\\s*([\\s\\S]*?)(?==== [A-Z_]+ ===|$)`,
    );
    const match = content.match(regex);
    return match?.[1]?.trim() ?? "";
  };

  let rawDelta = extract("RUNTIME_STATE_DELTA");
  if (!rawDelta) {
    // 备选：直接用原始内容（fixJSONWithLLM 可能返回无标签的 JSON）
    logger?.warn("[Settler解析] RUNTIME_STATE_DELTA 区块缺失，尝试直接解析");
    rawDelta = content;
  }

  logger?.info(`[Settler解析] RUNTIME_STATE_DELTA 原始内容:\n${rawDelta.slice(0, 1500)}`);

  const jsonPayload = stripCodeFence(rawDelta);
  const sanitized = sanitizeJSON(jsonPayload);
  let parsed: unknown;
  try {
    parsed = JSON.parse(sanitized);
  } catch (error) {
    logger?.warn(`[Settler解析] JSON格式错误，尝试修复...`);
    // 抛出可重试的错误，带原始内容供修复
    const retryErr = new Error(`JSON parsing failed: ${String(error).slice(0, 100)}`) as unknown as RetryableError;
    retryErr.canRetry = true;
    retryErr.rawContent = jsonPayload;
    throw retryErr;
  }

  try {
    const delta = RuntimeStateDeltaSchema.parse(parsed);
    
    // 打印关键状态变更
    if (delta.currentStatePatch) {
      logger?.info(`[Settler解析] 状态变更(Patch): ${JSON.stringify(delta.currentStatePatch)}`);
    }
  
    if (delta.numericalFacts) {
      logger?.info(`[Settler解析] numericalFacts: ${JSON.stringify(delta.numericalFacts)}`);
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
  // Remove THINK tags first
  const cleaned = trimmed
    .replace(/<THINK>[\s\S]*?<\/THINK>/gi, '')
    .replace(/<THINK>[\s\S]*/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<Think>[\s\S]*?<\/Think>/gi, '');
  const fenced = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? cleaned.trim();
}
