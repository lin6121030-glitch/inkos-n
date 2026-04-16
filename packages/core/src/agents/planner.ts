import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BaseAgent } from "./base.js";
import type { LLMMessage } from "../llm/provider.js";
import type { BookConfig } from "../models/book.js";
import { parseBookRules } from "../models/book-rules.js";
import { ChapterIntentSchema, type ChapterConflict, type ChapterIntent } from "../models/input-governance.js";
import {
  parseChapterSummariesMarkdown,
  renderHookSnapshot,
  renderSummarySnapshot,
  retrieveMemorySelection,
} from "../utils/memory-retrieval.js";
import { analyzeChapterCadence } from "../utils/chapter-cadence.js";
import { buildPlannerHookAgenda } from "../utils/hook-agenda.js";

export interface PlanChapterInput {
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly externalContext?: string;
}

export interface PlanChapterOutput {
  readonly intent: ChapterIntent;
  readonly intentMarkdown: string;
  readonly plannerInputs: ReadonlyArray<string>;
  readonly runtimePath: string;
}

export interface OutlineExtractionResult {
  readonly outlineNode: string;
  readonly coreConflict: string | null;
  readonly subplotConflict: string | null;
  readonly deepConflict: string | null;
  readonly chapterEvent: string | null;
  readonly payoffGoal: string | null;
  readonly keyTwist: string | null;
  readonly goldenThreePlan: string | null;
  readonly confidence: number;
}

export interface ChapterOutline {
  readonly outlineNode: string;
  readonly coreConflict?: string;
  readonly subplotConflict?: string;
  readonly deepConflict?: string;
  readonly chapterEvent?: string;
  readonly payoffGoal?: string;
  readonly keyTwist?: string;
  readonly goldenThreePlan?: string;
}

export class PlannerAgent extends BaseAgent {
  get name(): string {
    return "planner";
  }

  async planChapter(input: PlanChapterInput): Promise<PlanChapterOutput> {
    const storyDir = join(input.bookDir, "story");
    const runtimeDir = join(storyDir, "runtime");
    await mkdir(runtimeDir, { recursive: true });

    const sourcePaths = {
      authorIntent: join(storyDir, "author_intent.md"),
      currentFocus: join(storyDir, "current_focus.md"),
      storyBible: join(storyDir, "story_bible.md"),
      volumeOutline: join(storyDir, "volume_outline.md"),
      chapterSummaries: join(storyDir, "chapter_summaries.md"),
      bookRules: join(storyDir, "book_rules.md"),
      currentState: join(storyDir, "current_state.md"),
    } as const;

    const [
      authorIntent,
      currentFocus,
      storyBible,
      volumeOutline,
      chapterSummaries,
      bookRulesRaw,
      currentState,
    ] = await Promise.all([
      this.readFileOrDefault(sourcePaths.authorIntent),
      this.readFileOrDefault(sourcePaths.currentFocus),
      this.readFileOrDefault(sourcePaths.storyBible),
      this.readFileOrDefault(sourcePaths.volumeOutline),
      this.readFileOrDefault(sourcePaths.chapterSummaries),
      this.readFileOrDefault(sourcePaths.bookRules),
      this.readFileOrDefault(sourcePaths.currentState),
    ]);

    const outlineData = await this.extractChapterOutline(
      volumeOutline,
      input.chapterNumber,
      input.book.language,
    );
    const outlineNode = outlineData.outlineNode;
    const matchedOutlineAnchor = this.hasMatchedOutlineAnchor(volumeOutline, input.chapterNumber);

    const llmExtracted = this.buildLLMExtractedDirectives({
      coreConflict: outlineData.coreConflict,
      subplotConflict: outlineData.subplotConflict,
      deepConflict: outlineData.deepConflict,
      chapterEvent: outlineData.chapterEvent,
      payoffGoal: outlineData.payoffGoal,
      keyTwist: outlineData.keyTwist,
      language: input.book.language,
    });

    const goal = this.deriveGoal(input.externalContext, currentFocus, authorIntent, outlineNode, input.chapterNumber, outlineData.payoffGoal);
    const parsedRules = parseBookRules(bookRulesRaw);
    let mustKeep = this.collectMustKeep(currentState, storyBible);
    const mustAvoid = this.collectMustAvoid(currentFocus, parsedRules.rules.prohibitions);
    const styleEmphasis = this.collectStyleEmphasis(authorIntent, currentFocus);
    let conflicts = this.collectConflicts(input.externalContext, currentFocus, outlineNode, volumeOutline);
    const planningAnchor = conflicts.length > 0 ? undefined : outlineNode;
    const memorySelection = await retrieveMemorySelection({
      bookDir: input.bookDir,
      chapterNumber: input.chapterNumber,
      goal,
      outlineNode: planningAnchor,
      mustKeep,
    });
    const activeHookCount = memorySelection.activeHooks.filter(
      (hook) => hook.status !== "resolved" && hook.status !== "deferred",
    ).length;
    const hookAgenda = buildPlannerHookAgenda({
      hooks: memorySelection.activeHooks,
      chapterNumber: input.chapterNumber,
      targetChapters: input.book.targetChapters,
      language: input.book.language ?? "zh",
    });
    const directives = this.buildStructuredDirectives({
      chapterNumber: input.chapterNumber,
      language: input.book.language,
      volumeOutline,
      outlineNode,
      matchedOutlineAnchor,
      chapterSummaries,
    });

    const llmEnrichments = this.enrichFromLLMExtract({
      coreConflict: outlineData.coreConflict,
      subplotConflict: outlineData.subplotConflict,
      deepConflict: outlineData.deepConflict,
      chapterEvent: outlineData.chapterEvent,
      keyTwist: outlineData.keyTwist,
      language: input.book.language,
    });

    mustKeep = this.unique([...mustKeep, ...llmEnrichments.mustKeep]);

    conflicts = llmEnrichments.conflicts.length > 0 ? [...conflicts, ...llmEnrichments.conflicts] : conflicts;

    const intent = ChapterIntentSchema.parse({
      chapter: input.chapterNumber,
      goal,
      outlineNode,
      ...directives,
      mustKeep,
      mustAvoid,
      styleEmphasis,
      conflicts,
      hookAgenda,
    });

    const runtimePath = join(runtimeDir, `chapter-${String(input.chapterNumber).padStart(4, "0")}.intent.md`);
    const intentMarkdown = this.renderIntentMarkdown(
      intent,
      input.book.language ?? "zh",
      renderHookSnapshot(memorySelection.hooks, input.book.language ?? "zh"),
      renderSummarySnapshot(memorySelection.summaries, input.book.language ?? "zh"),
      activeHookCount,
    );
    await writeFile(runtimePath, intentMarkdown, "utf-8");

    return {
      intent,
      intentMarkdown,
      plannerInputs: [
        ...Object.values(sourcePaths),
        join(storyDir, "pending_hooks.md"),
        ...(memorySelection.dbPath ? [memorySelection.dbPath] : []),
      ],
      runtimePath,
    };
  }

