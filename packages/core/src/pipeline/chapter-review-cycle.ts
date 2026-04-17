import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import type { ReviseOutput } from "../agents/reviser.js";
import type { WriteChapterOutput } from "../agents/writer.js";
import type { ContextPackage, RuleStack } from "../models/input-governance.js";
import type { LengthSpec } from "../models/length-governance.js";

export interface ChapterReviewCycleUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ChapterReviewCycleControlInput {
  readonly chapterIntent: string;
  readonly contextPackage: ContextPackage;
  readonly ruleStack: RuleStack;
}

export interface ChapterReviewCycleResult {
  readonly finalContent: string;
  readonly finalWordCount: number;
  readonly preAuditNormalizedWordCount: number;
  readonly revised: boolean;
  readonly auditResult: AuditResult;
  readonly totalUsage: ChapterReviewCycleUsage;
  readonly postReviseCount: number;
  readonly normalizeApplied: boolean;
}

export async function runChapterReviewCycle(params: {
  readonly book: Pick<{ genre: string }, "genre">;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly initialOutput: Pick<WriteChapterOutput, "content" | "wordCount" | "postWriteErrors">;
  readonly reducedControlInput?: ChapterReviewCycleControlInput;
  readonly lengthSpec: LengthSpec;
  readonly initialUsage: ChapterReviewCycleUsage;
  readonly createReviser: () => {
    reviseChapter: (
      bookDir: string,
      chapterContent: string,
      chapterNumber: number,
      issues: ReadonlyArray<AuditIssue>,
      mode: "spot-fix",
      genre?: string,
      options?: {
        chapterIntent?: string;
        contextPackage?: ContextPackage;
        ruleStack?: RuleStack;
        lengthSpec?: LengthSpec;
      },
    ) => Promise<ReviseOutput>;
  };
  readonly auditor: {
    auditChapter: (
      bookDir: string,
      chapterContent: string,
      chapterNumber: number,
      genre?: string,
      options?: {
        temperature?: number;
        chapterIntent?: string;
        contextPackage?: ContextPackage;
        ruleStack?: RuleStack;
      },
    ) => Promise<AuditResult>;
  };
  readonly normalizeDraftLengthIfNeeded: (chapterContent: string) => Promise<{
    content: string;
    wordCount: number;
    applied: boolean;
    tokenUsage?: ChapterReviewCycleUsage;
  }>;
  readonly assertChapterContentNotEmpty: (content: string, stage: string) => void;
  readonly addUsage: (
    left: ChapterReviewCycleUsage,
    right?: ChapterReviewCycleUsage,
  ) => ChapterReviewCycleUsage;
  readonly restoreLostAuditIssues: (previous: AuditResult, next: AuditResult) => AuditResult;
  readonly analyzeAITells: (content: string) => { issues: ReadonlyArray<AuditIssue> };
  readonly analyzeSensitiveWords: (content: string) => {
    found: ReadonlyArray<{ severity: string }>;
    issues: ReadonlyArray<AuditIssue>;
  };
  readonly logWarn: (message: { zh: string; en: string }) => void;
  readonly logStage: (message: { zh: string; en: string }) => void;
}): Promise<ChapterReviewCycleResult> {
  let totalUsage = params.initialUsage;
  let postReviseCount = 0;
  let normalizeApplied = false;
  let finalContent = params.initialOutput.content;
  let finalWordCount = params.initialOutput.wordCount;
  let revised = false;
  let revisionAttempts = 0;
  const MAX_REVISION_ATTEMPTS = 3;

  if (params.initialOutput.postWriteErrors.length > 0) {
    params.logWarn({
      zh: `检测到 ${params.initialOutput.postWriteErrors.length} 个后写错误，审计前触发 spot-fix 修补`,
      en: `${params.initialOutput.postWriteErrors.length} post-write errors detected, triggering spot-fix before audit`,
    });
    const reviser = params.createReviser();
    const spotFixIssues = params.initialOutput.postWriteErrors.map((violation) => ({
      severity: "critical" as const,
      category: violation.rule,
      description: violation.description,
      suggestion: violation.suggestion,
    }));
    const fixResult = await reviser.reviseChapter(
      params.bookDir,
      finalContent,
      params.chapterNumber,
      spotFixIssues,
      "spot-fix",
      params.book.genre,
      {
        ...params.reducedControlInput,
        lengthSpec: params.lengthSpec,
      },
    );
    totalUsage = params.addUsage(totalUsage, fixResult.tokenUsage);
    if (fixResult.revisedContent.length > 0) {
      finalContent = fixResult.revisedContent;
      finalWordCount = fixResult.wordCount;
      revised = true;
    }
  }

  const normalizedBeforeAudit = await params.normalizeDraftLengthIfNeeded(finalContent);
  totalUsage = params.addUsage(totalUsage, normalizedBeforeAudit.tokenUsage);
  finalContent = normalizedBeforeAudit.content;
  finalWordCount = normalizedBeforeAudit.wordCount;
  normalizeApplied = normalizeApplied || normalizedBeforeAudit.applied;
  params.assertChapterContentNotEmpty(finalContent, "draft generation");

  params.logStage({ zh: "审计草稿", en: "auditing draft" });
  const llmAudit = await params.auditor.auditChapter(
    params.bookDir,
    finalContent,
    params.chapterNumber,
    params.book.genre,
    params.reducedControlInput,
  );
  totalUsage = params.addUsage(totalUsage, llmAudit.tokenUsage);
  const aiTellsResult = params.analyzeAITells(finalContent);
  const sensitiveWriteResult = params.analyzeSensitiveWords(finalContent);
  const hasBlockedWriteWords = sensitiveWriteResult.found.some((item) => item.severity === "block");
  let auditResult: AuditResult = {
    passed: hasBlockedWriteWords ? false : llmAudit.passed,
    issues: [...llmAudit.issues, ...aiTellsResult.issues, ...sensitiveWriteResult.issues],
    summary: llmAudit.summary,
  };

  // Revision loop with attempt limit
  while (!auditResult.passed && revisionAttempts < MAX_REVISION_ATTEMPTS) {
    const criticalIssues = auditResult.issues.filter((issue) => issue.severity === "critical");
    const warningConcernIssues = auditResult.issues.filter(issue =>
      issue.severity === "warning" || issue.severity === "concern" || issue.severity === "fail"
    );
    const warningConcernCount = warningConcernIssues.length;

    // Count suggestions separately for debugging
    const suggestionCount = auditResult.issues.filter(issue => issue.severity === "suggestion").length;

    // Log all issues for debugging
    params.logWarn({
      zh: `所有问题详情 (${auditResult.issues.length}个):\n${auditResult.issues.map((i, index) => `${index + 1}. [${i.severity}] ${i.category}: ${i.description}`).join('\n')}`,
      en: `All issues details (${auditResult.issues.length} total):\n${auditResult.issues.map((i, index) => `${index + 1}. [${i.severity}] ${i.category}: ${i.description}`).join('\n')}`
    });

    // Log the analysis for debugging
    params.logWarn({
      zh: `audit-failed analysis (attempt ${revisionAttempts + 1}/${MAX_REVISION_ATTEMPTS}): critical=${criticalIssues.length}, warning+concern+fail=${warningConcernCount} (threshold=3), suggestions=${suggestionCount}`,
      en: `audit-failed analysis (attempt ${revisionAttempts + 1}/${MAX_REVISION_ATTEMPTS}): critical=${criticalIssues.length}, warning+concern+fail=${warningConcernCount} (threshold=3), suggestions=${suggestionCount}`
    });

    // Check if we should trigger revision
    const shouldRevise = criticalIssues.length > 0 || warningConcernCount > 3;
    if (!shouldRevise) {
      break; // No revision needed, exit loop
    }

    revisionAttempts++;
    const reviser = params.createReviser();

    if (criticalIssues.length > 0) {
      params.logStage({ zh: "自动修复关键问题", en: "auto-revising critical issues" });
      const reviseOutput = await reviser.reviseChapter(
        params.bookDir,
        finalContent,
        params.chapterNumber,
        auditResult.issues,
        "spot-fix",
        params.book.genre,
        {
          ...params.reducedControlInput,
          lengthSpec: params.lengthSpec,
        },
      );
      totalUsage = params.addUsage(totalUsage, reviseOutput.tokenUsage);

      if (reviseOutput.revisedContent.length > 0) {
        const normalizedRevision = await params.normalizeDraftLengthIfNeeded(reviseOutput.revisedContent);
        totalUsage = params.addUsage(totalUsage, normalizedRevision.tokenUsage);
        postReviseCount = normalizedRevision.wordCount;
        normalizeApplied = normalizeApplied || normalizedRevision.applied;

        const preMarkers = params.analyzeAITells(finalContent);
        const postMarkers = params.analyzeAITells(normalizedRevision.content);
        if (postMarkers.issues.length <= preMarkers.issues.length) {
          finalContent = normalizedRevision.content;
          finalWordCount = normalizedRevision.wordCount;
          revised = true;
          params.assertChapterContentNotEmpty(finalContent, "revision");
        }

        const reAudit = await params.auditor.auditChapter(
          params.bookDir,
          finalContent,
          params.chapterNumber,
          params.book.genre,
          params.reducedControlInput
            ? { ...params.reducedControlInput, temperature: 0 }
            : { temperature: 0 },
        );
        totalUsage = params.addUsage(totalUsage, reAudit.tokenUsage);
        const reAITells = params.analyzeAITells(finalContent);
        const reSensitive = params.analyzeSensitiveWords(finalContent);
        const reHasBlocked = reSensitive.found.some((item) => item.severity === "block");
        auditResult = params.restoreLostAuditIssues(auditResult, {
          passed: reHasBlocked ? false : reAudit.passed,
          issues: [...reAudit.issues, ...reAITells.issues, ...reSensitive.issues],
          summary: reAudit.summary,
        });
      }
    } else if (warningConcernCount > 3) {
      params.logStage({ zh: "auto-revising warning/concern/fail issues (count exceeded)", en: "auto-revising warning/concern/fail issues (count exceeded)" });
      params.logWarn({
        zh: `warning+concern+fail count (${warningConcernCount}) exceeds threshold (3), triggering auto-revision (attempt ${revisionAttempts}/${MAX_REVISION_ATTEMPTS})`,
        en: `warning+concern+fail count (${warningConcernCount}) exceeds threshold (3), triggering auto-revision (attempt ${revisionAttempts}/${MAX_REVISION_ATTEMPTS})`
      });

      // Pass warning, concern, fail, and suggestion issues to reviser
      const issuesToFix = auditResult.issues.filter(issue =>
        issue.severity === "warning" || issue.severity === "concern" || issue.severity === "fail" || issue.severity === "suggestion"
      );
      const reviseOutput = await reviser.reviseChapter(
        params.bookDir,
        finalContent,
        params.chapterNumber,
        issuesToFix,
        "spot-fix",
        params.book.genre,
        {
          ...params.reducedControlInput,
          lengthSpec: params.lengthSpec,
        },
      );
      totalUsage = params.addUsage(totalUsage, reviseOutput.tokenUsage);

      if (reviseOutput.revisedContent.length > 0) {
        const normalizedRevision = await params.normalizeDraftLengthIfNeeded(reviseOutput.revisedContent);
        totalUsage = params.addUsage(totalUsage, normalizedRevision.tokenUsage);
        postReviseCount = normalizedRevision.wordCount;
        normalizeApplied = normalizeApplied || normalizedRevision.applied;

        const preMarkers = params.analyzeAITells(finalContent);
        const postMarkers = params.analyzeAITells(normalizedRevision.content);
        if (postMarkers.issues.length <= preMarkers.issues.length) {
          finalContent = normalizedRevision.content;
          finalWordCount = normalizedRevision.wordCount;
          revised = true;
          params.assertChapterContentNotEmpty(finalContent, "revision");
        }

        const reAudit = await params.auditor.auditChapter(
          params.bookDir,
          finalContent,
          params.chapterNumber,
          params.book.genre,
          params.reducedControlInput
            ? { ...params.reducedControlInput, temperature: 0 }
            : { temperature: 0 },
        );
        totalUsage = params.addUsage(totalUsage, reAudit.tokenUsage);
        const reAITells = params.analyzeAITells(finalContent);
        const reSensitive = params.analyzeSensitiveWords(finalContent);
        const reHasBlocked = reSensitive.found.some((item) => item.severity === "block");
        auditResult = params.restoreLostAuditIssues(auditResult, {
          passed: reHasBlocked ? false : reAudit.passed,
          issues: [...reAudit.issues, ...reAITells.issues, ...reSensitive.issues],
          summary: reAudit.summary,
        });

        params.logWarn({
          zh: `警告修复完成：新的警告+关注+fail数量 = ${auditResult.issues.filter(i => i.severity === "warning" || i.severity === "concern" || i.severity === "fail").length}`,
          en: `warning-revision completed: new warning+concern+fail count = ${auditResult.issues.filter(i => i.severity === "warning" || i.severity === "concern" || i.severity === "fail").length}`
        });
      }
    }
  }

  // Log final status if max attempts reached
  if (!auditResult.passed && revisionAttempts >= MAX_REVISION_ATTEMPTS) {
    params.logWarn({
      zh: `达到最大修复次数限制 (${MAX_REVISION_ATTEMPTS})，停止自动修复`,
      en: `Maximum revision attempts (${MAX_REVISION_ATTEMPTS}) reached, stopping auto-revision`
    });
  }

  return {
    finalContent,
    finalWordCount,
    preAuditNormalizedWordCount: normalizedBeforeAudit.wordCount,
    revised,
    auditResult,
    totalUsage,
    postReviseCount,
    normalizeApplied,
  };
}
