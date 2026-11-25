# 官方 0.2.22 定制构建与配套切换方案

状态：已实施并部署。2026-11-25 经用户明确授权，45001 已更新官方 0.2.22、定制 Core `.0.2.22.1` 和鲸栖 `1.0.0-beta.4.dev.16`，原私聊模型及发送、两个 Liveware 运行检查通过。未发布 GitHub 新版本。

此前恢复连接的记录保留在文末。以下为本次构建和整组切换的依据；已完成内容及验收结果集中在末节。

目标：保留现有媒体回执、权限读取、两个私有 Liveware 中继、主人共享会话和正文确认回调，将官方底座、定制 Core、官方 Runtime、鲸栖包及启动记录作为一组更新。本轮不做全面业务解耦。

## 已知基线与证据

- 仓库登记组合为鲸栖 `1.0.0-beta.4.dev.15`、官方底座 `0.2.20`、定制 Core `0.1.0-beta.9-whalenest.0.2.20.1`；45001 机器的切换前事实须重新采集。
- 目标官方提交为 `1ac78bcd51f60121d98bfe3def43a2bdba230a5b`，对应集成包 `0.2.22`；既有 Linux amd64 包核对摘要为 `ac0f4d20a593edc6812cfc1774488ee2d59e77bb1b29f3870b2bd9dc400aa244`。
- 固定资料：`.whale-nest/verification/connector-intrusion-audit-20261124/` 的 `official-latest-artifact.json`、`all-patched-files-official-comparison.json`、`platform-runtime-comparison.json` 和 `official-runtime-cli-020-022.diff`。
- 13 个既有补丁生产文件在官方 0.2.20→0.2.22 间逐字相同，补丁新增的 relay 文件仍无官方同名文件。这只支持最小重放方案，不等于 `git apply --check`、编译或行为验收通过；补丁测试文件仍须单独核对。
- 官方 `lib.mjs` 与 `dsh-bridge.sh` 相同，`cli.mjs` 已变化：新增浏览器对话/用量接线和上传地址修复，依赖 `browser-chat.mjs`、`web-activity.mjs`、`media-upload-url.mjs`。不能只替换 Core 二进制。