  private buildStructuredDirectives(input: {
    readonly chapterNumber: number;
    readonly language?: string;
    readonly volumeOutline: string;
    readonly outlineNode: string | undefined;
    readonly matchedOutlineAnchor: boolean;
    readonly chapterSummaries: string;
  }): Pick<ChapterIntent, "sceneDirective" | "arcDirective" | "moodDirective" | "titleDirective"> {
    const recentSummaries = parseChapterSummariesMarkdown(input.chapterSummaries)
      .filter((summary) => summary.chapter < input.chapterNumber)
      .sort((left, right) => left.chapter - right.chapter)
      .slice(-4);
    const cadence = analyzeChapterCadence({
      language: this.isChineseLanguage(input.language) ? "zh" : "en",
      rows: recentSummaries.map((summary) => ({
        chapter: summary.chapter,
        title: summary.title,
        mood: summary.mood,
        chapterType: summary.chapterType,
      })),
    });

    return {
      arcDirective: this.buildArcDirective(
        input.language,
        input.volumeOutline,
        input.outlineNode,
        input.matchedOutlineAnchor,
      ),
      sceneDirective: this.buildSceneDirective(input.language, cadence),
      moodDirective: this.buildMoodDirective(input.language, cadence),
      titleDirective: this.buildTitleDirective(input.language, cadence),
    };
  }

  private deriveGoal(
    externalContext: string | undefined,
    currentFocus: string,
    authorIntent: string,
    outlineNode: string | undefined,
    chapterNumber: number,
    llmPayoffGoal?: string,
  ): string {
    const first = this.extractFirstDirective(externalContext);
    if (first) return this.enrichGoalWithPayoff(first, llmPayoffGoal);
    const localOverride = this.extractLocalOverrideGoal(currentFocus);
    if (localOverride) return this.enrichGoalWithPayoff(localOverride, llmPayoffGoal);
    const outline = this.extractFirstDirective(outlineNode);
    if (outline) return this.enrichGoalWithPayoff(outline, llmPayoffGoal);
    const focus = this.extractFocusGoal(currentFocus);
    if (focus) return this.enrichGoalWithPayoff(focus, llmPayoffGoal);
    const author = this.extractFirstDirective(authorIntent);
    if (author) return this.enrichGoalWithPayoff(author, llmPayoffGoal);
    return `Advance chapter ${chapterNumber} with clear narrative focus.`;
  }

  private enrichGoalWithPayoff(goal: string, payoffGoal?: string): string {
    if (!payoffGoal) return goal;
    return `${goal} 收益目标：${payoffGoal}`;
  }

  private collectMustKeep(currentState: string, storyBible: string): string[] {
    return this.unique([
      ...this.extractListItems(currentState, 2),
      ...this.extractListItems(storyBible, 2),
    ]).slice(0, 4);
  }

