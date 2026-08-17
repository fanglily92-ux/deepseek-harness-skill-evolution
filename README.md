# DeepSeek Harness Skill Evolution

一个本地、可审计、人工批准后才生效的 DeepSeek Harness Skill 自进化插件。当前版本：`0.1.0`。代码仍处于发布门审查阶段；尚未写入真实 `~/.dsh`、挂载、重启或进行真实工具调用，因此不宣称已安装。

它不让模型直接改正式 Skill。它把真实反馈压缩成隐私最小化收据，从重复失败中形成窄范围策略候选，用 stable/candidate 成对回归证明候选在已知边界内更好，最后只在用户明确批准精确 `EVO-*` 编号后原子追加到稳定策略。

## 什么才算 Self-Evolution

完整闭环是：

```text
Feedback → Reflection → Experience → Update
```

- Feedback：来自用户纠正、验证失败、返工和确定性运行信号。
- Reflection：解决当前任务并提出根因假设；它本身不是更新依据。
- Experience：至少三个独立案例支持同一根因后，沉淀可复用、证据绑定的候选策略。
- Update：候选通过 held-out/golden、stable/candidate 成对运行、确定性护栏和人工批准后，才改变后续执行。

一次反思、一次成功或模型自评都不构成自进化。无法证明改善时，稳定版保持不变。

## V1 五层边界

| 层 | V1 实现 | 明确不做 |
|---|---|---|
| Memory | 隐私最小化收据、哈希链和经验账本 | 不保存完整 prompt、模型输出、工具参数、凭据或私人正文 |
| Policy | 追加式、证据绑定、窄适用范围的策略规则 | 不删除、重排、弱化已有稳定规则 |
| Skill | 回归通过并批准后，把策略固化到稳定 Skill 参考文件 | 不让反思器直接覆盖正式 Skill |
| Tool | 仅调用预先注册的五个演化工具 | 插件不得自主注册、自改或发布新工具；工具层变化只能成为未来候选，另行人工代码审查和授权 |
| Model | 使用当前 Harness 已配置模型做隔离评估 | 不做 SFT、RL、权重更新、provider 切换或模型切换 |

## “不会越优化越差”的可执行含义

软件无法对所有未知未来任务作数学上的绝对保证。本项目提供的是失败关闭的单调改进合同：

1. 至少三个独立 session 的失败收据支持同一机制，才允许提案。
2. stable/candidate 使用相同 provider、model、输入、工具权限和预算；评估子会话禁止执行工具，并使用不同临时根；每个 fixture 随机决定 arm 顺序，比较器只看 A/B 客观分数，结果后才解封来源。
3. 至少三个 support fixture、两个候选创建前存在的 held-out fixture，以及全部 golden fixture 必须运行。
4. 安全、隐私、人工门和关键质量必须零回归；V1 按失败机制固定主要指标，`UNCLEAR_APPROVAL` 只能使用 `golden-label-error-rate`，调用者不能自报指标或 baseline。实际 stable/candidate 值由成对评估写回并绑定到验证报告。
5. LLM 执行不是确定性的：每个 golden-label fixture 预提交标签并运行三次；总预算固定为 30 arm-runs。一次验证调用后候选即终结，不能反复抽样直到偶然通过。
6. 缺数据、并列、比较器分歧、额度不足、超时、异常或不可判定结果全部失败关闭，不修改稳定版。
7. 候选创建前绑定 stable Skill、stable catalog、fixture manifest、evaluation policy 和 evaluator 代码哈希；晋升前重算完整报告并复验绑定。晋升使用持久 journal 同时保护 catalog、version ledger 和 candidate state，崩溃后失败关闭并回滚。

V1 的实时评估只处理有预提交客观标签的 fixture；标签打分是确定性的，但模型执行本身不是。sealed A/B 比较已接入主路径，只依据关键护栏和预提交标签误差决定 winner；任何需要主观判断的候选在 V1 不具备晋升证据。

这些门只保证正式工具路径失败关闭，不声称测试集覆盖未来所有情况，也不构成对抗同一 OS 用户任意 shell 的安全边界。真实运行后的自动监控/回滚模块尚未接入主状态机。

## 威胁模型与 authority 边界

权威 plugin code、stable Skill、fixture、catalog、candidate/report、receipt ledger 和 head/count anchor 都位于 workspace 之外的 `$DSH_HOME`。插件只在 `shell`、`fs` 和当前 session policy 都是 `read-only` 或 `workspace-write` 时挂载，禁止运行中 sandbox escalation。workspace 与 authority 必须是各自请求路径的 exact realpath，拒绝 symlink/alias，并在 canonical 路径上验证双向互不包含；authority 还逐一拒绝 `os.tmpdir()`、`/tmp`、`/private/tmp`、`/var/tmp`、`/private/var/tmp` 及其 realpath 别名。project Skill 在挂载时和每次演化调用时都会触发失败关闭。`npm run verify:authority` 使用本机 rc.6 官方 `dsh-sandbox-local` 真实进程验证 workspace 可写、非临时 authority sibling 不可写，并确认 workspace alias 会在调用 sandbox 前被共享守卫拒绝。

此边界防御通过 Harness agent 工具的绕过，不宣称防御已获得同一 OS 账户和独立本机终端权限的恶意进程。所有权威路径在打开前逐级拒绝 symlink；跨进程 lock、anchor 和 journal 对并发与崩溃失败关闭。

## 组件

