import { BaseAgent } from "./base.js";

export enum ValidationSeverity {
  PASS = "pass",
  WARNING = "warning",
  CONCERN = "concern",
  FAIL = "fail"
}

export interface ValidationWarning {
  category: string;
  description: string;
  severity: ValidationSeverity;
}

export interface ValidationResult {
  warnings: ValidationWarning[];
  passed: boolean;
  severity: ValidationSeverity;
  details?: {
    state: { passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[] };
    hooks: { passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[] };
    timeline: { passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[] };
  };
}

/**
 * Validates Settler output by comparing old and new truth files via LLM.
 * Catches contradictions, missing state changes, and temporal inconsistencies.
 *
 * Uses a minimal verdict protocol instead of requiring structured JSON:
 *   Line 1: PASS or FAIL
 *   Remaining lines: free-form warnings (one per line, optional category prefix)
 */
export class StateValidatorAgent extends BaseAgent {
  get name(): string {
    return "state-validator";
  }

  async validate(
    chapterContent: string,
    chapterNumber: number,
    oldState: string,
    newState: string,
    oldHooks: string,
    newHooks: string,
    language: "zh" | "en" = "zh",
  ): Promise<ValidationResult> {
    const stateDiff = this.computeDiff(oldState, newState, "State Card");
    const hooksDiff = this.computeDiff(oldHooks, newHooks, "Hooks Pool");

    // Skip validation if nothing changed
    if (!stateDiff && !hooksDiff) {
      return { 
        warnings: [], 
        passed: true, 
        severity: ValidationSeverity.PASS 
      };
    }

    try {
      // 多轮对话验证
      const results = await this.performMultiRoundValidation(
        chapterContent,
        chapterNumber,
        stateDiff,
        hooksDiff,
        language
      );

      return this.combineValidationResults(results);
    } catch (error) {
      this.log?.warn(`State validation failed: ${error}`);
      throw error;
    }
  }

  private async performMultiRoundValidation(
    chapterContent: string,
    chapterNumber: number,
    stateDiff: string | null,
    hooksDiff: string | null,
    language: "zh" | "en"
  ): Promise<{
    state: { passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[] };
    hooks: { passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[] };
    timeline: { passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[] };
  }> {
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { 
        role: "system", 
        content: this.getBaseSystemPrompt(language) 
      }
    ];

    // 第1轮：建立上下文
    const contextPrompt = this.getContextPrompt(chapterNumber, chapterContent);
    messages.push({
      role: "user",
      content: contextPrompt
    });
    
    const contextResponse = await this.chat(messages, { temperature: 0.1, maxTokens: 1000 });
    
    // 添加调试日志：打印上下文建立的LLM回复
    this.log?.info(`[DEBUG] Context Round - LLM Response: ${JSON.stringify(contextResponse.content)}`);
    
    messages.push({ role: "assistant", content: contextResponse.content });

    // 第2轮：状态验证
    let stateResult: { passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[] };
    try {
      stateResult = await this.validateStateRound(messages, stateDiff, language);
      messages.push({ role: "assistant", content: "状态验证完成" });
    } catch (error) {
      this.log?.warn(`State Round failed: ${error}`);
      stateResult = { passed: true, severity: ValidationSeverity.PASS, warnings: [] };
      messages.push({ role: "assistant", content: "状态验证失败" });
    }

    // 第3轮：伏笔验证
    let hookResult: { passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[] };
    try {
      hookResult = await this.validateHooksRound(messages, hooksDiff, language);
      messages.push({ role: "assistant", content: "伏笔验证完成" });
    } catch (error) {
      this.log?.warn(`Hooks Round failed: ${error}`);
      hookResult = { passed: true, severity: ValidationSeverity.PASS, warnings: [] };
      messages.push({ role: "assistant", content: "伏笔验证失败" });
    }

    // 第4轮：时间线验证
    let timelineResult: { passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[] };
    try {
      timelineResult = await this.validateTimelineRound(messages, chapterContent, language);
    } catch (error) {
      this.log?.warn(`Timeline Round failed: ${error}`);
      timelineResult = { passed: true, severity: ValidationSeverity.PASS, warnings: [] };
    }

