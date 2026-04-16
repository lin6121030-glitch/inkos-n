import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import type { ValidationResult, StateValidatorAgent } from "../agents/state-validator.js";
import { ValidationSeverity } from "../agents/state-validator.js";
import type { WriteChapterOutput, WriterAgent } from "../agents/writer.js";
import type { BookConfig } from "../models/book.js";
import type { ContextPackage, RuleStack } from "../models/input-governance.js";
import type { Logger } from "../utils/logger.js";
import type { LengthLanguage } from "../utils/length-metrics.js";
import {
  buildStateDegradedPersistenceOutput,
  buildStateDegradedIssues,
  retrySettlementAfterValidationFailure,
} from "./chapter-state-recovery.js";

export async function validateChapterTruthPersistence(params: {
  readonly writer: Pick<WriterAgent, "settleChapterState">;
  readonly validator: Pick<StateValidatorAgent, "validate">;
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly title: string;
  readonly content: string;
  readonly persistenceOutput: WriteChapterOutput;
  readonly auditResult: AuditResult;
  readonly previousTruth: {
    readonly oldState: string;
    readonly oldHooks: string;
    readonly oldLedger: string;
  };
  readonly reducedControlInput?: {
    chapterIntent: string;
    contextPackage: ContextPackage;
    ruleStack: RuleStack;
  };
  readonly language: LengthLanguage;
  readonly logWarn: (message: { zh: string; en: string }) => void;
  readonly logger?: Pick<Logger, "warn">;
}): Promise<{
  readonly validation: ValidationResult;
  readonly chapterStatus: "state-degraded" | null;
  readonly degradedIssues: ReadonlyArray<AuditIssue>;
  readonly persistenceOutput: WriteChapterOutput;
  readonly auditResult: AuditResult;
}> {
  let validation: ValidationResult;
  let chapterStatus: "state-degraded" | null = null;
  let degradedIssues: ReadonlyArray<AuditIssue> = [];
  let persistenceOutput = params.persistenceOutput;
  let auditResult = params.auditResult;

  try {
    validation = await params.validator.validate(
      params.content,
      params.chapterNumber,
      params.previousTruth.oldState,
      persistenceOutput.updatedState,
      params.previousTruth.oldHooks,
      persistenceOutput.updatedHooks,
      params.language,
    );
  } catch (error) {
    throw new Error(`State validation failed for chapter ${params.chapterNumber}: ${String(error)}`);
  }

  // 添加调试日志：验证器原始结果
  params.logger?.warn(`[chapter-truth-validation] [DEBUG] 验证器原始结果:`);
  params.logger?.warn(`[chapter-truth-validation] [DEBUG] validation.passed=${validation.passed}, severity=${validation.severity}, warnings=${validation.warnings.length}`);

  if (validation.warnings.length > 0) {
    params.logWarn({
      zh: `状态校验：第${params.chapterNumber}章发现 ${validation.warnings.length} 条警告`,
      en: `State validation: ${validation.warnings.length} warning(s) for chapter ${params.chapterNumber}`,
    });
    for (const warning of validation.warnings) {
      params.logger?.warn(`  [${warning.category}] ${warning.description}`);
    }
    
    // Add State Validator warnings to auditResult.issues
    auditResult = {
      ...auditResult,
      issues: [...auditResult.issues, 
        ...validation.warnings.map(w => ({
          severity: w.severity === ValidationSeverity.FAIL ? "critical" as const :
                  w.severity === ValidationSeverity.CONCERN ? "concern" as const :
                  "warning" as const,
          category: `state-${w.category}`,
          description: w.description,
          suggestion: validation.fixSuggestions && validation.fixSuggestions.length > 0 
            ? validation.fixSuggestions.find(fs => fs.category === w.category)?.suggestion || ""
            : "",
        })),
        ...(validation.fixSuggestions || []).map(fs => ({
          severity: "suggestion" as const,
          category: `state-fix-${fs.category}`,
          description: fs.issue,
          suggestion: fs.suggestion,
        }))
      ],
    };
  }

  if (!validation.passed) {
    const recovery = await retrySettlementAfterValidationFailure({
      writer: params.writer,
      validator: params.validator,
      book: params.book,
      bookDir: params.bookDir,
      chapterNumber: params.chapterNumber,
      title: params.title,
      content: params.content,
      reducedControlInput: params.reducedControlInput,
      oldState: params.previousTruth.oldState,
      oldHooks: params.previousTruth.oldHooks,
      originalValidation: validation,
      language: params.language,
      logWarn: params.logWarn,
      logger: params.logger,
    });

    // 添加调试日志：恢复逻辑分析
    params.logger?.warn(`[chapter-truth-validation] [DEBUG] 恢复逻辑分析:`);
    params.logger?.warn(`[chapter-truth-validation] [DEBUG] recovery.kind=${recovery.kind}`);
    
    if (recovery.kind === "recovered") {
      params.logger?.warn(`[chapter-truth-validation] [DEBUG] 验证结果被覆盖: 原始validation.passed=${validation.passed} → 恢复后validation.passed=${recovery.validation.passed}`);
      
      // 🔧 修复：检查重试后的验证结果
      if (recovery.validation.passed) {
        // 重试成功，验证通过
        persistenceOutput = recovery.output;
        validation = recovery.validation;
        params.logger?.warn(`[chapter-truth-validation] [DEBUG] 重试成功，验证通过`);
      } else {
        // 重试失败，验证仍然不通过
        params.logger?.warn(`[chapter-truth-validation] [DEBUG] 重试失败，验证仍然不通过，设置state-degraded`);
        chapterStatus = "state-degraded";
        degradedIssues = [];
        persistenceOutput = buildStateDegradedPersistenceOutput({
          output: persistenceOutput,
          oldState: params.previousTruth.oldState,
          oldHooks: params.previousTruth.oldHooks,
          oldLedger: params.previousTruth.oldLedger,
        });
        auditResult = {
          ...auditResult,
          issues: [...auditResult.issues],
        };
      }
    } else {
      params.logger?.warn(`[chapter-truth-validation] [DEBUG] 设置state-degraded状态: chapterStatus=state-degraded`);
      chapterStatus = "state-degraded";
      // 🔧 修复：degraded情况下recovery没有validation属性，需要从原始validation获取warnings
      const degradedIssuesFromRecovery = buildStateDegradedIssues(validation.warnings, params.language);
      degradedIssues = degradedIssuesFromRecovery;
      persistenceOutput = buildStateDegradedPersistenceOutput({
        output: persistenceOutput,
        oldState: params.previousTruth.oldState,
        oldHooks: params.previousTruth.oldHooks,
        oldLedger: params.previousTruth.oldLedger,
      });
      auditResult = {
        ...auditResult,
        issues: [...auditResult.issues, ...degradedIssuesFromRecovery],
      };
    }
  }

  // 添加调试日志：最终结果分析
  params.logger?.warn(`[chapter-truth-validation] [DEBUG] 最终返回结果:`);
  params.logger?.warn(`[chapter-truth-validation] [DEBUG] 最终validation.passed=${validation.passed}, chapterStatus=${chapterStatus}`);

  return {
    validation,
    chapterStatus,
    degradedIssues,
    persistenceOutput,
    auditResult,
  };
}