11 月 25 日补充完整源码树对比：`ce61…`→`1ac…` 共 11 份文件变化，其中 8 份生产源码、3 份测试。除上述 Runtime 接线外，还增加重新配对时的 Agent UID 一致性校验（相同主人也拒绝替换原 Agent UID，保留原凭据），以及 ClawChat/WebUI 使用活动判断；后者不是精确 Token 或费用统计。浏览器适配新增文本发送、流式回答、停止、状态查询与回合去重，并被纳入排空及停机处理；旧版已有网页聊天入口，新增的是平台标准接线。此次 WebSocket 文件变化仅为活动记录，不能从分支提交日志推断重连修复是 0.2.20 之后新增。首次问候重试代码没有变化。完整差异保存为忽略目录中的 `official-020-022-complete.diff`，来源为[两个官方源码树](https://github.com/x-metheus/clawchat-plugin-connect/compare/ce61bb4ec5fdab6315873775204b00b6c826da24...1ac78bcd51f60121d98bfe3def43a2bdba230a5b)。后续回归须覆盖原配对 UID 保护和媒体配置修复，不只验证原扩展补丁。

## 最小配套变更

| 位置 | 本次配套范围 |
| --- | --- |
| `integration/clawchat/core-media/core-extension.patch` | 在目标提交的干净检出重放当前扩展；将包及 `CONNECT_VERSION` 同改为 `0.1.0-beta.9-whalenest.0.2.22.1`，重新生成工具说明和 Skills；只修实际冲突。 |
| `integration/clawchat/core-media/SOURCE.json`、README | 更新 platformVersion、upstreamCommit、定制版本及重新生成的 patch/binary/Skills 摘要；记录 Linux 目标、编译器、官方包和完整运行文件来源，保留许可。 |
| `integration/clawchat/SOURCE.json`、`base/*` | 从目标签名包的官方 DSH 插件核对 provider、bridge、question/tool-policy/frame/history 及 manifest；相同文件复用并更新来源，变化文件逐项移植。不得仅改 baseline 字符串。 |
| `scripts/build-runtime-base.mjs`、`scripts/build-connect.mjs` | 对目标资产重新验证所有替换锚点及复制文件。字节未变且现有构建通过时保留代码；有变化才做对应最小修改。 |
| `src/connector-extension.mjs` | 审核后将 `coreCommit` 配到目标提交；继续校验真实 `source.json`、Core 与 Skills。完整复制新官方 `runtime/`、official-plugins、updater-skill，并登记/校验 cli 及其依赖，不能只验 lib。lib 原始摘要经包内复核相同后可沿用。连接器缓存身份应包含官方底座/Runtime 指纹，避免复用旧目录。 |
| `deploy/serve-media.mjs` | 与上述模块同批交付，校验新增 Runtime 摘要，继续进入已核验的官方宿主。构建/预检负责版本配套，启动不恢复旧的提交号硬比较；保留旧记录的兼容回退。另须核对官方与鲸栖首次问候的责任及 SDK profile，解决原配对重启后官方问候反复启动额外 SDK 的现场问题，不伪造发送回执。 |
| `scripts/update-m2.mjs`、必要的 `src/runtime-upgrade.mjs` | 增加显式候选官方底座输入；当前只读 `state.selected`，无法在旧服务在线时准备 0.2.22。把扩展、Skills、updater-skill 和目标 Runtime 预检移到 `preflight` 返回前；`alreadyActive` 须核对整组目标，不能仅看鲸栖版本。记录官方选择状态及整组恢复信息，停机前固定所有输入摘要。 |
| 发行声明与文档 | 用新鲸栖候选版本打包；验收后声明 `prerequisites.clawchatIntegration` 为 0.2.22 并同步 STATUS/UPSTREAM/开发说明。dev.15 对旧定制组合返回 `migration-required` 是保护，应由本次配套切换解决，不删除保护来强行升级。 |

11 月 25 日与现有扩展交叉核对：本次新增内容不能直接替代任何现有 Core 扩展。上传地址修复作用于我方同样复用的官方上传链路；新浏览器状态/去重查询的对象是浏览器回合，不能替代工具请求只读查询；浏览器适配在临时 DSH_HOME 开会话，不能替代当前主人私聊句柄的借用。另确认必须补齐启动转发：当前包装器只把 `__clawnest-state`、`__clawnest-owner` 交给官方平台二进制，新增 `__clawnest-usage` 会误入按 `src/bin.ts` 构建的定制 Core 并被拒绝；需交给实现该命令的官方 `platform/entry.ts`，并覆盖活动查询回归。这是静态确认的候选适配缺口，未在当前 0.2.20 实例执行该新功能。

`build:distribution` 刻意不包含 `src/connector-extension.mjs`，也不包含部署脚本；因此必须交付同一源码批次的安装工具/启动文件，单独上传 `.connect-plugin` 不足以完成本次迁移。`upstream.lock.json` 的早期兼容桥历史项保留其含义，不把它冒充当前 Core 来源。

## 构建与本地验收顺序

1. 保存当前脏工作区的私有基线与任务输入摘要；另建干净官方目标检出和独立输出目录，不改研究快照。
2. 对目标提交执行 `git apply --check`，再应用补丁、更新两处定制版本；按现有说明用固定 Bun 1.4.4、`bun install --frozen-lockfile --ignore-scripts`。重新运行 typecheck、生成工具参考和 Skills manifest，编译 `bun-linux-x64-baseline`，最后写入真实摘要的构建清单。
3. 核验官方 0.2.22 签名包及来源，先解包到独立 staging；核对 integration/source、完整文件摘要、宿主要求、官方插件与更新技能。此时不修改现网 selected、配置、服务或启动器。
4. 核对官方 DSH 插件资产，构建配套鲸栖 Linux 包及 `distribution.json`，打包同批部署入口；从独立干净检出复核包内来源、许可、摘要及实际文件集合。
5. Core 在单机串行限制下运行扩展相关测试：媒体/工具、CLI、插件平台、原生会话、激活代际、正文回调与 relay；同时覆盖官方本次 Runtime 变更。尚未运行的集合不得写成通过。
6. 鲸栖执行 `npm run check`，并由 `npm test -- ...` 串行覆盖 connector-extension、distribution、runtime-upgrade、live-update、plugin-updates、official-connector-native、媒体/语音及 realtime-native/realtime-call。只按实际影响补充；保留失败路径、重启去重及组合回退覆盖。
7. 新增有意义的迁移用例：旧服务在线准备新底座、缺少新 CLI 依赖、同鲸栖版本更换 Core、输入变化、预检失败不停车、切换中断恢复、回退保留新增会话/作品/未知回执。

## 45001 部署与回退顺序

1. 连接已恢复后采集一次实际账号/主人/原私聊、selected/running、宿主和 Node、模型/DSH 接线、cwd、可执行文件、两个应用、活动任务和配置摘要；与本次候选及旧组合恢复点匹配。
2. 在线完成官方包 staging、完整候选安装目录、运行包、部署文件、依赖/离线安装预检。核对官方升级入口的实际能力；现有 `plugin upgrade --defer` 不能未经核对当作“只暂存”。目标是先准备候选，整组就绪后才切换。
3. 准备官方选中/运行状态、配置/插件锁、实例配置、override、启动脚本和 supervisor 的整组回退记录；旧 Core/Runtime/鲸栖包保持可用。重新确认输入未变、队列空闲，排空并停止同一个 dsh-agent 及业务写入者，确认唯一 SDK 退出。
4. 每次冻结使用独立空目录，保留软链接语义；保存最新业务数据、原生 sessions/storages 和回执。串行切换官方选择、匹配的扩展/Runtime/启动记录、鲸栖包及实例接线，再启动原服务和两个 Liveware。禁止让 0.2.22 宿主与旧定制记录先独立上线。
5. 实机重新核对 ready/connected=true、draining=false、selected/running 与实际扩展底座一致、原身份与私聊、唯一 SDK、历史/媒体/作品保留、两个本机及公网中继和匿名访问限制；完成标记“运维自测”的真实模型对话并取得原通道 message ID，分别记录入站/出站及客户端边界。
6. 失败先停止新写入者，保存切换后的新增数据、原生会话、作品及未知回执；按兼容性恢复旧官方选择、Core/Runtime、鲸栖包、配置、override、启动文件与服务，再复查原身份及健康。现有 `update-m2 rollback` 尚不恢复官方选择，不能单独冒充本次整组回退；不能覆盖整库或重做未知付费/发送任务。

交付层级：本次代码、构建、相关本地回归和 45001 部署及实机验收已完成，具体验收边界见末节。标签、Release 和发行资产上传仍须另获明确发布同意，本次未发布。

操作依据：[现有实例更新](../DEVELOPMENT.md#现有实例的直接更新) · [本地开发及远端验收](../DEVELOPMENT.md#本地开发后进行测试机最终验收) · [ClawChat 自测](../DEVELOPMENT.md#clawchat-对话自测) · [扩展构建](../../integration/clawchat/core-media/README.md)

## 45001 现有连接恢复记录

2026-11-25（北京时间），复核实际鲸栖 dev.15、官方底座 0.2.20 和定制 Core `.0.2.20.1`，未改变账号、模型、工作目录、运行文件或配置。原始探针 `paired-chat-ready` 为 `available=false、connected=false`，退出码 2；主人和配对信息仍在。

通过同配置临时诊断确认，SDK 的全部桥接依赖最终均可提供；实际失败为 `createCompanion` 打开已有 `runtime.lock` 时 `EEXIST`。锁登记的 PID 776439 已不存在，主机和实例一致。外层错误 `workspace-registry-missing` 实为通用握手超时报错，并不证明该组件缺失。原服务停止后，执行 `waitForSdkExit`，再使用 `node scripts/recover-lock.mjs INSTANCE_JSON --offline` 回收经过核验的死锁；随后恢复原服务。本轮只改变运行锁及正常启动产生的运行状态，没有业务代码改动；现有保护逻辑未被绕过。

相同探针转为成功，身份、配置摘要及 Core 摘要保持一致。两个 Liveware 的本机和公网中继均通过。原私聊通过已有语音桥完成一轮标记为运维自测的真实模型文本回合，回答“连接恢复正常”；原 Core 文本发送取得 `succeeded`，message ID 为 `msg-01M87DB376TQ6NABZVCPZ6CE78`，测试借用的通话会话已释放。此路径使用语音模型，不代表普通 ClawChat 客户端入站或音频播放验收；没有调用 ASR、TTS 或歌曲/图片生成。实例保留这轮运维记录，不再声称用户状态全空。

范围内交付为现有连接已恢复、运行检查及文本回执通过；0.2.22 代码、构建、回归和部署仍未实施，也未发布。原始诊断、恢复结果及最终健康集中保存在忽略目录 `.whale-nest/verification/connection-recovery-45001-20261124/`。安装器应沿用上述离线死锁核验入口，并在候选组合验收时补测容器重启后的恢复；不得通过自动抢占活锁来消除启动错误。

最终进程检查发现另一独立边界：鲸栖桥接 SDK 与运行锁匹配，但官方 `cli.mjs serve` 还在启动不带桥补丁的 SDK。现场 `greeting-receipt.json` 缺失、`greeting-draft.json` 为 pending、`clawchat/greeting.md` 非空，日志反复报告首次问候待恢复。对应官方 `sendInitialGreeting` 创建 `DeepSeekHarness`，只加载模型 patch，90 秒初始化超时后关闭；每 5 秒调度检查会再次尝试。因此总 SDK 数检查未通过，最终报告区分 `connectionRestored=true` 与 `singleSdkCheck=false`，没有把全部检查标为成功。本轮未修改此功能或记录虚假送达；后续需完成问候归属与 profile 适配，再验证重启后没有重复问候和额外问候 SDK。

## 0.2.22 实施及验收结果

用户确认执行后，在独立官方源码目录重放扩展，实际 `git apply --check`、两套 typecheck、工具文档和 Skills 生成、Linux baseline 编译均完成。Bun 固定 1.4.4；本机静态 typecheck 使用 768 MiB，运行回归仍为 384 MiB 串行。原测试在含空格路径有两项上游路径编码失败，改用同源码的无空格构建目录后 283 项全部通过，没有改官方测试。

产物与启用组合：官方包 SHA-256 `ac0f4d20a593edc6812cfc1774488ee2d59e77bb1b29f3870b2bd9dc400aa244`；Core SHA-256 `2f4b77ffd19cc96c6a303623f429df0e8e09ffa403f8bc95fe3546e1c099b58e`；Skills manifest SHA-256 `8fda08e001bb86290ee4f07d3e21661fb546ee7292aaf41890b36b5a22227498`；鲸栖 dev.16 运行包 SHA-256 `049d4f3c869702b0fdeeba7b9586084f45e7abab4d00a2f4abd93778cb8337f1`。官方 `plugin install --version 0.2.22` 仅暂存且保留原 selected，完整预检通过后才停机、选择官方目标并切换配套代码及 profile；原生签名宿主保持原样。

已实现完整 Runtime/Skills/官方插件/更新技能校验，缓存包含底座路径与内容指纹，`__clawnest-usage` 转官方平台入口。安装器预检覆盖扩展和启动依赖，同鲸栖版本更换 Core 不再被误跳过；官方选择通过原公开 CLI，保存新旧目标与任务指纹，识别输出丢失和选择已写但 job 未写的中断窗口，不重复升级。回退核对当前选择和文件归属，恢复匹配的 profile、启动器及工具，保留前向数据；候选支持文件的部分安装与 profile 回执丢失按前后摘要恢复。原服务和两个 Liveware 配置沿用。

启动问题按作用范围适配：全局 sdk profile 只移除历史两行 JSON-RPC 禁用，原人格/权限逐字保留；鲸栖桥及运维探针在自己的 overlay 局部禁用该服务，避免 `sdkSessionActivation` 冲突。启动前只恢复同主机、同实例、PID 已死且无 SDK 的运行锁。实机原桥恢复成功；官方 SDK 也完成真实首次问候，回执 `msg-01M87FE7S7J1JTS95M7EJSSCF6`，最终只有一个 SDK，原后台问候重试不再持续。

本地鲸栖相关回归三组 10、50、23 项通过；Linux 启动/更新/恢复 41 项通过。额外 Linux 原生集合先遇到 umask 下样本文件权限与测试依赖接线问题，已修正；再次执行因与在线服务叠加触发内存保护而中止，未记为通过。没有降低生产文件校验或修改内存保护阈值。通过实际安装后的原私聊原生模型、官方 SDK、Core 媒体上传和应用接线验证关键运行路径。

实机结果：原身份和设置保留；通话、歌曲业务五份文件与 dev.15 摘要一致。原生模型复用原 Session，历史保留，回复“鲸栖更新后聊天正常”，未调用额外工具。原 Core 确认文字 message ID `msg-01M87FHWNA7QX6KTZSQHREKSDP`，图片 message ID `msg-01M87FHYTFD0QMKYMQ03M38NTP`；未重复提交发送。新使用活动查询成功；通话共享私聊准备与释放成功；歌曲主人页、匿名拒绝、两个本机服务和公网中继均通过。官方 selected/running 和实际 Core 均为目标组合，`ready=true、connected=true、draining=false`。

边界：本轮没有重做麦克风、声音听感或付费写歌；平台未打开新版 browser adapter 开关，因此未实测平台网页入口。用户未做验收反馈，不将运维验证当作用户验收。未执行发布。原始记录和报告在 `.whale-nest/verification/connector-022-adaptation-20261125/`，保留前次恢复证据。