- Cordis 插件入口：`index.js`
- 五个工具：`evolution_status`、`evolution_review`、`evolution_propose`、`evolution_validate`、`evolution_promote`
- `evolution_validate` 返回 exact diff、全部绑定哈希、support/held-out 结果、guardrails、预算/不确定性和回滚条件；`evolution_status` 可再次呈现待批准证据卡，并纯生成工作台 Markdown 投影，不把投影当权威状态。
- 可发布 Skill：`skills/optimize-work-strategy/`
- 支持/held-out fixtures：`eval/fixtures/`
- 只读环境检查：`scripts/doctor.js`
- 默认零写入的 preset 安装预演：`scripts/install-harness.js`
- 真实 rc.6 sandbox 边界探针：`scripts/verify-harness-boundary.js`

## 兼容性

- Node.js `>=22`
- DeepSeek Harness `0.1.0-rc.6`（精确版本）

插件运行时无 npm 依赖；工具定义使用本仓库的严格 JSON Schema 适配层，避免把 `0.1.0-rc.6` 插件与 npm 自动解析出的 `rc.7` peer 树混用。

V1 拒绝在其他 Harness 版本上安装，不做猜测性兼容。

## 本地验证

```bash
npm ci
npm run release:check
npm run verify:authority
npm pack --dry-run
```

`release:check` 依次运行测试、JavaScript 语法检查、敏感信息扫描和锁文件许可证检查。测试全部使用临时目录，不修改真实 Harness 配置。

## 安装前授权边界

以下状态必须区分：代码完成、测试通过、Harness 挂载、真实工具调用、用户批准安装。前两项不代表后三项。

安装会涉及两类写入：

1. 将已审查的 plugin manifest 复制到 `$DSH_HOME/plugins/deepseek-skill-evolution/<version>/`，并将 stable Skill 复制到 `$DSH_HOME/skills/optimize-work-strategy/`。目标存在或 project `.dsh/skills/optimize-work-strategy` 会 shadow 时必须失败，禁止覆盖。
2. 向用户 preset 的 `agent.cordis.yml` 追加指向受保护 plugin 的 row，配置 `workspace` 与 `authorityRoot`。真正写入同时需要完全匹配的 preset 哈希和 source-manifest 哈希，并创建内容寻址备份；任一步失败都删除本次新建的目标。

插件不会修改 shipped preset、provider、model、权限、凭据、全局 npm 包或 Harness 官方源码。对任何真实 `$DSH_HOME` 写入，必须先向用户展示目标、diff、哈希和恢复点并取得明确批准。

## 安装预演

先设置指向目标项目的绝对 workspace 路径：

```bash
export EVOLUTION_WORKSPACE="<absolute-workspace-path>"
node scripts/install-harness.js --workspace "$EVOLUTION_WORKSPACE"
```

默认模式只输出：目标 preset、修改前/后哈希和待追加 block，`writePerformed` 固定为 `false`。

用户审查并明确批准后，才可使用预演返回的精确哈希：

```bash
node scripts/install-harness.js \
  --workspace "$EVOLUTION_WORKSPACE" \
  --apply \
  --expected-preset-hash "<approved-sha256>" \
  --expected-source-manifest-hash "<approved-sha256>"
```

不要在未经授权的机器上执行第二条命令。

## Doctor

```bash
node scripts/doctor.js --workspace "$EVOLUTION_WORKSPACE"
```

Doctor 只做只读的磁盘预检：平台、Node、`dsh`、Harness 版本、插件入口、preset row、Skill、白名单、收据/候选/版本账本、未知 lock 和工作台投影是否存在。返回值固定包含 `scope: "disk-preflight-only"` 与 `mountVerified: false`；它不能证明 Cordis 已挂载、工具已枚举、hook 已执行或当前 session sandbox 生效。安装前 preset/state 检查失败是预期状态，不等于代码测试失败；真实挂载必须在授权安装后通过重启、五工具枚举、`evolution_status` 和实际 pre-execute ask 分别验证。

## 数据与状态

权威运行状态保存在 `$DSH_HOME` 内，workspace 只有可删除的隔离评估目录和可重建 Obsidian 投影：

```text
$DSH_HOME/.skill-evolution-authority/state/
$DSH_HOME/skills/optimize-work-strategy/
$DSH_HOME/plugins/deepseek-skill-evolution/<version>/eval/fixtures/
<workspace>/tmp/DeepSeek-Harness自进化/evals/          # 可删除
<workspace>/知识库/DeepSeek Harness自进化工作台/ # 可重建投影
```

候选不会写入任何 Skill discovery root。`evolution_status.projection` 由权威 catalog/candidate 状态纯函数重建 Markdown；项目内同名笔记可以删除重建，不能反向驱动晋升。持久收据只包含哈希化 session 坐标、结果类别、错误机制、计数、时长和事件序号，不包含原始输入输出。

收据持久层仅保存哈希化 session 坐标、结果类别、错误机制、计数、时长和事件序号，不保存原始输入输出。head/count anchor 位于 authority state，可检出整链截断或重写。

## 当前发布门

仓库可以独立审查和运行本地测试，但仍在等待第二次独立复核。维护者不会由此仓库自动创建 GitHub remote、push、安装到真实 `$DSH_HOME` 或宣称真实 Harness 调用已验证。当前真实 stable Skill 已包含模糊批准防线，因此真实 model baseline 可能已经为零；届时候选必须因无严格改善而失败关闭。是否存在可改善 baseline 只能在发布后、经用户另行批准的真实调用门验证，不能由 stub 测试冒充。代码完成、测试通过、独立复核、公开发布、用户批准安装、重启挂载和真实调用是独立门。

## 第三方说明

项目只借鉴公开架构机制，不复制第三方实现。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。许可证见 [LICENSE](LICENSE)。
