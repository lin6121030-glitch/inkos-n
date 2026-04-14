# InkOS 定制版改动说明

## 背景

基于 InkOS 原始项目进行定制化开发，核心目标：**让 AI 严格遵守作者的大纲简报，而不是自由发挥**。

## 核心改动

### 1. Composer - volume_outline 约束升级
**文件**: `packages/core/src/agents/composer.ts`

**改动**: `volume_outline: soft` → `volume_outline: hard`

```typescript
volume_outline: "hard", // 原来是 "soft"
```

**效果**: 大纲从"软约束"升级为"硬约束"，AI 必须严格遵守。

---

### 2. Planner - Fallback 逻辑改为报错
**文件**: `packages/core/src/agents/planner.ts`

**改动**: 找不到大纲节点时，不再静默降级，而是抛出错误。

**效果**: 强制 AI 遵循大纲走向，不允许偏离。

---

### 3. Architect - 简报解析 + 多轮对话生成
**文件**: `packages/core/src/agents/architect.ts`

#### 3.1 简报格式支持
用户简报使用标记格式：

```
==世界观基石start==
（世界观设定）
==世界观基石end==

==创作规则start==
（规则约束）
==创作规则end==

==书的大纲start==
（剧情大纲）
==书的大纲end==

==风格与样例start==
（风格偏好）
==风格与样例end==

==其他内容start==
（其他补充）
==其他内容end==
```

#### 3.2 简报分段注入
每个简报区块分别注入到对应的 section prompt 中：
- 世界观基石 → story_bible
- 创作规则 → book_rules
- 书的大纲 → volume_outline
- 风格与样例 → story_bible + current_state
- 其他内容 → pending_hooks

#### 3.3 多轮对话架构
从"一次请求生成 5 个 section"改为"5 次请求分别生成"：

```typescript
// 第1轮：生成 story_bible
const r1 = await this.chat(messages, chatOptions);
messages.push({ role: "assistant", content: r1.content });

// 第2轮：生成 volume_outline（包含上一次的上下文）
messages.push({ role: "user", content: userPrompts.volumeOutline });
const r2 = await this.chat(messages, chatOptions);
// ... 以此类推
```

**效果**: 
- 避免 LLM 输出漏 section 的问题
- 每个 section 生成更聚焦
- 保持同一对话上下文的一致性

#### 3.4 maxTokens 扩容
`maxTokens: 16384` → `maxTokens: 49152`

---

## 使用方法

### 1. 构建项目
```bash
pnpm install
pnpm build
```

### 2. 创建书籍
```bash
cd 道友快跑-test
node ../packages/cli/dist/index.js book create --title "道友快跑" --genre fantasy --target-chapters 800 --brief "../my-idea.md"
```

### 3. 编写章节
```bash
node ../packages/cli/dist/index.js write next
```

---

## 感谢

本项目基于 [InkOS](https://github.com/Narcooo/inkos) 开发，感谢原作者的付出与开源精神。

---

## License

GNU AFFERO GENERAL PUBLIC LICENSE v3 (AGPL-3.0)
