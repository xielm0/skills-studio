---
name: skill-creator-sop
description: 根据我制定的流程去创建一个good skill, 只负责创建一个good skill，不负责修改和优化skill。仅在用户明确调用时触发, 不自动触发。
---

# Good Skill Creator

## 目标和 边界
根据流程创建一个good skill，只负责创建一个good skill，不负责修改和优化已有的skill

## 流程

### 1. 准备最小输入
按 `references/skill-brief.md`的流程准备最小输入

### 2. 创建skill
调用 `skill-creator` skill 完成创建

### 3. 优化skill
调用 `skill-improve` skill 优化 Skill。

### 4. 审阅skill

4.1 调用 `skill-doctor` skill 审阅 Skill，输出诊断报告。

4.2 读取诊断报告，直接修改目标 Skill。
- 只修改与诊断问题直接相关的内容，不扩展用户已确认的需求。 
- 修订完成后，对照诊断报告确认每条意见已处理且没有引入新缺口；


## 最终输出和质量要求

### 最终输出

一个 Skill，主文件为 `<目标 Skill 根目录>/SKILL.md`；确有需要时还可包含 `references/`、`scripts/` 和 `assets/` 中的相关文件。 

### 质量要求
`SKILL.md`的质量要求有： 
- `SKILL.md` 有合法的 YAML frontmatter，`name` 和 `description` 符合要求；
- 有清楚的目标；有清晰的工作流；有明确约束；有最终输出的质量要求。
- 工作流的重要步骤和分支完整，不存在会导致 AI 作出不同关键决策的实质性歧义。 
- 引用的本地文件真实存在并说明读取时机；
- 不得包含 TODO、占位内容或不会被使用的文件。
- 不超过 500 行；
- 内容提炼清楚即可，不要事无巨细。

## 注意事项

- 禁止做隐藏性假设。