  private collectMustAvoid(currentFocus: string, prohibitions: ReadonlyArray<string>): string[] {
    const avoidSection = this.extractSection(currentFocus, [
      "avoid",
      "must avoid",
      "禁止",
      "避免",
      "避雷",
    ]);
    const focusAvoids = avoidSection
      ? this.extractListItems(avoidSection, 10)
      : currentFocus
        .split("\n")
        .map((line) => line.trim())
        .filter((line) =>
          line.startsWith("-") &&
          /avoid|don't|do not|不要|别|禁止/i.test(line),
        )
        .map((line) => this.cleanListItem(line))
        .filter((line): line is string => Boolean(line));

    return this.unique([...focusAvoids, ...prohibitions]).slice(0, 6);
  }

  private collectStyleEmphasis(authorIntent: string, currentFocus: string): string[] {
    return this.unique([
      ...this.extractFocusStyleItems(currentFocus),
      ...this.extractListItems(authorIntent, 2),
    ]).slice(0, 4);
  }

  private collectConflicts(
    externalContext: string | undefined,
    currentFocus: string,
    outlineNode: string | undefined,
    volumeOutline: string,
  ): ChapterConflict[] {
    const outlineText = outlineNode ?? volumeOutline;
    if (!outlineText || outlineText === "(文件尚未创建)") return [];
    if (externalContext) {
      const indicatesOverride = /ignore|skip|defer|instead|不要|别|先别|暂停/i.test(externalContext);
      if (!indicatesOverride && this.hasKeywordOverlap(externalContext, outlineText)) return [];

      return [
        {
          type: "outline_vs_request",
          resolution: "allow local outline deferral",
        },
      ];
    }

    const localOverride = this.extractLocalOverrideGoal(currentFocus);
    if (!localOverride || !outlineNode) {
      return [];
    }

    return [
      {
        type: "outline_vs_current_focus",
        resolution: "allow explicit current focus override",
        detail: localOverride,
      },
    ];
  }

  private extractFirstDirective(content?: string): string | undefined {
    if (!content) return undefined;
    return content
      .split("\n")
      .map((line) => line.trim())
      .find((line) =>
        line.length > 0
        && !line.startsWith("#")
        && !line.startsWith("-")
        && !this.isTemplatePlaceholder(line),
      );
  }

