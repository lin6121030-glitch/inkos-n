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

export interface FixSuggestion {
  category: string;
  issue: string;
  suggestion: string;
  priority: "high" | "medium" | "low";
  autoFixable: boolean;
}

export interface ValidationResult {
  warnings: ValidationWarning[];
  passed: boolean;
  severity: ValidationSeverity;
  fixSuggestions?: FixSuggestion[];
  details?: {
    state: { passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[]; fixSuggestions: FixSuggestion[] };
    hooks: { passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[]; fixSuggestions: FixSuggestion[] };
    timeline: { passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[]; fixSuggestions: FixSuggestion[] };
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
    state: { passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[]; fixSuggestions: FixSuggestion[] };
    hooks: { passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[]; fixSuggestions: FixSuggestion[] };
    timeline: { passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[]; fixSuggestions: FixSuggestion[] };
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
    
    messages.push({ role: "assistant", content: contextResponse.content });

    // 第2轮：状态验证
    let stateResult: { passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[]; fixSuggestions: FixSuggestion[] };
    try {
      stateResult = await this.validateStateRound(messages, stateDiff, language);
      messages.push({ role: "assistant", content: "状态验证完成" });
    } catch (error) {
      this.log?.warn(`State Round failed: ${error}`);
      stateResult = { passed: true, severity: ValidationSeverity.PASS, warnings: [], fixSuggestions: [] };
      messages.push({ role: "assistant", content: "状态验证失败" });
    }

    // 第3轮：伏笔验证
    let hookResult: { passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[]; fixSuggestions: FixSuggestion[] };
    try {
      hookResult = await this.validateHooksRound(messages, hooksDiff, language);
      messages.push({ role: "assistant", content: "伏笔验证完成" });
    } catch (error) {
      this.log?.warn(`Hooks Round failed: ${error}`);
      hookResult = { passed: true, severity: ValidationSeverity.PASS, warnings: [], fixSuggestions: [] };
      messages.push({ role: "assistant", content: "伏笔验证失败" });
    }

    // 第4轮：时间线验证
    let timelineResult: { passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[]; fixSuggestions: FixSuggestion[] };
    try {
      timelineResult = await this.validateTimelineRound(messages, chapterContent, language);
    } catch (error) {
      this.log?.warn(`Timeline Round failed: ${error}`);
      timelineResult = { passed: false, severity: ValidationSeverity.FAIL, warnings: [], fixSuggestions: [] };
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

VALIDATION LEVEL CRITERIA:
- FAIL: Hard contradictions (character dies but continues acting, time flows backward, location changes without transition)
- WARNING: Significant issues that affect story logic (numerical contradictions, serious state-text mismatches, critical hook management errors)
- CONCERN: Minor issues that don't affect main plot (reasonable inferences, missing details, minor inconsistencies)
- PASS: Correct operations (appropriate state updates, proper hook progression, sufficient text support)

Please judge each specific issue's severity based on its actual impact and choose the most appropriate level.

OUTPUT FORMAT:
First line MUST be exactly: VERDICT_PASS or VERDICT_WARNING or VERDICT_CONCERN or VERDICT_FAIL
Following lines: [category] [severity] description (if issues)
Severity options: PASS, WARNING, CONCERN, FAIL

Note: Do not use ** symbols, use VERDICT_PASS format directly

Focus on validation, provide results directly.`
      : `重要指令：你是小说连续性验证器，需要多轮验证内容。

输出要求：
- 不要输出<THINK>思考过程标签
- 提供结构化的验证结果
- 包含必要的分析依据

验证等级判断标准：
- FAIL：硬矛盾（角色死亡但继续活动、时间倒流、位置无过渡、伏笔消失无解决标记、完全逻辑矛盾等）
- WARNING：显著问题（影响故事逻辑的重要错误，如数值矛盾、状态与文本不符、伏笔管理错误、缺失细节、时间推断过度等）
- CONCERN：轻微问题（不影响主线的小偏差，如合理推断、细节缺失、微小偏差、叙事支持、建议等）
- PASS：正确操作（状态更新合理、伏笔推进正确、文本依据充分、时间线一致、事件逻辑清晰等）

请根据具体问题内容，自行判断其严重程度，选择最合适的级别。

输出格式：
第一行必须是：VERDICT_PASS 或 VERDICT_WARNING 或 VERDICT_CONCERN 或 VERDICT_FAIL
后续行：[类别] [严重程度] 详细描述（支持多行分析）
严重程度选项：PASS、WARNING、CONCERN、FAIL
可选类别：[分析]、[依据]、[建议]、[伏笔内容]、[数值矛盾]等

示例：
WARNING
[数值矛盾] WARNING: 炼气三层进度23%→31%，单章内增长8%，无修炼行为描写
[叙事支持] CONCERN: "警觉不安"情绪有叙事支持，直播被中断
[伏笔升级] PASS: H005"神秘组织特别针对小组"有章节暗示（天机阁永久封禁），升级合理

请专注验证，直接给出结果。`;
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
  ): Promise<{ passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[]; fixSuggestions: FixSuggestion[] }> {
    if (!stateDiff) {
      return { passed: true, severity: ValidationSeverity.PASS, warnings: [], fixSuggestions: [] };
    }

    const statePrompt = language === "en"
      ? `Now validate STATE CHANGES:

${stateDiff}

Check for:
1. State changes without narrative support
2. Missing state changes  
3. Temporal impossibilities
4. Character status contradictions

Output format: VERDICT_PASS or VERDICT_WARNING or VERDICT_CONCERN or VERDICT_FAIL
后续行：[category] [severity] description（如果有问题）

注意：不要使用**符号，直接用VERDICT_PASS格式`
      : `现在验证状态变更

${stateDiff}

检查：
1. 状态变更无叙事支持
2. 缺失状态变更
3. 时间不可能性
4. 角色状态矛盾

输出格式：VERDICT_PASS 或 VERDICT_WARNING 或 VERDICT_CONCERN 或 VERDICT_FAIL
后续行：[category] [severity] description（如果有问题）

注意：不要使用**符号，直接用VERDICT_PASS格式`;

    messages.push({ role: "user", content: statePrompt });
    
    const response = await this.chat(messages, { temperature: 0.1, maxTokens: 2000 });
    
    const result = this.parseRoundResult(response.content, "state");
    return {
      passed: result.passed,
      severity: result.severity,
      warnings: result.warnings,
      fixSuggestions: result.fixSuggestions
    };
  }

  private async validateHooksRound(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    hooksDiff: string | null,
    language: "zh" | "en"
  ): Promise<{ passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[]; fixSuggestions: FixSuggestion[] }> {
    if (!hooksDiff) {
      return { passed: true, severity: ValidationSeverity.PASS, warnings: [], fixSuggestions: [] };
    }

    const hooksPrompt = language === "en"
      ? `Now validate HOOK CHANGES:

${hooksDiff}

Check for:
1. Hooks disappeared without resolution marking
2. New hooks without chapter basis
3. Hook progression inconsistencies
4. Hook timeline violations

Output format: VERDICT_PASS or VERDICT_WARNING or VERDICT_CONCERN or VERDICT_FAIL
后续行：[category] [severity] description（如果有问题）

注意：不要使用**符号，直接用VERDICT_PASS格式`
      : `现在验证伏笔变更：

${hooksDiff}

检查：
1. 伏笔消失无解决标记
2. 新伏笔无章节依据
3. 伏笔推进不一致
4. 伏笔时间线违规

输出格式：VERDICT_PASS 或 VERDICT_WARNING 或 VERDICT_CONCERN 或 VERDICT_FAIL
后续行：[category] [severity] description（如果有问题）

注意：不要使用**符号，直接用VERDICT_PASS格式`

    messages.push({ role: "user", content: hooksPrompt });
    
    const response = await this.chat(messages, { temperature: 0.1, maxTokens: 2000 });
    
    const result = this.parseRoundResult(response.content, "hooks");
    return {
      passed: result.passed,
      severity: result.severity,
      warnings: result.warnings,
      fixSuggestions: result.fixSuggestions
    };
  }

  private async validateTimelineRound(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    chapterContent: string,
    language: "zh" | "en"
  ): Promise<{ passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[]; fixSuggestions: FixSuggestion[] }> {
    const timelinePrompt = language === "en"
      ? `Now validate TIMELINE CONSISTENCY:

Chapter content: ${chapterContent.slice(0, 3000)}...

Check for:
1. Event sequence logic
2. Time flow consistency
3. Location transition合理性
4. Action causality

Output format: VERDICT_PASS or VERDICT_WARNING or VERDICT_CONCERN or VERDICT_FAIL
后续行：[category] [severity] description（如果有问题）

注意：不要使用**符号，直接用VERDICT_PASS格式`
      : `现在验证时间线一致性：

章节内容：${chapterContent.slice(0, 3000)}...

检查：
1. 事件序列逻辑
2. 时间流逝一致性
3. 位置过渡合理性
4. 行为因果关系

输出格式：
第一行必须是：VERDICT_PASS 或 VERDICT_WARNING 或 VERDICT_CONCERN 或 VERDICT_FAIL
后续行：[category] [severity] description（如果有问题）

注意：不要使用**符号，直接用VERDICT_PASS格式`;

    messages.push({ role: "user", content: timelinePrompt });
    
    const response = await this.chat(messages, { temperature: 0.1, maxTokens: 2000 });
    
    const result = this.parseRoundResult(response.content, "timeline");
    return {
      passed: result.passed,
      severity: result.severity,
      warnings: result.warnings,
      fixSuggestions: result.fixSuggestions
    };
  }

  private parseRoundResult(content: string, category: string): { 
    passed: boolean; 
    severity: ValidationSeverity; 
    warnings: ValidationWarning[];
    fixSuggestions: FixSuggestion[];
  } {
    // 添加调试日志：显示LLM原始输出
    this.log?.info(`[state-validator] [DEBUG] ${category} Round LLM原始输出:`);
    this.log?.info(`[state-validator] [DEBUG] ${JSON.stringify(content)}`);
    
    // Enhanced THINK tag filtering - handle multiple variations
    let filteredContent = content
      .replace(/<THINK>[\s\S]*?<\/THINK>/gi, '') // Complete THINK blocks
      .replace(/<THINK>[\s\S]*/gi, '') // Incomplete THINK blocks (no closing tag)
      .replace(/[\s\S]*?<\/THINK>/gi, '') // Incomplete THINK blocks (no opening tag)
      .replace(/<think>[\s\S]*?<\/think>/gi, '') // Lowercase variant
      .replace(/<Think>[\s\S]*?<\/Think>/gi, '') // Mixed case variant
      .replace(/<THINK>.*/gi, '') // Any line starting with <THINK>
      .replace(/.*<\/THINK>/gi, '') // Any line ending with </THINK>
      .trim();
    
    const trimmed = filteredContent.replace(/\n{3,}/g, "\n\n").trim();
    const lines = trimmed.split("\n").map(line => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      throw new Error("LLM returned empty response");
    }

    // Find the first valid verdict line (skip any remaining THINK content)
    let verdictLine = "";
    for (const line of lines) {
      const upperLine = line.toUpperCase();
      // Skip any line with THINK tags (case-insensitive)
      if (upperLine.includes("<THINK>") || upperLine.includes("</THINK>")) {
        continue;
      }
      // Skip empty THINK-like content
      if (line.match(/^think|thinking|analysis|reasoning/i)) {
        continue;
      }

      if (upperLine.startsWith("VERDICT_")) {
        verdictLine = upperLine;
        break;
      }
    }
    
    if (!verdictLine) {
      throw new Error("No valid verdict found after filtering THINK tags");
    }
    
    // 解析严重程度
    let severity: ValidationSeverity;
    let passed: boolean;

    if (verdictLine.includes("VERDICT_FAIL")) {
      severity = ValidationSeverity.FAIL;
      passed = false;
    } else if (verdictLine.includes("VERDICT_CONCERN")) {
      severity = ValidationSeverity.CONCERN;
      passed = true; // CONCERN仍然通过，但有警告
    } else if (verdictLine.includes("VERDICT_WARNING")) {
      severity = ValidationSeverity.WARNING;
      passed = true; // WARNING仍然通过，但有警告
    } else if (verdictLine.includes("VERDICT_PASS")) {
      severity = ValidationSeverity.PASS;
      passed = true;
    } else {
      throw new Error(`Invalid verdict: ${verdictLine}`);
    }

    const warnings: ValidationWarning[] = [];
    const fixSuggestions: FixSuggestion[] = [];
    let inFixSection = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line) continue; // 跳过空行
      if (line.includes("VERDICT_PASS") || line.includes("VERDICT_FAIL") || line.includes("VERDICT_WARNING") || line.includes("VERDICT_CONCERN")) {
        // 如果是verdict行，跳过但继续处理其他行
        continue;
      }

      const suggestionMatch = line.match(/^\[([^\]]+)\]\s*(修正建议|建议修正):\s*(.+)$/)
      if (suggestionMatch) {
        inFixSection = true;
        continue;
      }
      // Handle warnings
      const warningMatch = line.match(/^\[([^\]]+)\]\s*(WARNING|CONCERN|PASS|FAIL):\s*(.+)$/);
      if (warningMatch) {
        // Keep the full description including fix suggestions
        let description = warningMatch[3]!.trim();
        // Don't separate fix suggestions, keep them in description
       description = description.replace(/\s+(?:修正建议|建议修正)[\s\S]*$/, '').trim();
        warnings.push({
          category: warningMatch[1]!.trim(),
          description: description,
          severity: this.mapSeverity(warningMatch[2])
        });
        continue;
      }
      

      // 3. 如果在修正建议部分，解析编号列表项
      if (inFixSection) {
        const fixMatch = line.match(/^(\d+)\.\s+\*\*(.+?)\*\*：\s*(.*)$/);
        if (fixMatch) {
          fixSuggestions.push({
            category: fixMatch[1]!.trim(),
            issue: fixMatch[3]!.trim(),
            suggestion: fixMatch[3]!.trim(),  // 或者需要进一步解析
            priority: "medium",  // 默认值
            autoFixable: true    // 默认值
          });
        }
        // 如果修正建议的描述跨行，可根据需要在此处追加内容（你的示例中每行完整，暂不处理）
        continue;
      }
    
    }

    return { passed, severity, warnings, fixSuggestions };
  }

    private mapSeverity(severityStr: string): ValidationSeverity {
    switch (severityStr.toUpperCase()) {
      case "FAIL":
        return ValidationSeverity.FAIL;
      case "WARNING":
        return ValidationSeverity.WARNING;
      case "CONCERN":
        return ValidationSeverity.CONCERN;
      case "PASS":
        return ValidationSeverity.PASS;
      default:
        return ValidationSeverity.WARNING; // 默认值
    }
  }

  private combineValidationResults(results: {
    state: { passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[]; fixSuggestions: FixSuggestion[] };
    hooks: { passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[]; fixSuggestions: FixSuggestion[] };
    timeline: { passed: boolean; severity: ValidationSeverity; warnings: ValidationWarning[]; fixSuggestions: FixSuggestion[] };
  }): ValidationResult {
    // 添加调试日志：分析各轮验证结果
    const statePassCount = results.state.warnings.filter(w => w.severity === ValidationSeverity.PASS).length;
    const stateWarningCount = results.state.warnings.filter(w => w.severity === ValidationSeverity.WARNING).length;
    const stateConcernCount = results.state.warnings.filter(w => w.severity === ValidationSeverity.CONCERN).length;
    const stateFailCount = results.state.warnings.filter(w => w.severity === ValidationSeverity.FAIL).length;
    this.log?.info(`[state-validator] [DEBUG] 多轮验证结果分析:`);
    this.log?.info(`[state-validator] [DEBUG] State Round: passed=${results.state.passed}, severity=${results.state.severity},  PASS=${statePassCount}, WARNING=${stateWarningCount}, CONCERN=${stateConcernCount}, FAIL=${stateFailCount}`);
    this.log?.info(`[state-validator] [DEBUG] Hooks Round: passed=${results.hooks.passed}, severity=${results.hooks.severity},  PASS=${statePassCount}, WARNING=${stateWarningCount}, CONCERN=${stateConcernCount}, FAIL=${stateFailCount}`);
    this.log?.info(`[state-validator] [DEBUG] Timeline Round: passed=${results.timeline.passed}, severity=${results.timeline.severity},  PASS=${statePassCount}, WARNING=${stateWarningCount}, CONCERN=${stateConcernCount}, FAIL=${stateFailCount}`);
    
    // 检查是否有硬矛盾（FAIL）
    const hasHardContradiction = 
      results.state.severity === ValidationSeverity.FAIL ||
      results.hooks.severity === ValidationSeverity.FAIL ||
      results.timeline.severity === ValidationSeverity.FAIL;
    
    this.log?.info(`[state-validator] [DEBUG] 硬矛盾检查: hasHardContradiction=${hasHardContradiction}`);

    // 计算整体严重程度
    const severities = [
      results.state.severity,
      results.hooks.severity, 
      results.timeline.severity
    ];

    let overallSeverity: ValidationSeverity;
    if (hasHardContradiction) {
      overallSeverity = ValidationSeverity.FAIL;
    } else if (severities.some(s => s === ValidationSeverity.WARNING)) {
      overallSeverity = ValidationSeverity.WARNING;  // 先检查WARNING
    } else if (severities.some(s => s === ValidationSeverity.CONCERN)) {
      overallSeverity = ValidationSeverity.CONCERN;  // 再检查CONCERN
    } else {
      overallSeverity = ValidationSeverity.PASS;
    }

    // 添加调试日志：显示各轮warnings的详细内容
    this.log?.info(`[state-validator] [DEBUG] State Round warnings详情:`);
    results.state.warnings.forEach(w => this.log?.info(`[state-validator] [DEBUG]   [${w.severity}] [${w.category}] ${w.description}`));
    
    this.log?.info(`[state-validator] [DEBUG] Hooks Round warnings详情:`);
    results.hooks.warnings.forEach(w => this.log?.info(`[state-validator] [DEBUG]   [${w.severity}] [${w.category}] ${w.description}`));
    
    this.log?.info(`[state-validator] [DEBUG] Timeline Round warnings details:`);
    results.timeline.warnings.forEach(w => this.log?.info(`[state-validator] [DEBUG]   [${w.severity}] [${w.category}] ${w.description}`));

    // Log fix suggestions
    this.log?.info(`[state-validator] [DEBUG] State Round fix suggestions: ${results.state.fixSuggestions.length}`);
    results.state.fixSuggestions.forEach(f => this.log?.info(`[state-validator] [DEBUG]   [${f.category}] ${f.suggestion}`));
    
    this.log?.info(`[state-validator] [DEBUG] Hooks Round fix suggestions: ${results.hooks.fixSuggestions.length}`);
    results.hooks.fixSuggestions.forEach(f => this.log?.info(`[state-validator] [DEBUG]   [${f.category}] ${f.suggestion}`));
    
    this.log?.info(`[state-validator] [DEBUG] Timeline Round fix suggestions: ${results.timeline.fixSuggestions.length}`);
    results.timeline.fixSuggestions.forEach(f => this.log?.info(`[state-validator] [DEBUG]   [${f.category}] ${f.suggestion}`));

    // Merge all warnings, but filter out PASS items (PASS is not a problem, no need to pass)
    const allWarnings = [
      ...results.state.warnings.filter(w => w.severity !== ValidationSeverity.PASS),
      ...results.hooks.warnings.filter(w => w.severity !== ValidationSeverity.PASS),
      ...results.timeline.warnings.filter(w => w.severity !== ValidationSeverity.PASS)
    ];

    // Merge all fix suggestions
    const allFixSuggestions = [
      ...results.state.fixSuggestions,
      ...results.hooks.fixSuggestions,
      ...results.timeline.fixSuggestions
    ];
    
    this.log?.info(`[state-validator] [DEBUG] 过滤PASS项后的warnings数量: ${allWarnings.length}`);
    allWarnings.forEach(w => this.log?.info(`[state-validator] [DEBUG]   [${w.severity}] [${w.category}] ${w.description}`));

    // 计算WARNING和CONCERN数量，超过阈值则审计失败
    const warningConcernCount = allWarnings.filter(w => 
      w.severity === ValidationSeverity.WARNING || 
      w.severity === ValidationSeverity.CONCERN
    ).length;

    const hasTooManyWarnings = warningConcernCount >= 3;

    const finalPassed = !hasHardContradiction && !hasTooManyWarnings;
    
    this.log?.info(`[state-validator] [DEBUG] 最终验证结果:`);
    this.log?.info(`[state-validator] [DEBUG] 警告数量: warningConcernCount=${warningConcernCount}, hasTooManyWarnings=${hasTooManyWarnings}`);
    this.log?.info(`[state-validator] [DEBUG] 最终通过状态: finalPassed=${finalPassed}`);
    this.log?.info(`[state-validator] [DEBUG] 整体严重程度: overallSeverity=${overallSeverity}`);

    return {
      passed: finalPassed,
      severity: overallSeverity,
      warnings: allWarnings,
      fixSuggestions: allFixSuggestions,
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
    }else {
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
