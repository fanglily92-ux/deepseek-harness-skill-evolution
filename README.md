# DeepSeek Harness Skill Evolution

一个本地、可审计、人工批准后才生效的 DeepSeek Harness Skill 自进化实验原型。当前版本：`0.1.0`。尚未通过真实 Harness 挂载与调用验证，不应安装到生产工作台。

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
2. stable/candidate 使用相同 provider、model、输入、工具权限和预算；评估子会话禁止执行工具，并使用不同临时根；每个 fixture 随机决定 arm 顺序。
3. 至少三个 support fixture、两个候选创建前存在的 held-out fixture，以及全部 golden fixture 必须运行。
4. 安全、隐私、人工门和关键质量必须零回归，预先声明的主要错误指标必须严格改善。
5. LLM 执行不是确定性的：每个 golden-label fixture 预提交标签并运行三次；总预算固定为 30 arm-runs。一次验证调用后候选即终结，不能反复抽样直到偶然通过。
6. 缺数据、并列、比较器分歧、额度不足、超时、异常或不可判定结果全部失败关闭，不修改稳定版。
7. 晋升前再次校验收据链、候选内容哈希、fixture manifest、evaluator 版本、基线哈希、验证报告哈希、lock、备份与写后条件，并由 Harness `tools/pre-execute` 发起最终一次性批准。

V1 的实时评估只处理有预提交客观标签的 fixture；标签打分是确定性的，但模型执行本身不是。匿名 A/B 比较器只有独立单元测试，尚未接入真实主观模型评审；任何需要主观判断的候选在 V1 不具备晋升证据。后续接入匿名 A/B 仍需独立复核，不能用模型自评替代。

这些门只保证正式工具路径失败关闭，不声称测试集覆盖未来所有情况，也不构成对抗同一 OS 用户任意 shell 的安全边界。真实运行后的自动监控/回滚模块尚未接入主状态机。

## 威胁模型与当前阻断

当前权威状态仍位于 agent 可见的 workspace。插件对 symlink、跨进程 append、CAS、哈希绑定和正式工具流程做了加固，但无法阻止同一用户权限下的任意 shell 直接改写 workspace，再同时伪造相关状态。要把“不能绕过晋升”做成真正安全边界，必须把权威 catalog、候选、fixture manifest 和 ledger anchor 放进经验证的 host-owned、agent 工具不可写区域，并验证 Harness sandbox 对 shell 同样生效。

因此 `0.1.0` 的结论是：代码实验原型与本地测试可审查；安装、公开发布、真实晋升均被此架构门阻断。人工批准仍是必要条件，但不能弥补缺失的 OS/进程隔离。

## 组件

- Cordis 插件入口：`index.js`
- 五个工具：`evolution_status`、`evolution_review`、`evolution_propose`、`evolution_validate`、`evolution_promote`
- 可发布 Skill：`skills/optimize-work-strategy/`
- 支持/held-out fixtures：`eval/fixtures/`
- 只读环境检查：`scripts/doctor.js`
- 默认零写入的 preset 安装预演：`scripts/install-harness.js`

## 兼容性

- Node.js `>=22`
- DeepSeek Harness `0.1.0-rc.6`（精确版本）

插件运行时无 npm 依赖；工具定义使用本仓库的严格 JSON Schema 适配层，避免把 `0.1.0-rc.6` 插件与 npm 自动解析出的 `rc.7` peer 树混用。

V1 拒绝在其他 Harness 版本上安装，不做猜测性兼容。

## 本地验证

```bash
npm ci
npm run release:check
npm pack --dry-run
```

`release:check` 依次运行测试、JavaScript 语法检查、敏感信息扫描和锁文件许可证检查。测试全部使用临时目录，不修改真实 Harness 配置。

## 安装前授权边界

以下状态必须区分：代码完成、测试通过、Harness 挂载、真实工具调用、用户批准安装。前两项不代表后三项。

安装会涉及两类写入：

1. 人工把仓库内 `skills/optimize-work-strategy/` 放入目标 workspace 的 `.dsh/skills/`。当前安装脚本不执行这一步；如果目标已存在，必须先独立 diff，禁止覆盖。
2. 安装脚本只负责向用户 preset 的 `agent.cordis.yml` 追加一个插件 row。它先生成 SHA-256 预演；真正写入需要显式 `--apply` 和完全匹配的预演哈希，并创建内容寻址备份。

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
  --expected-preset-hash "<approved-sha256>"
```

不要在未经授权的机器上执行第二条命令。

## Doctor

```bash
node scripts/doctor.js --workspace "$EVOLUTION_WORKSPACE"
```

Doctor 只读检查平台、Node、`dsh`、Harness 版本、插件入口、preset row、Skill、白名单、收据/候选/版本账本、未知 lock 和工作台投影。安装前 preset/state 检查失败是预期状态，不等于代码测试失败。

## 数据与状态

实验原型的运行状态只保存在 workspace 内：

```text
logs/DeepSeek-Harness自进化/state/
tmp/DeepSeek-Harness自进化/evals/
.dsh/skills/optimize-work-strategy/references/strategies.yaml
```

候选不会写入任何 Skill discovery root。持久收据只包含哈希化 session 坐标、结果类别、错误机制、计数、时长和事件序号，不包含原始输入输出。

这一布局便于审计，但不是对抗性权限边界；它正是当前禁止安装的原因。生产设计需要独立的 host-owned authority root 和外部 ledger head/count anchor。

## 当前发布门

仓库可以独立审查和运行本地测试，但当前独立复核结论为“不适合 merge/install”。维护者不会由此仓库自动创建 GitHub remote、push、安装到真实 `$DSH_HOME` 或宣称真实 Harness 调用已验证。安全边界修复、二次独立复核、公开发布、安装、重启挂载和真实调用是六个独立门。

## 第三方说明

项目只借鉴公开架构机制，不复制第三方实现。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。许可证见 [LICENSE](LICENSE)。