  private extractListItems(content: string, limit: number): string[] {
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("-"))
      .map((line) => this.cleanListItem(line))
      .filter((line): line is string => Boolean(line))
      .slice(0, limit);
  }

  private extractFocusGoal(currentFocus: string): string | undefined {
    const focusSection = this.extractSection(currentFocus, [
      "active focus",
      "focus",
      "当前聚焦",
      "当前焦点",
      "近期聚焦",
    ]) ?? currentFocus;
    const directives = this.extractFocusStyleItems(focusSection, 3);
    if (directives.length === 0) {
      return this.extractFirstDirective(focusSection);
    }
    return directives.join(this.containsChinese(focusSection) ? "；" : "; ");
  }

  private extractLocalOverrideGoal(currentFocus: string): string | undefined {
    const overrideSection = this.extractSection(currentFocus, [
      "local override",
      "explicit override",
      "chapter override",
      "local task override",
      "局部覆盖",
      "本章覆盖",
      "临时覆盖",
      "当前覆盖",
    ]);
    if (!overrideSection) {
      return undefined;
    }

    const directives = this.extractListItems(overrideSection, 3);
    if (directives.length > 0) {
      return directives.join(this.containsChinese(overrideSection) ? "；" : "; ");
    }

    return this.extractFirstDirective(overrideSection);
  }

  private extractFocusStyleItems(currentFocus: string, limit = 3): string[] {
    const focusSection = this.extractSection(currentFocus, [
      "active focus",
      "focus",
      "当前聚焦",
      "当前焦点",
      "近期聚焦",
    ]) ?? currentFocus;
    return this.extractListItems(focusSection, limit);
  }

  private buildArcDirective(
    language: string | undefined,
    volumeOutline: string,
    outlineNode: string | undefined,
    matchedOutlineAnchor: boolean,
  ): string | undefined {
    if (matchedOutlineAnchor || !outlineNode || volumeOutline === "(文件尚未创建)") {
      return undefined;
    }

    return this.isChineseLanguage(language)
      ? "不要继续依赖卷纲的 fallback 指令，必须把本章推进到新的弧线节点或地点变化。"
      : "Do not keep leaning on the outline fallback. Force this chapter toward a fresh arc beat or location change.";
  }

  private buildLLMExtractedDirectives(input: {
    readonly coreConflict?: string;
    readonly subplotConflict?: string;
    readonly deepConflict?: string;
    readonly chapterEvent?: string;
    readonly payoffGoal?: string;
    readonly keyTwist?: string;
    readonly language?: string;
  }): Pick<ChapterIntent, "arcDirective" | "sceneDirective" | "moodDirective" | "titleDirective"> {
    const directives: Pick<ChapterIntent, "arcDirective" | "sceneDirective" | "moodDirective" | "titleDirective"> = {
      arcDirective: undefined,
      sceneDirective: undefined,
      moodDirective: undefined,
      titleDirective: undefined,
    };

    if (!this.isChineseLanguage(input.language)) {
      return directives;
    }

    const parts: string[] = [];
    if (input.coreConflict) parts.push(`明线冲突：${input.coreConflict}`);
    if (input.subplotConflict) parts.push(`暗线冲突：${input.subplotConflict}`);
    if (input.deepConflict) parts.push(`深层冲突：${input.deepConflict}`);

    if (parts.length > 0) {
      directives.arcDirective = parts.join("；");
    }

    if (input.keyTwist) {
      directives.sceneDirective = `关键转折：${input.keyTwist}`;
    }

    return directives;
  }

  private enrichFromLLMExtract(input: {
    readonly coreConflict?: string;
    readonly subplotConflict?: string;
    readonly deepConflict?: string;
    readonly chapterEvent?: string;
    readonly keyTwist?: string;
    readonly language?: string;
  }): { mustKeep: string[]; conflicts: ChapterConflict[] } {
    const mustKeep: string[] = [];
    const conflicts: ChapterConflict[] = [];

    if (input.chapterEvent) {
      mustKeep.push(`本章事件：${input.chapterEvent}`);
    }

    if (input.keyTwist) {
      conflicts.push({
        type: "key_twist",
        detail: input.keyTwist,
        resolution: "include in narrative",
      });
    }

    return { mustKeep, conflicts };
  }

  private buildSceneDirective(
    language: string | undefined,
    cadence: ReturnType<typeof analyzeChapterCadence>,
  ): string | undefined {
    if (cadence.scenePressure?.pressure !== "high") {
      return undefined;
    }
    const repeatedType = cadence.scenePressure.repeatedType;

    return this.isChineseLanguage(language)
      ? `最近章节连续停留在“${repeatedType}”，本章必须更换场景容器、地点或行动方式。`
      : `Recent chapters are stuck in repeated ${repeatedType} beats. Change the scene container, location, or action pattern this chapter.`;
  }

  private buildMoodDirective(
    language: string | undefined,
    cadence: ReturnType<typeof analyzeChapterCadence>,
  ): string | undefined {
    if (cadence.moodPressure?.pressure !== "high") {
      return undefined;
    }
    const moods = cadence.moodPressure.recentMoods;

    return this.isChineseLanguage(language)
      ? `最近${moods.length}章情绪持续高压（${moods.slice(0, 3).join("、")}），本章必须降调——安排日常/喘息/温情/幽默场景，让读者呼吸。`
      : `The last ${moods.length} chapters have been relentlessly tense (${moods.slice(0, 3).join(", ")}). This chapter must downshift — write a quieter scene with warmth, humor, or breathing room.`;
  }

  private buildTitleDirective(
    language: string | undefined,
    cadence: ReturnType<typeof analyzeChapterCadence>,
  ): string | undefined {
    if (cadence.titlePressure?.pressure !== "high") {
      return undefined;
    }
    const repeatedToken = cadence.titlePressure.repeatedToken;

    return this.isChineseLanguage(language)
      ? `标题不要再围绕“${repeatedToken}”重复命名，换一个新的意象或动作焦点。`
      : `Avoid another ${repeatedToken}-centric title. Pick a new image or action focus for this chapter title.`;
  }

  private renderHookBudget(activeCount: number, language: "zh" | "en"): string {
    const cap = 12;
    if (activeCount < 10) {
      return language === "en"
        ? `### Hook Budget\n- ${activeCount} active hooks (capacity: ${cap})`
        : `### 伏笔预算\n- 当前 ${activeCount} 条活跃伏笔（容量：${cap}）`;
    }
    const remaining = Math.max(0, cap - activeCount);
    return language === "en"
      ? `### Hook Budget\n- ${activeCount} active hooks — approaching capacity (${cap}). Only ${remaining} new hook(s) allowed. Prioritize resolving existing debt over opening new threads.`
      : `### 伏笔预算\n- 当前 ${activeCount} 条活跃伏笔——接近容量上限（${cap}）。仅剩 ${remaining} 个新坑位。优先回收旧债，不要轻易开新线。`;
  }

  private extractSection(content: string, headings: ReadonlyArray<string>): string | undefined {
    const targets = headings.map((heading) => this.normalizeHeading(heading));
    const lines = content.split("\n");
    let buffer: string[] | null = null;
    let sectionLevel = 0;

    for (const line of lines) {
      const headingMatch = line.match(/^(#+)\s*(.+?)\s*$/);
      if (headingMatch) {
        const level = headingMatch[1]!.length;
        const heading = this.normalizeHeading(headingMatch[2]!);

        if (buffer && level <= sectionLevel) {
          break;
        }

        if (targets.includes(heading)) {
          buffer = [];
          sectionLevel = level;
          continue;
        }
      }

      if (buffer) {
        buffer.push(line);
      }
    }

    const section = buffer?.join("\n").trim();
    return section && section.length > 0 ? section : undefined;
  }

  private normalizeHeading(heading: string): string {
    return heading
      .toLowerCase()
      .replace(/[*_`:#]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private cleanListItem(line: string): string | undefined {
    const cleaned = line.replace(/^-\s*/, "").trim();
    if (cleaned.length === 0) return undefined;
    if (/^[-|]+$/.test(cleaned)) return undefined;
    if (this.isTemplatePlaceholder(cleaned)) return undefined;
    return cleaned;
  }

  private isTemplatePlaceholder(line: string): boolean {
    const normalized = line.trim();
    if (!normalized) return false;

    return (
      /^\((describe|briefly describe|write)\b[\s\S]*\)$/i.test(normalized)
      || /^（(?:在这里描述|描述|填写|写下)[\s\S]*）$/u.test(normalized)
    );
  }

  private containsChinese(content: string): boolean {
    return /[\u4e00-\u9fff]/.test(content);
  }

  private findOutlineNode(volumeOutline: string, chapterNumber: number): string | undefined {
    const lines = volumeOutline.split("\n").map((line) => line.trim()).filter(Boolean);
    this.ctx.logger?.info(`[调试] findOutlineNode: 正在第${chapterNumber}章，共${lines.length}行`);

    // Log all potential matching lines
    for (const line of lines) {
      const exactMatch = this.matchExactOutlineLine(line, chapterNumber);
      const rangeMatch = this.matchRangeOutlineLine(line, chapterNumber);
      if (exactMatch || rangeMatch) {
        this.ctx.logger?.info(`[调试] findOutlineNode: 匹配到行: "${line}"`);
        if (exactMatch) {
          this.ctx.logger?.info(`[调试] findOutlineNode: 精确匹配结果: ${JSON.stringify(exactMatch?.slice(1))}`);
        }
        if (rangeMatch) {
          this.ctx.logger?.info(`[调试] findOutlineNode: 范围匹配结果: ${JSON.stringify(rangeMatch?.slice(1))}`);
        }
      }
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const match = this.matchExactOutlineLine(line, chapterNumber);
      if (!match) continue;

      const inlineContent = this.cleanOutlineContent(match[1]);
      if (inlineContent) {
        this.ctx.logger?.info(`[调试] findOutlineNode: 找到内联内容: "${inlineContent}"`);
        return inlineContent;
      }

      const nextContent = this.findNextOutlineContent(lines, index + 1);
      if (nextContent) {
        this.ctx.logger?.info(`[调试] findOutlineNode: 找到后续内容: "${nextContent.slice(0, 100)}..."`);
        return nextContent;
      }
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const match = this.matchRangeOutlineLine(line, chapterNumber);
      if (!match) continue;

      const inlineContent = this.cleanOutlineContent(match[3]);
      if (inlineContent) {
        this.ctx.logger?.info(`[调试] findOutlineNode: 找到范围内联内容: "${inlineContent}"`);
        return inlineContent;
      }

      const nextContent = this.findNextOutlineContent(lines, index + 1);
      if (nextContent) {
        this.ctx.logger?.info(`[调试] findOutlineNode: 找到范围后续内容: "${nextContent.slice(0, 100)}..."`);
        return nextContent;
      }
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!this.isOutlineAnchorLine(line)) continue;

      this.ctx.logger?.info(`[调试] findOutlineNode: 兜底匹配行: "${line}"`);

      const exactMatch = this.matchAnyExactOutlineLine(line);
      if (exactMatch) {
        const inlineContent = this.cleanOutlineContent(exactMatch[1]);
        if (inlineContent) {
          this.ctx.logger?.info(`[调试] findOutlineNode: 兜底找到精确匹配: "${inlineContent}"`);
          return inlineContent;
        }
      }

      const rangeMatch = this.matchAnyRangeOutlineLine(line);
      if (rangeMatch) {
        const inlineContent = this.cleanOutlineContent(rangeMatch[3]);
        if (inlineContent) {
          this.ctx.logger?.info(`[调试] findOutlineNode: 兜底找到范围匹配: "${inlineContent}"`);
          return inlineContent;
        }
      }

      const nextContent = this.findNextOutlineContent(lines, index + 1);
      if (nextContent) {
        return nextContent;
      }

      break;
    }

    throw new Error(
      `[Planner] Cannot find outline node for chapter ${chapterNumber} in volume_outline. ` +
      `卷纲中未找到第${chapterNumber}章的对应节点。`,
    );
  }

  private async extractOutlineByLLM(
    volumeOutline: string,
    chapterNumber: number,
    language?: string,
  ): Promise<ChapterOutline> {
    const isZh = this.isChineseLanguage(language);

    const prompt = isZh
      ? `你是一个小说大纲解析专家。从以下卷纲中提取第${chapterNumber}章的相关内容。

## 重要约束
- 必须从"章节结构表"中定位本章对应的事件
- 如果是1-3章，优先从"黄金三章规划"提取
- 如果本章有关键转折节点，必须包含
- 不要编造信息，只提取大纲中明确存在的内容
- 如果某项信息不存在，返回 null

## 卷纲内容
${volumeOutline}

## 输出要求
返回以下JSON格式（必须是有效JSON）：
{
  "outlineNode": "本章核心大纲要点（50字以内）",
  "coreConflict": "明线冲突相关描述（如果没有则null）",
  "subplotConflict": "暗线冲突相关描述（如果没有则null）",
  "deepConflict": "深层冲突相关描述（如果没有则null）",
  "chapterEvent": "章节结构表中的事件名",
  "payoffGoal": "收益目标（如果没有则null）",
  "keyTwist": "关键转折描述（如果没有则null）",
  "goldenThreePlan": "黄金三章规划内容（仅1-3章有，其他返回null）",
  "confidence": "你对提取结果的信心度（0-1之间，1表示非常有信心）"
}

只返回JSON，不要其他内容。`
      : `You are a novel outline parsing expert. Extract information for Chapter ${chapterNumber} from the following volume outline.

## Important Constraints
- Must locate this chapter's event from the "Chapter Structure Table"
- If this is Chapter 1-3, prioritize extracting from "Golden Three Chapters Plan"
- Include key turning points if any
- Do NOT fabricate information - only extract what exists in the outline
- If information doesn't exist, return null

## Volume Outline
${volumeOutline}

## Output Requirements
Return valid JSON with this structure:
{
  "outlineNode": "Core outline point for this chapter (within 50 words)",
  "coreConflict": "Main conflict description (null if none)",
  "subplotConflict": "Subplot conflict description (null if none)",
  "deepConflict": "Deep conflict description (null if none)",
  "chapterEvent": "Event name from chapter structure table",
  "payoffGoal": "Payoff goal (null if none)",
  "keyTwist": "Key twist description (null if none)",
  "goldenThreePlan": "Golden three chapters plan content (only for Ch 1-3, null otherwise)",
  "confidence": "Your confidence in the extraction (0-1, 1 being highest)"
}

Only return JSON, nothing else.`;

    try {
      const messages: LLMMessage[] = [
        { role: "user", content: prompt },
      ];

      const response = await this.chat(messages, { temperature: 0.3 });
      const content = response.content ?? "";

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("LLM response is not valid JSON");
      }

      const parsed = JSON.parse(jsonMatch[0]!);

      return {
        outlineNode: parsed.outlineNode ?? "",
        coreConflict: parsed.coreConflict ?? undefined,
        subplotConflict: parsed.subplotConflict ?? undefined,
        deepConflict: parsed.deepConflict ?? undefined,
        chapterEvent: parsed.chapterEvent ?? undefined,
        payoffGoal: parsed.payoffGoal ?? undefined,
        keyTwist: parsed.keyTwist ?? undefined,
        goldenThreePlan: parsed.goldenThreePlan ?? undefined,
      };
    } catch (error) {
      this.ctx.logger?.error(`[Planner] LLM提取失败: ${error}`);
      throw error;
    }
  }

  private async extractOutlineWithVerification(
    volumeOutline: string,
    chapterNumber: number,
    language?: string,
  ): Promise<ChapterOutline & { confidence: number }> {
    const result1 = await this.extractOutlineByLLM(volumeOutline, chapterNumber, language);
    const result2 = await this.extractOutlineByLLM(volumeOutline, chapterNumber, language);

    const hasValidContent = (r: ChapterOutline) => r.outlineNode.length > 10;
    const isConsistent =
      hasValidContent(result1) &&
      hasValidContent(result2) &&
      (result1.outlineNode === result2.outlineNode ||
        this.calculateSimilarity(result1.outlineNode, result2.outlineNode) > 0.4);

    if (isConsistent) {
      const confidence = this.calculateSimilarity(result1.outlineNode, result2.outlineNode);
      return { ...result1, confidence };
    }

    if (hasValidContent(result1)) {
      return { ...result1, confidence: 0.6 };
    }
    if (hasValidContent(result2)) {
      return { ...result2, confidence: 0.6 };
    }

    const negotiatePrompt = `你两次提取的第${chapterNumber}章大纲结果不一致：
结果1: ${result1.outlineNode}
结果2: ${result2.outlineNode}

请根据卷纲内容，确定最准确的提取结果，只返回一个结果。
只返回JSON格式：
{
  "outlineNode": "最终确定的大纲要点",
  "confidence": 0.5
}`;

    const messages: LLMMessage[] = [
      { role: "user", content: negotiatePrompt },
    ];

    const response = await this.chat(messages, { temperature: 0.3 });
    const content = response.content ?? "";
    const jsonMatch = content.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]!);
      return { ...result1, confidence: parsed.confidence ?? 0.6 };
    }

    return { ...result1, confidence: 0.5 };
  }

  private calculateSimilarity(str1: string, str2: string): number {
    if (!str1 || !str2) return 0;
    const set1 = new Set(str1.split(""));
    const set2 = new Set(str2.split(""));
    const intersection = new Set([...set1].filter((x) => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    return intersection.size / union.size;
  }

  private async extractChapterOutline(
    volumeOutline: string,
    chapterNumber: number,
    language?: string,
  ): Promise<ChapterOutline> {
    if (!volumeOutline || volumeOutline === "(文件尚未创建)") {
      return { outlineNode: "" };
    }

    try {
      const result = await this.extractOutlineWithVerification(
        volumeOutline,
        chapterNumber,
        language,
      );

      if (result.confidence >= 0.5 && result.outlineNode && result.outlineNode.length > 10) {
        this.ctx.logger?.info(
          `[Planner] LLM提取成功(信心度:${result.confidence}): ${result.outlineNode.slice(0, 50)}...`,
        );
        const { confidence: _, ...outline } = result;
        return outline;
      }

      this.ctx.logger?.warn(
        `[Planner] LLM提取信心度不足(${result.confidence})，使用正则兜底`,
      );
      return this.findOutlineNodeWithResult(volumeOutline, chapterNumber);
    } catch (error) {
      this.ctx.logger?.error(
        `[Planner] LLM提取异常: ${error}，使用正则兜底`,
      );
      return this.findOutlineNodeWithResult(volumeOutline, chapterNumber);
    }
  }

  private findOutlineNodeWithResult(
    volumeOutline: string,
    chapterNumber: number,
  ): ChapterOutline {
    try {
      const outlineNode = this.findOutlineNode(volumeOutline, chapterNumber);
      return { outlineNode: outlineNode ?? "" };
    } catch {
      return { outlineNode: "" };
    }
  }

  private cleanOutlineContent(content?: string): string | undefined {
    const cleaned = content?.trim();
    if (!cleaned) return undefined;
    if (/^[*_`~:：-]+$/.test(cleaned)) return undefined;
    return cleaned;
  }

  private findNextOutlineContent(lines: ReadonlyArray<string>, startIndex: number): string | undefined {
    for (let index = startIndex; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line) {
        continue;
      }

      if (this.isOutlineAnchorLine(line)) {
        return undefined;
      }

      if (line.startsWith("#")) {
        continue;
      }

      const cleaned = this.cleanOutlineContent(line);
      if (cleaned) {
        return cleaned;
      }
    }

    return undefined;
  }

  private hasMatchedOutlineAnchor(volumeOutline: string, chapterNumber: number): boolean {
    const lines = volumeOutline.split("\n").map((line) => line.trim()).filter(Boolean);
    return lines.some((line) =>
      this.matchExactOutlineLine(line, chapterNumber) !== undefined
      || this.matchRangeOutlineLine(line, chapterNumber) !== undefined,
    );
  }

  private matchExactOutlineLine(line: string, chapterNumber: number): RegExpMatchArray | undefined {
    const patterns = [
      new RegExp(`^(?:#+\\s*)?(?:[-*]\\s+)?(?:\\*\\*)?Chapter\\s*${chapterNumber}(?!\\d|\\s*[-~–—]\\s*\\d)(?:[:：-])?(?:\\*\\*)?\\s*(.*)$`, "i"),
      new RegExp(`^(?:#+\\s*)?(?:[-*]\\s+)?(?:\\*\\*)?第\\s*${chapterNumber}\\s*章(?!\\d|\\s*[-~–—]\\s*\\d)(?:[:：-])?(?:\\*\\*)?\\s*(.*)$`),
    ];

    return patterns
      .map((pattern) => line.match(pattern))
      .find((result): result is RegExpMatchArray => Boolean(result));
  }

  private matchAnyExactOutlineLine(line: string): RegExpMatchArray | undefined {
    const patterns = [
      /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?Chapter\s*\d+(?!\s*[-~–—]\s*\d)(?:[:：-])?(?:\*\*)?\s*(.*)$/i,
      /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?第\s*\d+\s*章(?!\s*[-~–—]\s*\d)(?:[:：-])?(?:\*\*)?\s*(.*)$/i,
    ];

    return patterns
      .map((pattern) => line.match(pattern))
      .find((result): result is RegExpMatchArray => Boolean(result));
  }

  private matchRangeOutlineLine(line: string, chapterNumber: number): RegExpMatchArray | undefined {
    const match = this.matchAnyRangeOutlineLine(line);
    if (!match) return undefined;
    if (this.isChapterWithinRange(match[1], match[2], chapterNumber)) {
      return match;
    }

    return undefined;
  }

  private matchAnyRangeOutlineLine(line: string): RegExpMatchArray | undefined {
    const patterns = [
      /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?Chapter\s*(\d+)\s*[-~–—]\s*(\d+)\b(?:[:：-])?(?:\*\*)?\s*(.*)$/i,
      /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?第\s*(\d+)\s*[-~–—]\s*(\d+)\s*章(?:[:：-])?(?:\*\*)?\s*(.*)$/i,
    ];

    return patterns
      .map((pattern) => line.match(pattern))
      .find((result): result is RegExpMatchArray => Boolean(result));
  }

  private isOutlineAnchorLine(line: string): boolean {
    return this.matchAnyExactOutlineLine(line) !== undefined
      || this.matchAnyRangeOutlineLine(line) !== undefined;
  }

  private isChapterWithinRange(startText: string | undefined, endText: string | undefined, chapterNumber: number): boolean {
    const start = Number.parseInt(startText ?? "", 10);
    const end = Number.parseInt(endText ?? "", 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    const lower = Math.min(start, end);
    const upper = Math.max(start, end);
    return chapterNumber >= lower && chapterNumber <= upper;
  }

  private hasKeywordOverlap(left: string, right: string): boolean {
    const keywords = this.extractKeywords(left);
    if (keywords.length === 0) return false;
    const normalizedRight = right.toLowerCase();
    return keywords.some((keyword) => normalizedRight.includes(keyword.toLowerCase()));
  }

  private extractKeywords(content: string): string[] {
    const english = content.match(/[a-z]{4,}/gi) ?? [];
    const chinese = content.match(/[\u4e00-\u9fff]{2,4}/g) ?? [];
    return this.unique([...english, ...chinese]);
  }

  private renderIntentMarkdown(
    intent: ChapterIntent,
    language: "zh" | "en",
    pendingHooks: string,
    chapterSummaries: string,
    activeHookCount: number,
  ): string {
    const conflictLines = intent.conflicts.length > 0
      ? intent.conflicts.map((conflict) => `- ${conflict.type}: ${conflict.resolution}`).join("\n")
      : "- none";

    const mustKeep = intent.mustKeep.length > 0
      ? intent.mustKeep.map((item) => `- ${item}`).join("\n")
      : "- none";

    const mustAvoid = intent.mustAvoid.length > 0
      ? intent.mustAvoid.map((item) => `- ${item}`).join("\n")
      : "- none";

    const styleEmphasis = intent.styleEmphasis.length > 0
      ? intent.styleEmphasis.map((item) => `- ${item}`).join("\n")
      : "- none";
    const directives = [
      intent.arcDirective ? `- arc: ${intent.arcDirective}` : undefined,
      intent.sceneDirective ? `- scene: ${intent.sceneDirective}` : undefined,
      intent.moodDirective ? `- mood: ${intent.moodDirective}` : undefined,
      intent.titleDirective ? `- title: ${intent.titleDirective}` : undefined,
    ].filter(Boolean).join("\n") || "- none";
    const hookAgenda = [
      "### Must Advance",
      intent.hookAgenda.mustAdvance.length > 0
        ? intent.hookAgenda.mustAdvance.map((item) => `- ${item}`).join("\n")
        : "- none",
      "",
      "### Eligible Resolve",
      intent.hookAgenda.eligibleResolve.length > 0
        ? intent.hookAgenda.eligibleResolve.map((item) => `- ${item}`).join("\n")
        : "- none",
      "",
      "### Stale Debt",
      intent.hookAgenda.staleDebt.length > 0
        ? intent.hookAgenda.staleDebt.map((item) => `- ${item}`).join("\n")
        : "- none",
      "",
      "### Avoid New Hook Families",
      intent.hookAgenda.avoidNewHookFamilies.length > 0
        ? intent.hookAgenda.avoidNewHookFamilies.map((item) => `- ${item}`).join("\n")
        : "- none",
      "",
      this.renderHookBudget(activeHookCount, language),
    ].join("\n");

    // Log the final output
    this.ctx.logger?.info(`[调试] renderIntentMarkdown: 最终Outline Node: "${intent.outlineNode ?? "(未找到)"}"`);

    return [
      "# Chapter Intent",
      "",
      "## Goal",
      intent.goal,
      "",
      "## Outline Node",
      intent.outlineNode ?? "(not found)",
      "",
      "## Must Keep",
      mustKeep,
      "",
      "## Must Avoid",
      mustAvoid,
      "",
      "## Style Emphasis",
      styleEmphasis,
      "",
      "## Structured Directives",
      directives,
      "",
      "## Hook Agenda",
      hookAgenda,
      "",
      "## Conflicts",
      conflictLines,
      "",
      "## Pending Hooks Snapshot",
      pendingHooks,
      "",
      "## Chapter Summaries Snapshot",
      chapterSummaries,
      "",
    ].join("\n");
  }

  private unique(values: ReadonlyArray<string>): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  }

  private isChineseLanguage(language: string | undefined): boolean {
    return (language ?? "zh").toLowerCase().startsWith("zh");
  }

  private async readFileOrDefault(path: string): Promise<string> {
    try {
      return await readFile(path, "utf-8");
    } catch {
      return "(文件尚未创建)";
    }
  }
}
