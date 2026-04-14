# InkOS 定制版 (InkOS-N)

<p align="center">
  <img src="assets/logo.svg" width="120" height="120" alt="InkOS Logo">
  <img src="assets/inkos-text.svg" width="240" height="65" alt="InkOS">
</p>

<h1 align="center">InkOS 定制版 - 大纲契约机制<br><sub>基于 InkOS 的改编版本</sub></h1>

---

## 简介

本项目是 [InkOS](https://github.com/Narcooo/inkos) 的定制改编版本，核心改造：**让 AI 严格遵守作者的大纲简报，而不是自由发挥**。

原版 InkOS 的设计哲学是"AI 协作写作"，简报作为参考而非命令。本定制版针对需要**大纲契约机制**的作者进行改造——大纲是"契约"不是"参考"，AI 必须在契约框架内自由发挥细节，但核心设定和大纲走向不能偏离。

---

## 核心改动

| 改动项 | 说明 |
|--------|------|
| Composer | volume_outline 从 soft 改为 hard |
| Planner | Fallback 逻辑改为报错 |
| Writer-prompts | 措辞改为硬约束 |
| Architect | 简报解析 + 多轮对话生成 + maxTokens 扩容 |

详细改动说明请查看 [CUSTOMIZATION.md](CUSTOMIZATION.md)

---

## 使用方法

### 构建项目
```bash
pnpm install
pnpm build
```

### 创建书籍
```bash
cd 你的项目目录
node ../packages/cli/dist/index.js book create --title "你的书名" --genre 你的题材 --target-chapters 章数 --brief "简报路径"
```

### 编写章节
```bash
node ../packages/cli/dist/index.js write next
```

---

## 简报格式

本定制版支持分段简报格式：

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

---

## 感谢

感谢 [InkOS](https://github.com/Narcooo/inkos) 原作者的开源精神与付出，本项目基于原项目进行定制化开发，保留了原项目的核心功能。

原项目地址：https://github.com/Narcooo/inkos

---

## License

GNU AFFERO GENERAL PUBLIC LICENSE v3 (AGPL-3.0)

基于 [InkOS](https://github.com/Narcooo/inkos) (AGPL-3.0) 改编
