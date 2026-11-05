---
name: skills-studio
description: 通过 skills-studio CLI 管理用户的中心技能库——列出、安装、部署（同步到 Agent 目录）、撤下、删除技能，查看 Agent 清单与库备份状态。当用户想让某个 Agent 获得或移除一个技能、整理中心库、或询问装了哪些技能时使用；也可用它查到 skill-doctor 等内部评测技能的路径。不要用它替代 Agent 自身的技能执行——库操作之外的一切都由 Agent 自己完成。
---

# Skills 工作台 CLI

通过 `skills-studio` 的 CLI 管理中心技能库。你（Agent）只做两件事：调 CLI 改库与部署；按内部技能的 SKILL.md 用你自己的能力执行评测。**不调用 Skills 工作台的会话机制，也不使用它配置的模型。**

## 开始前：定位 CLI

CLI 发布在固定位置（无论库被搬到哪，这里不变）。先解析一次，把打印出的路径代入下文所有 `$SS`：

```bash
D="$HOME/.skills-studio/bin"
B="$D/skills.cmd"   # PowerShell/cmd 用户可直接用 %USERPROFILE%\.skills-studio\bin\skills.cmd
if [ -s "$D/version.json" ] && [ -e "$B" ]; then
  echo "$B"
elif [ -e "$B" ] || [ -e "$D/cli.js" ]; then
  echo BRIDGE_BROKEN
else
  echo NOT_INSTALLED
fi
```

- **打印出路径** — 可用。此后每条命令以它开头（每次调用都是新 shell，不要依赖之前 export 的变量）。
- **BRIDGE_BROKEN** — 目录里有残留但版本戳对不上（发布中断/过期副本）。**停止**，不要找别的 CLI 代替：过期副本可能缺安全修复。请用户打开一次 Skills 工作台应用，启动时会自动重新发布。
- **NOT_INSTALLED** — 本机没有 Skills 工作台或从未启动过。告知用户安装并启动一次。

## 输出契约

- **解析输出一律加 `--json`**：stdout 只有一个 JSON——成功 `{ok:true,data}`，失败 `{ok:false,error:{code,detail,retryable}}`。退出码：0 成功；1 业务错误；2 参数错误。
- 面向人的阅读输出（无 `--json`）是给用户看的，不要逐行解析它。

## 心智模型

**中心库**（默认 `%USERPROFILE%\.skills-studio\skills-library`，用户可搬到任意位置）是唯一技能源；每个 Agent（Cursor、CodeBuddy、Claude Code…）有自己的技能目录。三层状态分开：

- **入库**（`skills install`）：技能进入中心库。**默认不上架**——装完不会出现在任何 Agent 里。
- **部署**（`skills deploy --agents <id>`）：把技能同步到指定 Agent 的技能目录（建链接）。Agent 能不能看到，只看部署状态。
- **备份**（`sync push/pull`）：库内容的 Git 备份，与部署无关。

## 命令速查

```bash
"$SS" --json skills list                          # 库内技能（含部署状态 deployedAgents）
"$SS" --json skills list --source-type local-dir  # 按来源筛选：local-dir/git/zip/market
"$SS" --json skills show <id|名称>                 # 单技能详情（来源/部署/评测报告）
"$SS" --json skills install dir <绝对路径>          # 从本地目录入库（git/zip/market 同形）
"$SS" --json skills deploy <id|名称> --agents <id[,id2]>
"$SS" --json skills undeploy <id|名称> --agents <id>
"$SS" --json skills remove <id|名称> --yes          # 删库内副本并撤下全部部署；--yes 必须显式给
"$SS" --json agents list                          # Agent 清单（id/skillsDir/enabled）
"$SS" --json sync status                          # 备份状态（未初始化/领先/落后）
"$SS" --json sync push [--message 说明]            # 备份到远端
"$SS" --json sync pull                            # 从远端拉取（冲突时退出码 1 + code=SYNC_CONFLICT_PENDING）
"$SS" --json version                              # 版本、库路径、内部技能目录
```

## 规则与边界

- **install 默认不上架**：装完要 Agent 可见，必须显式 `deploy --agents`。先 `agents list` 确认目标 id，再部署。
- **remove 不给 `--yes` 时是预览**：返回将撤下的链接数且零改动。批量删除先预览；用户未确认不要加 `--yes`。
- **部署冲突会被拒绝**（`code=TARGET_REPLACED` 等）：目标位置已有非本库管理的同名内容。报告具体路径，提供两条路——入库（`install dir <该路径>`）或用户手动移走，**不要替用户删除**。
- **不越过 CLI 直接改库目录**：库内有元数据与链接语义，手工增删会破坏一致性。
- **会话与模型不归你管**：Skills 工作台的 Agent 会话、模型供应商是 GUI 内的功能，CLI 不暴露，也不要尝试调用。

## 配套技能（评测类）

库操作之外的能力由内部技能提供，位于 `version` 命令输出的 `agentsSkillsDir`（发布副本内、与 CLI 同目录）。它们**不在中心库里、也不随库部署**——需要时直接按路径读其 `SKILL.md`，由你自己的能力执行：

```bash
"$SS" --json version
```

输出的 `data.agentsSkillsDir` 即内部技能目录。

- `skill-doctor` — 对照 good-skill 标准审查某个 SKILL.md，输出审查报告
- `skill-creator` / `skill-creator-sop` — 创建新技能
- `skill-improve` — 改进既有技能

## 典型工作流

**「让 Cursor 用上 X 技能」**：`skills list` 查库里有没有 → 有则 `deploy --agents cursor`；没有则先 `install`（本地目录 / git URL / market），再 `deploy`，最后 `skills show` 确认 `deployedAgents` 包含 cursor。

**「这个技能写得怎么样」**：读 `agentsSkillsDir/skill-doctor/SKILL.md`，按其流程对目标技能出审查报告——评测结论由你给出，不经 CLI。

**「整理库」**：`skills list` 看全貌 → 和用户确认要删的 → `skills remove <名>`（预览）→ 确认后 `--yes`；删完 `sync push` 备份。