    return {
      state: stateResult,
      hooks: hookResult,
      timeline: timelineResult
    };
  }

  private getBaseSystemPrompt(language: "zh" | "en"): string {
    return language === "en"
      ? `IMPORTANT INSTRUCTION: You are a continuity validator for a novel writing system.

REQUIREMENTS:
- Do not output thinking process
- Provide validation results directly
- Use concise verdict format

VALIDATION LEVELS:
- FAIL: Only for HARD contradictions (death + acting, time backward, etc.)
- WARNING: Minor issues (±10% differences, missing reasonable details)
- CONCERN: Moderate issues (significant but acceptable deviations)
- PASS: Perfect validation

OUTPUT FORMAT:
First line MUST be exactly: PASS or WARNING or CONCERN or FAIL
Following lines: [category] description (if issues)

Focus on validation, provide results directly.

Hard contradictions (FAIL only):
- Character dies but continues acting
- Time flows backward or impossible jumps  
- Location changes without transition
- Hooks disappear without resolution marking
- Complete logical contradictions

Minor issues (WARNING):
- Slight numerical differences (±10%)
- Missing but reasonable details
- Slightly ahead-of-text inferences

Moderate issues (CONCERN):
- Significant but acceptable deviations
- Missing important details
- Reasonable extrapolations without direct text support`
      : `重要指令：你是小说连续性验证器，需要多轮验证内容。

输出要求：
- 不要输出<THINK>思考过程标签
- 提供结构化的验证结果
- 包含必要的分析依据

验证等级：
- FAIL：仅硬矛盾（死亡+活动、时间倒流等）
- WARNING：轻微问题（±10%差异、缺失合理细节）
- CONCERN：中等问题（显著但可接受的偏差）
- PASS：完美验证

输出格式：
第一行必须是：PASS 或 WARNING 或 CONCERN 或 FAIL
后续行：[类别] 详细描述（支持多行分析）
可选类别：[分析]、[依据]、[建议]、[伏笔内容]、[数值矛盾]等

请专注验证，直接给出结果。

硬矛盾（仅FAIL）：
- 角色死亡但继续活动
- 时间倒流或不可能跳跃
- 位置变化无过渡
- 伏笔消失无解决标记
- 完全逻辑矛盾

轻微问题（WARNING）：
- 轻微数字差异（±10%）
- 缺失但合理的细节
- 略微超前的文本推断

中等问题（CONCERN）：
- 显著但可接受的偏差
- 缺失重要细节
- 合理推断但无直接文本支持`;
  }

  private getContextPrompt(chapterNumber: number, chapterContent: string): string {
    return `这是第${chapterNumber}章的验证任务。

章节内容摘要：
${chapterContent.slice(0, 2000)}...

请确认已理解章节背景和主要内容。回复"已理解"即可。`;
  }

  private async validateStateRound(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    stateDiff: string | null,
    language: "zh" | "en"
  ): Promise<{ passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[] }> {
    if (!stateDiff) {
      return { passed: true, severity: ValidationSeverity.PASS, warnings: [] };
    }

    const statePrompt = language === "en"
      ? `Now validate STATE CHANGES:

${stateDiff}

Check for:
1. State changes without narrative support
2. Missing state changes  
3. Temporal impossibilities
4. Character status contradictions

Output format: PASS | WARNING | CONCERN | FAIL`
      : `现在验证状态变更：

${stateDiff}

检查：
1. 状态变更无叙事支持
2. 缺失状态变更
3. 时间不可能性
4. 角色状态矛盾

输出格式：PASS | WARNING | CONCERN | FAIL`;

    messages.push({ role: "user", content: statePrompt });
    
    const response = await this.chat(messages, { temperature: 0.1, maxTokens: 2000 });
    
    // 添加调试日志：打印状态验证的LLM回复
    this.log?.info(`[DEBUG] State Round - LLM Response: ${JSON.stringify(response.content)}`);
    
    return this.parseRoundResult(response.content, "state");
  }

  private async validateHooksRound(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    hooksDiff: string | null,
    language: "zh" | "en"
  ): Promise<{ passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[] }> {
    if (!hooksDiff) {
      return { passed: true, severity: ValidationSeverity.PASS, warnings: [] };
    }

    const hooksPrompt = language === "en"
      ? `Now validate HOOK CHANGES:

${hooksDiff}

Check for:
1. Hooks disappeared without resolution marking
2. New hooks without chapter basis
3. Hook progression inconsistencies
4. Hook timeline violations

Output format: PASS | WARNING | CONCERN | FAIL`
      : `现在验证伏笔变更：

${hooksDiff}

检查：
1. 伏笔消失无解决标记
2. 新伏笔无章节依据
3. 伏笔推进不一致
4. 伏笔时间线违规

输出格式：PASS | WARNING | CONCERN | FAIL`;

    messages.push({ role: "user", content: hooksPrompt });
    
    const response = await this.chat(messages, { temperature: 0.1, maxTokens: 2000 });
    
    // 添加调试日志：打印伏笔验证的LLM回复
    this.log?.info(`[DEBUG] Hooks Round - LLM Response: ${JSON.stringify(response.content)}`);
    
    return this.parseRoundResult(response.content, "hooks");
  }

  private async validateTimelineRound(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    chapterContent: string,
    language: "zh" | "en"
  ): Promise<{ passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[] }> {
    const timelinePrompt = language === "en"
      ? `Now validate TIMELINE CONSISTENCY:

Chapter content: ${chapterContent.slice(0, 3000)}...

Check for:
1. Event sequence logic
2. Time flow consistency
3. Location transition合理性
4. Action causality

Output format: PASS | WARNING | CONCERN | FAIL`
      : `现在验证时间线一致性：

章节内容：${chapterContent.slice(0, 3000)}...

检查：
1. 事件序列逻辑
2. 时间流逝一致性
3. 位置过渡合理性
4. 行为因果关系

输出格式：PASS | WARNING | CONCERN | FAIL`;

    messages.push({ role: "user", content: timelinePrompt });
    
    const response = await this.chat(messages, { temperature: 0.1, maxTokens: 2000 });
    
    // 添加调试日志：打印时间线验证的LLM回复
    this.log?.info(`[DEBUG] Timeline Round - LLM Response: ${JSON.stringify(response.content)}`);
    
    return this.parseRoundResult(response.content, "timeline");
  }

  private parseRoundResult(content: string, category: string): { 
    passed: boolean; 
    severity: ValidationSeverity; 
    warnings: ValidationWarning[] 
  } {
    // 首先过滤掉<THINK>标签内容（支持大小写）
    const filteredContent = content.replace(/<THINK>[\s\S]*?<\/THINK>/gi, '').trim();
    
    const trimmed = filteredContent.trim();
    if (!trimmed) {
      throw new Error("LLM returned empty response");
    }

    const lines = trimmed.split("\n").map(line => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      throw new Error("LLM returned empty response");
    }

    // Find the first line that doesn't contain THINK tags
    let verdictLine = "";
    for (const line of lines) {
      if (!line.includes("<THINK>") && !line.includes("</THINK>")) {
        verdictLine = line.toUpperCase();
        break;
      }
    }
    
    if (!verdictLine) {
      throw new Error("No valid verdict found after filtering THINK tags");
    }
    
    // 解析严重程度
    let severity: ValidationSeverity;
    let passed: boolean;

    if (verdictLine.includes("FAIL")) {
      severity = ValidationSeverity.FAIL;
      passed = false;
    } else if (verdictLine.includes("CONCERN")) {
      severity = ValidationSeverity.CONCERN;
      passed = true; // CONCERN仍然通过，但有警告
    } else if (verdictLine.includes("WARNING")) {
      severity = ValidationSeverity.WARNING;
      passed = true; // WARNING仍然通过，但有警告
    } else if (verdictLine.includes("PASS")) {
      severity = ValidationSeverity.PASS;
      passed = true;
    } else {
      throw new Error(`Invalid verdict: ${verdictLine}`);
    }

    const warnings: ValidationWarning[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line) continue; // 跳过空行
      if (line.includes("PASS") || line.includes("FAIL") || line.includes("WARNING") || line.includes("CONCERN")) {
        // 如果是verdict行，跳过但继续处理其他行
        continue;
      }

      const categoryMatch = line.match(/^\[([^\]]+)\]\s*(.+)$/);
      if (categoryMatch) {
        warnings.push({
          category: categoryMatch[1]!.trim(),
          description: categoryMatch[2]!.trim(),
          severity: severity
        });
      } else if (line.length > 5) {
        warnings.push({
          category: category,
          description: line,
          severity: severity
        });
      }
    }

    return { passed, severity, warnings };
  }

  private combineValidationResults(results: {
    state: { passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[] };
    hooks: { passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[] };
    timeline: { passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[] };
  }): ValidationResult {
    // 检查是否有硬矛盾（FAIL）
    const hasHardContradiction = 
      results.state.severity === ValidationSeverity.FAIL ||
      results.hooks.severity === ValidationSeverity.FAIL ||
      results.timeline.severity === ValidationSeverity.FAIL;

    // 计算整体严重程度
    const severities = [
      results.state.severity,
      results.hooks.severity, 
      results.timeline.severity
    ];

    let overallSeverity: ValidationSeverity;
    if (hasHardContradiction) {
      overallSeverity = ValidationSeverity.FAIL;
    } else if (severities.some(s => s === ValidationSeverity.CONCERN)) {
      overallSeverity = ValidationSeverity.CONCERN;
    } else if (severities.some(s => s === ValidationSeverity.WARNING)) {
      overallSeverity = ValidationSeverity.WARNING;
    } else {
      overallSeverity = ValidationSeverity.PASS;
    }

    // 合并所有警告
    const allWarnings = [
      ...results.state.warnings,
      ...results.hooks.warnings,
      ...results.timeline.warnings
    ];

    // 计算WARNING和CONCERN数量，超过阈值则审计失败
    const warningConcernCount = allWarnings.filter(w => 
      w.severity === ValidationSeverity.WARNING || 
      w.severity === ValidationSeverity.CONCERN
    ).length;

    const hasTooManyWarnings = warningConcernCount >= 3;

    return {
      passed: !hasHardContradiction && !hasTooManyWarnings,
      severity: overallSeverity,
      warnings: allWarnings,
      details: results
    };
  }

  private computeDiff(oldText: string, newText: string, label: string): string | null {
    if (oldText === newText) return null;

    const oldLines = oldText.split("\n").filter((l) => l.trim());
    const newLines = newText.split("\n").filter((l) => l.trim());

    const added = newLines.filter((l) => !oldLines.includes(l));
    const removed = oldLines.filter((l) => !newLines.includes(l));

    if (added.length === 0 && removed.length === 0) return null;

    const parts = [`### ${label}`];
    if (removed.length > 0) parts.push("Removed:\n" + removed.map((l) => `- ${l}`).join("\n"));
    if (added.length > 0) parts.push("Added:\n" + added.map((l) => `+ ${l}`).join("\n"));
    return parts.join("\n");
  }

  private parseResult(content: string): ValidationResult {
    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error("LLM returned empty response");
    }

    const jsonResult = this.tryParseJsonResult(trimmed);
    if (jsonResult) {
      return jsonResult;
    }

    const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      throw new Error("LLM returned empty response");
    }

    const verdictLine = lines[0]!.toUpperCase();
    
    // 解析严重程度
    let severity: ValidationSeverity;
    let passed: boolean;

    if (verdictLine.includes("FAIL")) {
      severity = ValidationSeverity.FAIL;
      passed = false;
    } else if (verdictLine.includes("CONCERN")) {
      severity = ValidationSeverity.CONCERN;
      passed = true;
    } else if (verdictLine.includes("WARNING")) {
      severity = ValidationSeverity.WARNING;
      passed = true;
    } else if (verdictLine.includes("PASS")) {
      severity = ValidationSeverity.PASS;
      passed = true;
    } else {
      throw new Error(`Invalid verdict: ${verdictLine}`);
    }

    const warnings: ValidationWarning[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.includes("PASS") || line.includes("FAIL") || line.includes("WARNING") || line.includes("CONCERN")) continue;

      const categoryMatch = line.match(/^\[([^\]]+)\]\s*(.+)$/);
      if (categoryMatch) {
        warnings.push({
          category: categoryMatch[1]!.trim(),
          description: categoryMatch[2]!.trim(),
          severity: severity
        });
      } else if (line.startsWith("- ") || line.startsWith("* ")) {
        warnings.push({
          category: "general",
          description: line.slice(2).trim(),
          severity: severity
        });
      } else if (line.length > 5) {
        warnings.push({
          category: "general",
          description: line,
          severity: severity
        });
      }
    }

    return { warnings, passed, severity };
  }

  private tryParseJsonResult(text: string): ValidationResult | null {
    const direct = this.tryParseExactJsonResult(text);
    if (direct) {
      return direct;
    }

    const candidate = extractBalancedJsonObject(text);
    if (!candidate) {
      return null;
    }
    return this.tryParseExactJsonResult(candidate);
  }

  private tryParseExactJsonResult(text: string): ValidationResult | null {
    try {
      const parsed = JSON.parse(text) as {
        warnings?: Array<{ category?: string; description?: string }>;
        passed?: boolean;
      };
      if (typeof parsed.passed !== "boolean") return null;
      return {
        warnings: (parsed.warnings ?? []).map((w) => ({
          category: w.category ?? "unknown",
          description: w.description ?? "",
          severity: ValidationSeverity.WARNING
        })),
        passed: parsed.passed,
        severity: parsed.passed ? ValidationSeverity.PASS : ValidationSeverity.FAIL
      };
    } catch {
      return null;
    }
  }
}

function extractBalancedJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let endIndex = -1;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        endIndex = index;
        break;
      }
      if (depth < 0) {
        return null;
      }
    }
  }

  if (endIndex < 0) return null;

  // Only accept the candidate if what follows the closing brace is
  // nothing, whitespace, or a structural JSON terminator.
  // This rejects trailing content like "{...} more text here"
  const followingChar = text[endIndex + 1];
  if (
    followingChar !== undefined &&
    followingChar !== "\n" &&
    followingChar !== "\r" &&
    followingChar !== "\t" &&
    followingChar !== " " &&
    followingChar !== "," &&
    followingChar !== "]" &&
    followingChar !== "}"
  ) {
    return null;
  }

  return text.slice(start, endIndex + 1);
}
