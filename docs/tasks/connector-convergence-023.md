# 官方 0.2.23 适配与侵入收敛

状态：代码完成、本地及 Linux 受影响回归通过，dev.19 已部署源机并通过初始及真实同版本热更新实机验收。用户客户端体验待核对；本轮未重新验证客户端入站、麦克风听感或付费新歌，未发布新发行。

用户要求：基于最新官方版本，所有能无损收敛的实际完成，必要接口保留。指定源机 22257；镜像机 37303 不改动。官方签名更新源已确认为 `0.2.23`（sequence 48），固定源码 `adfec616c51f61ee6cccf8ce08dd99b80c825c50`。发布须另获用户明确同意。

## 当前组合与已完成收敛

当前源机运行鲸栖 `1.0.0-beta.4.dev.19`、官方集成包 `0.2.23`、自有 Core 构建 `0.1.0-beta.9-whalenest.0.2.23.2`。程序 `CONNECT_VERSION`、命令行版本及 Skills 清单保持官方 `0.1.0-beta.9`，自有构建身份单独记录，避免影响官方插件身份核验。实际安装的官方 Exposure 已从签名 23 资产经公开 replace/enable 更新，不能沿用源机此前残留的旧 Exposure。

| 已完成内容 | 当前实现与边界 |
| --- | --- |
| Runtime Provider | 原样消费官方 provider 的公开 factory、`runtimeAdapter.createBridge` 和 Runtime 接口；进程、会话及业务适配在鲸栖模块中，不再读官方 provider 私有 Session 字段。 |
| DSH Bridge | 自有 `dsh-bridge*.mjs` 与 `connect-bridge.mjs` 管理协议和业务；保留四个原样且有许可/摘要的帧、历史、审批、问题辅助模块；删除两份构建器对官方源码的文字替换。 |
| 模型配置 | 通话模型别名由桥进程的自有配置覆盖层加载；官方 `runtime/lib.mjs` 原样复制、核验。 |
| Liveware 中继 | 删除 Core 自启 relay、companion 私有复制及路径覆盖；使用原版官方 Exposure，鲸栖通过公开 Managed Web App 提供入口服务。 |
| 稳定卡与页面 | 保留稳定通话 App/URL，另有官方托管通话和歌曲 App，共三个资源、两个可见 launcher；保持通话与歌曲独立后端和原权限。 |
| 已绑定身份 | 正常 `dsh` 绑定改用官方 `__clawnest-state` 核对 Agent、主人及私聊；歌曲异步读取，避免阻塞页面与音频。其他绑定名缺等价查询时仍用只读适配。 |
| 工具回执查询 | 删除 Core `tool status` 修改，查询集中在鲸栖只读适配；精确请求结果仍依赖官方数据库字段，未知结果不重发。 |

稳定通话 App 不显示 launcher，始终绑定独立通话网关，供历史及新聊天卡使用；官方托管通话入口显示为“鲸栖通话 · dsh”，歌曲入口保留。官方热替换可重建托管 App，稳定卡 URL 不变。迁移只注销稳定 App 的 launcher，不删除 App、隧道或用户数据；回退通过公开命令恢复所属入口。官方 Exposure 管理账号级 relay，鲸栖不读取平台令牌或写入官方数据库。[接线设计](../technical/clawchat-integration.md)

## 仍需保留的四类 Core 接口

| 接口 | 当前公开入口缺口 |
| --- | --- |
| 媒体发送 | 官方 `clawchat_send_file` 不能接收并验证附件原发起 turn，只按调用时活跃回合推断授权；排队后可能借用另一回合。普通聊天附件与后台附件均不能仅换工具名无损迁移。现扩展保留快照、目标、元数据和真实回执恢复。 |
| 权限查询 | 公开 Plugin SDK 没有等价的已认证权限查询或工具注册入口。 |
| 共享原私聊 | 没有公开入口借用主人当前 Session、原队列与取消句柄；另建会话会损失通话接续。 |
| 正文 ACK 回调 | 有序输出不能替代真实 ACK、未知回执占位及表情使用记录的恢复。 |

定制宿主启动仍用于加载这四类必要接口；不能改回纯官方 Core 而丢失现有功能。生产首次绑定的全局主人关联、激活时间、新鲜握手条件及精确工具回执仍需最小 SQLite 只读适配；主人私聊到原生线程的直接 SQL 位于运维脚本，生产通话通过共享接口取得原句柄/nativeId。不能以同 binding 下任意 current 条目猜测会话归属。

此前“普通对话附件可安全移交 send_file”的候选结论经完整调用来源核对后已撤回；本任务不再将其列为可直接迁移方向。Liveware 身份不能直接 adopt 的限制已通过稳定卡与托管入口分离解决，不再是保留 Core relay 的理由。

## 验证与初始部署证据

本阶段源码基线、构建、原始测试、切换及实机结果集中在忽略目录 `.whale-nest/verification/connector-convergence-full-20261125/`。

- Core：最初 308 项通过；版本身份调整后的最终 339 项回归、类型检查及 Linux 编译通过。官方 Exposure 入口与 companion 摘要核对通过，实际 Core/Skills 版本为官方 b9；自有构建摘要见来源清单。证据：`core-build-official-version-progress.json`、`core-official-version-tests.log`、`core-artifact-verification.json`。
- 本地：新增模块 28 项、第二组综合 84 项、最终受影响 69 项通过，覆盖自有 Bridge/Runtime、媒体、启动、更新、回退及 Managed。Managed 覆盖独立启停、旧卡、新代际、鉴权、HTTP/SSE/WS、真实本地网关、回退未知结果及发现停止。构建、来源/文档及 vendor 校验通过。证据：`new-module-regression.json`、`second-regression.json`、`final-affected-regression.json`、`final-build-validation.json`。
- 全量：该阶段 `npm test` 388 项中 387 项通过、1 项 QQ 连接样本失败；修正后该项随最终 69 项受影响回归通过，不能把此前全量报告标为全绿。dev.19 最终受影响回归及实机结果见下节，不将旧全量报告改写为全绿。证据：`full-regression.json`、`full-regression.log`。
- Linux：94 项受影响回归通过；按现有 `update-m2` 入口完成组合预检与源机切换。证据：`linux-regression-result.json` 及部署记录。
- 初始实机：官方选中/运行 23、Core `.23.2`、dev.18 与原身份一致；真实模型文字、图片、通话文本取得原通道回执；原主人私聊线程保留。实际中继一个且使用最新官方 Exposure 安装资产，自有 relay 覆盖不存在；SDK 一个、ready/connected 为 true。新托管入口实际主人页面经真实网关通过，歌曲公开身份查询匹配。证据：`final-health-result.json` 及对应真实回执记录。
- 三条实际路由与两个 launcher 已检查，稳定原 URL 不变。没有再次清理用户数据，也未新增付费歌曲或麦克风听感验收。

## dev.18 热替换发现的缺口（已在 dev.19 修复）

实际同版本鲸栖热替换完成后，Node 检查稳定通话、托管通话、歌曲三条路由均返回 200；托管 App 已更新，可见入口仍为两个，稳定聊天卡 URL 保留。Python 探针的 403 已与 Node 实际结果区分，不能据此判定入口迁移失败。证据：`hot-node-route-result.json`、`hot-diagnosis-result.json` 及同版本替换记录。

但 Core 内通话会话端点 8896 没有随热替换恢复，独立网关 8897 与歌曲 8898 正常，Core 仍 ready/connected。原因核对指向 Runtime Adapter 懒创建：旧 adapter 关闭时撤下端点，新 Runtime 已注册但尚未 create/prepare，Managed 自身 HTTP ready 不代表通话会话入口就绪。当前公开模型目录/prepare 路径在本组合不能直接安全调用；不能仅增加等待或另建第二 SDK。

主服务重启后 8896 的鉴权 settings 已返回 200，connected/available 为 true，SDK 一个、队列为零。这次手动恢复不作为修复完成证据；随后 dev.19 在鲸栖自身更新与 QQ 重载流程补齐恢复及成功判定，最终实机结果见后文。

## dev.19 实现与最终回归

dev.19 源码已冻结并部署，所有已识别的本轮缺陷已纳入同一组合：

- **自身更新后的完整 Runtime 恢复**：普通更新以鲸栖自身 SDK 租约恢复为成功条件，不依赖通话是否开启；通话启用时再核对 8896 鉴权 settings。关闭通话仍须恢复 QQ、后台任务等原生业务，不能只恢复通话端点。恢复通过原宿主一次 restart 加持久观察完成，不另建第二 SDK；检查原身份、目标安装和空闲状态，未知重启回执不再提交。
- **QQ 重载**：新 queued 关联只需由原宿主重启自身 SDK，加载鲸栖已有实例 transition；不再写官方 configure，不再为新 QQ 任务增加 Core 插件代际或替换 Managed lease。持久任务记录原重启意图；历史未知任务只观察，不重发。关联、解除、重关联继续保持原主人记忆和 ClawChat 会话。
- **fresh 稳定通话归属**：create/bind 前持久操作 ID，create 确认后立即保存 exact App 身份；只有 bind 确认才提供可用卡片 URL。无 URL 占位防止旧版本回退时另建入口。create/bind 的未知结果不重放，不以名字猜测归属，也不把未知回退写成成功；确认过的操作允许仅恢复本地登记，不重复平台写入。
- **取消与关闭窗口**：原生 admission 前，prepare 或惰性 start 等待期间的 cancel/close 会阻止晚到的 create/prompt；admission 已确认后保留官方取消确认和终态活动，不丢回执。会话关闭同时阻止后续 RPC、晚到句柄与旧代际写入。
- **构建边界**：移除 Core patch 中仅用于构建辅助的 hunk，当前补丁 SHA-256 为 `60a2294d0c017a11a883e510741eb372bd902f12aeb7d34a0d4035b89ac8fa72`；重新干净应用、生成与编译后，Core 二进制 `b834a8c7bd87242c30e7c5e337bc513907d504a3a1d5e79c6c9c7d2daaf88b25` 和 Skills `64f73457dd5ccad784bbedb4916ee597d19c3cee43f8475033a235e6f7f36e18` 均逐字节不变。

本地候选验证分别通过 49 项更新/helper/QQ、18 项 Managed、29 项生命周期、20 项运行包/启动/回退，以及 1 项真实原生 DSH 的 QQ 关联、解除与重关联回归。该原生回归不冒充真实 QQ 用户账号操作。Linux 最终 92/92 通过。各测试集合存在覆盖交集，不相加为独立全量总数。

实际官方 Core Host 对新 dev.19 包执行安装与 activate 成功，核对 Runtime 与 Managed 注册；包 SHA-256 为 `03fc120b4f1530ce84ec0c505911b432d131bd5b767b10435822d8a361154b18`。该实际宿主验证与下节源机部署结果分别记录。构建输入中临时 Skills 软链接曾被预检拒绝，改为真实代码目录后预检通过；拒绝与修正期间源服务未停止。

本阶段证据位于 `.whale-nest/verification/connector-convergence-full-20261125/activation19/`：`runtime-activation-final-regression.json`、`managed-recovery-regression.json`、`runtime-lifecycle-regression.json`、`distribution-regression.json`、`qq-native-regression.json`、`actual-distribution-host.json`、`build-helper-cleanup.json` 和最终 Linux 报告。源机部署原始记录归入该目录的 `raw/`。

## dev.19 部署与最终实机验收

源机 22257 在预检通过后完成一次 40.1 秒配套切换，当前鲸栖 dev.19、官方 selected/running 均 0.2.23、自有 Core `.0.2.23.2`。实例设置保留，四份通话/歌曲业务文件与 dev.18 逐字一致，全局原生 SDK profile 和首次问候去重检查通过。

初始验收在原主人私聊及同一原生线程调用真实模型，回复“鲸栖完整收敛后聊天正常”。文字 ACK 为 `msg-01M87QVMM15V42XDJAGB4VP2DC`，图片 ACK 为 `msg-01M87QVPTAATPXSBYQ5NB68YKB`。共享通话 prepare/close、两个 launcher、稳定通话卡与歌曲 URL、匿名拒绝及三条路由均通过。

随后只执行一次真实公开同版本 replace，插件代际从 103 到 104，确认能复现通话冷端点。生产 `ensureRuntimeActivation` 持久一次 restart 意图并取得 accepted，随后原 SDK 租约和 8896 鉴权端点恢复。反复观察同一意图时 `attemptedAt` 不变，没有第二次 restart，也未为补验重做 replace。

Runtime helper 刚返回 ready 时，公网路由首轮观察仍为 false，原因是官方 relay 尚在启动。失败记录原样保留；后续 Node 对稳定通话、托管通话和歌曲三条路由均取得 200，三个 App 资源、两个 launcher 与稳定卡/歌曲 URL 均恢复。Runtime 就绪和公网中继就绪是分别核对的结果，不宣称刚返回时全部可用。

热更新后再经原通话桥执行真实模型文本回合，回复“通话模型接线正常”，原通道 ACK 为 `msg-01M87R0GQM4BWVV63FSDT5H0DW`，`callReleased=true`。最终 SDK 一个、Core 一个、使用原版官方资产的 relay 一个，无自有 relay 覆盖；原私聊原生线程一致，ready/connected 为 true、draining 为 false。歌曲公开 Agent 身份与匿名拒绝检查通过。

严格指纹核对确认源机激活代际 104 的运行包 418 个 sources 文件逐一 SHA-256 与最终候选一致。最终 21:40:39 UTC 重新获取的健康仍为 SDK/Core/最新官方 relay 各一个、三个 App/两个 launcher、三条路由正常、原线程一致及 ready/connected=true、draining=false。Linux 结构化资源报告的 memoryEvents 前后 OOM/kill 均为 0，resourceStopped=false。

原始记录位于 `.whale-nest/verification/connector-convergence-full-20261125/activation19/raw/`，包括 `verification.json`、`hot-activation-final.json`、`voice-hot-selftest.json`、`final-health.json`、`installed-source-verification.json`。前述短暂未就绪记录也保留，最终文件核对的是同一次 operation。

本轮完成代码、受影响回归、源机部署及上述实机验收，没有清理用户内容。真实客户端入站、麦克风与听感、完整客户端交互、付费新歌生成未重新测试，用户体验待核对；未推送标签、创建 Release 或上传发行资产。

## 历史基线

dev.17/自有 Core `.0.2.23.1` 完成工具回执查询与模型配置的首阶段收敛，本地 98 项、Core 282 项及 Linux 62 项通过，已被本阶段组合取代。当时保留五类 Core、桥构建替换及“后续收敛”结论均不再描述当前版本。原阶段记录保留在 `.whale-nest/verification/connector-convergence-20261125/`，早期只读分析见[连接器审计](clawchat-connector-intrusion-audit.md)。

## 媒体发送逐项比较（仅分析，未切换）

本节回应用户逐项讨论第一个耦合点的要求，继续对照固定官方 0.2.23 / `adfec616c51f61ee6cccf8ce08dd99b80c825c50` 与已部署 dev.19。未修改运行源码、功能、服务配置或测试机，未调用真实账号、模型、上传或发送；没有发布。

官方 `clawchat_send_file` 已具备图片、可播放音频、视频、任意文件、说明文字、平台消息 ID、稳定请求 ID 去重及多类未定结果保护。不能将这些共同能力作为保留媒体扩展的独有理由。当前不能整体替换，主要是接口允许的发送时机、可信来源交接与现有文件路径/结果约定不同。

| 比较项 | 官方 `clawchat_send_file` | 当前扩展 `clawchat_send_media` 与鲸栖调用方 |
| --- | --- | --- |
| 基本格式与体积 | 图片、音频、视频、普通文件；单文件最大 100 MiB | Core 同为 100 MiB；鲸栖业务另设普通附件默认 16 MiB、歌曲默认 32 MiB，可由实例设置收紧或调整 |
| 连接与上传 | 使用官方账号、上传及 WebSocket | 使用同一官方上传和连接；没有另一套 ClawChat 连接 |
| 正常回复期间的工作区附件 | 支持，在满足当前回合授权和目录条件时可以发送 | 支持，但鲸栖当前统一先把文件快照放入实例数据目录 |
| 后台、回复结束后或延迟补发 | 无活跃 ClawChat 回合就直接拒绝；不能用原会话 ID 或旧请求 ID代替活跃回合 | Core 不要求活跃回合；鲸栖调用方核验原主人私聊、会话和持久请求，支持歌曲完成后的补发 |
| 来源与目标 | 依据调用当时正在运行的回合及其发言人判断；没有可信原发起回合入参 | 鲸栖保存实例、主人、原私聊、原生会话及请求范围；Core 接口接收精确聊天目标，不自行核验原发起回合 |
| 文件目录 | 限工作区，排除 Connect/DSH 状态和凭据目录；把状态目录加入工作区也不能解除排除 | 鲸栖允许工作区及自身受控附件目录，生成内容快照后提交；Core 校验普通文件、大小、摘要和结果类型 |
| 发送成功与去重 | 返回 `sent/messageId/name/size`，共用官方工具请求表及出站/ACK 日志 | 同样共用上述机制，另返回实际 `kind/mime`；鲸栖另存业务回执，未知时只核对原请求 |
| 音频时长、图片/视频尺寸 | 保留上传服务返回的元数据；工具不接受调用方显式补写 | 可显式补写 `duration/width/height`；没有在 Core 内转码 |
| 文件内容及上传类型检查 | 无 `sha256/expectedKind` 入参 | 可核验预期摘要及上传返回的类型，拒绝不符结果 |
| 强制以下载文件发送 | 支持 `as_document=true` | 无相应开关 |
| 引用原消息与消息事件 | 工具无引用消息入参，使用 `message.send` | 有 `replyToMessageId`，使用 `message.reply`；当前 `createMediaSender` 未传引用消息参数，不能把该可选能力算作现有迁移的必需条件 |

权限检查所在层次不同：官方在 Core 内核验当前回合及工作区；扩展 Core 的 `sendMedia` 不实施这套当前回合/工作区政策，主人私聊和受控目录核验在鲸栖 `createMediaSender`。扩展不是官方授权规则的完全等价副本；本次比较不建议通过扩大工作区或关闭官方校验替代发送接口。

### 异常与回执的准确差异

- 上传失败、尚未发送聊天消息，以及平台明确拒绝：两者均可判为失败。
- ACK 超时、工具执行超时、重启中断：两者原本都有未确定状态，去重和日志也共用官方实现。官方协议层已经验证非空消息 ID，扩展的再次校验属于防御性重复。
- 连接在帧交给传输后、ACK 返回前关闭，真实 WS 层可能抛出 `StateError` 或 `TransportError`。官方 `sendFile` 不额外包装，这两类错误在当前工具分类器中会进入 failed；扩展将发送部分的一般错误保守包成 indeterminate，鲸栖随后只核对原请求，不另起发送。
- 扩展没有记录精确 handoff 阶段。同一宽泛 catch 也会把一些实际尚未发送的错误保留为 indeterminate，不能宣称扩展能精确识别所有已发/未发状态。

### 替换判断与验证证据

普通前台附件的基础发送能力与官方重合。工作区交接、内容快照、业务去重和回执登记可以由鲸栖自身管理，目录差异本身不是必须修改 Core 的理由；但当前统一快照路径不能直接交给官方接口，须设计并验证工作区交接，不能仅更换工具名称。

完整媒体链路仍不能直接整体替换：歌曲任务可能在原回复结束后完成，此时官方明确拒绝发送；官方也不接收持久任务的可信原发起回合授权。源码另表明，当前 `withPrivateVoiceSession` 共享通话队列不经过登记 ClawChat 入站回合的 `runTrackedTurn`，所以通话正在进行也不能自动满足该官方发送条件；这是调用链推导，本轮未实发通话附件。另需保持调用方明确补写元数据、实际返回类型及连接中断后的结果语义。不能为通过发送而占用另一回合、制造假用户输入或放松官方策略。是否拆分前台路径需单独比较完整调用与恢复行为，本节未实施该方案。

本地使用固定源码中两个真实工具执行函数、真实文件及官方 `sendMediaMessage` 组包实现，对平台上传/发送使用替身，禁止网络。9 项对照通过：共同前台发送/ACK、无活跃回合、当前其他主人回合的来源推断、状态快照目录、状态目录排除、强制文件、显式时长、摘要校验、一般断链错误分类。该结果证明本地接口行为，不冒充真实平台投递或客户端听感验收。

原始脚本与结果保存于 `.whale-nest/verification/connector-convergence-full-20261125/media-comparison/compare.mjs` 和 `result.json`。官方源码核对位置：`src/agent/tool-catalog.ts`、`tool-executor.ts`、`send-file-policy.ts`、`src/clawchat/ws-client.ts`、`protocol.ts`、`src/service/connect-surface-modules.ts` 与 `src/persistence/state.ts`；定制增量见 [Core 补丁](../../integration/clawchat/core-media/core-extension.patch)，鲸栖调用与回执归属见 [media-delivery.mjs](../../src/media-delivery.mjs)、后台歌曲完成回传见 [song-adapter.mjs](../../src/song-adapter.mjs)。

### 新判断标准：不改官方插件，最大程度保留功能

用户随后明确，不要求沿用当前全部发送接法，首要约束是“不修改官方插件”，在此基础上最大程度保留鲸栖业务。本节属于方案评估，尚未修改运行代码、切换实例或批准体验变化后的部署。

在该标准下，媒体扩展存在完全移除的适配路线：前台真实 ClawChat 回复期间通过官方 `clawchat_send_file` 发送工作区附件；无活跃回合时，后台任务保留生成、保存和持久投递任务，通过官方 `clawchat_mention_message` 自动发送完成通知与私有作品/受控文件链接。歌曲现有 Liveware 可承接播放和下载；其他后台附件若采用同一路线，还需在鲸栖自有服务补齐对应受控访问，不得把本地文件路径当作可用链接。需要原生附件时，在后续真实聊天回合调用官方工具，不制造假用户输入或借用另一回合。

结果判定可由鲸栖适配器管理稳定请求 ID、提交前持久化、确认后完成和未确定不重发。官方部分断链被归为 failed 时，鲸栖可以保守保留待确认，但不能凭空补造丢失的平台 ACK，也不能宣称公开精确结果查询能力已经补齐。

明确体验变化是：无活跃聊天时，后台完成结果改为“自动通知+可访问链接”，不再自动出现原生图片/音频/文件附件。首次讨论中的“不能整体无损替换”仍适用于坚持原生后台附件自动发送的要求；它不等于“在允许上述交付方式调整时无法移除媒体 Core 扩展”。其余原生格式、元数据展示、断线/重启与回执恢复还须在实施阶段逐项回归，不能将可实施路线记为已完成解耦。

### 用户新增原则与第一项无损收敛的最终核查

用户明确：基础消息投递能力由平台解决，不能盲目适配；第一项只实施已经证明不影响功能的收敛。本轮继续核对固定官方 0.2.23，不修改测试机、运行源码或官方插件，不发布。上一节“最大保留时改为链接交付”仅为曾讨论但未实施的候选，用户已明确不采用；后台附件自动直达仍是必须保留的正常能力，现有作品页继续作为附加功能。

核查确认，之前列出的可独立业务已全部在鲸栖自身实现，而不是待迁移的 Core 代码：

| 已收敛内容 | 当前实现与核查位置 |
| --- | --- |
| 主人、原私聊和会话范围核验 | `media-delivery.mjs` 的 `createMediaSender` 创建时核验，业务请求绑定实例、路由、主人和原生会话 |
| 受控文件、内容类型、哈希与快照 | `snapshot` 负责来源路径、符号链接限制、嗅探、内容哈希及只写附件缓存 |
| 业务请求 ID、参数指纹与去重 | `scope/idFor/fingerprint`、持久 receipts 及单进程 flights，重复调用沿用原请求 |
| 业务回执与结果未知保持 | `settle/check/send` 管理 confirmed/failed/uncertain，提交前落盘，未知只读核对原请求，不自动另发 |
| 后台任务目标与附件发送意图 | 歌曲等业务保存原路由、会话、作品和请求，再交上述发送器；没有用链接冒充附件成功 |

Core 当前剩余媒体部分为实际读取字节校验、认证上传、上传结果类型检查、媒体元数据与消息组包、原连接发送和真实 ACK/异常处理。它们均属于平台发送能力或接口保证，不能把提前校验、结果猜测或多后端兜底当作无损迁移。

曾进一步提出“真实前台普通文件转用 send_file”的窄候选。该候选虽可在本次真实 prompt 期间取得可信来源并避免通话/后台混用，但仍不满足本轮无损标准：官方工具没有预期 SHA 入参，并按路径延迟读取。唯一文件名与 0400 权限不是不可变内容保证。即使鲸栖提前核验，文件在 Core 实际读取前变化时，旧扩展会拒绝，新接口仍可能发出变更内容；此外消息事件和返回契约也尚未建立完整等价证据。因此撤回该候选的“可无损分流”判定，不新增发送分支，不新增后台链接替代，不改变现有行为。

使用两个真实工具函数、本地只读文件与替身传输完成精确反例：先核验原内容，再替换文件，扩展在上传前因 SHA 不符拒绝，官方 send_file 上传了替换后的字节并返回替身 ACK。该结果验证接口保证不等价，不声称真实平台已发送。原始脚本和结果保存在 `.whale-nest/verification/connector-convergence-full-20261125/media-safe-convergence/content-change.mjs`、`result.json`。

本轮交付是完成已有业务收敛的核验、撤回不能成立的迁移承诺、落实平台职责原则与缺口清单；没有可新删除且已证明无损的媒体 Core 业务块，不把已有代码整理冒充新增解耦。仍需平台提供的能力：无活跃回合的可信任务投递、读取实际上传内容时的摘要/不可变内容保证、上传结果类型与所需元数据契约、可靠且可核对的投递结果。现有媒体扩展作为尚未解决的平台依赖如实登记，不能标记“第一个已完全解耦”。

## 第二项：权限查询核查

本节按用户“继续第二项”和既定不修改官方插件、不降低功能、平台能力缺口交平台解决的原则核查。仍针对已适配官方 0.2.23 / `adfec616c51f61ee6cccf8ce08dd99b80c825c50`；本轮只读源码、独立业务回归及文档记录，没有修改运行源码、连接远端、操作真实账号、部署或发布。

### 具体功能与改动

`clawchat_get_agent_permissions` 当前在鲸栖运行源码中的唯一调用方是 `diary-publisher.mjs`。它用于查看及核验 ClawChat 日记动态的权限：

| 字段/检查 | 当前用途 |
| --- | --- |
| `moment.visibility` | 展示全局受众；新发布前要求严格为 `["owner"]`，受众扩大时直接停止，不提交动态 |
| `moment.publish` | 新发布前核对是否 allow；否则只有对应临时授权窗口仍有效才可提交 |
| `moment.delete` | 展示删除条件，撤回前核对是否 allow 或有效临时授权；不是发布动作的额外 allow 门槛 |
| `permission_windows` | 读取各动作临时授权的到期时间，不将过期窗口当成允许 |

普通消息、媒体、歌曲、实时通话和 Liveware 不调用此权限扩展。私人日记写入/读取、公开事实草稿、已有发布记录核对及 QQ 空间分支也不能与这项 ClawChat 权限读取混为一谈。该接口不会申请、授予或修改平台权限。

平台本来已有 `GET /v1/agents/me/permissions`。定制增量仅在 Core 工具目录增加这个只读工具，并复用官方既有 HTTP 请求处理、当前账号认证与设备身份，没有新建权限系统。公开动态本身仍调用官方 `clawchat_create_moment`、`clawchat_delete_moment`。

### 当前可收敛与平台缺口

主人来源核验、启用开关、草稿和完整正文确认、公开事实投影、受众/策略判断、版本复核、业务幂等、回执保存与未知不重发均已在鲸栖。Core 中没有仍可迁走的日记业务判断。

核对官方 Plugin SDK、CLI、Core HTTP、资料及运行状态入口后，当前没有可替代该工具的公开、已认证权限读取通路：SDK 没有通用平台请求或工具注册能力；CLI `tool call` 受固定目录限制；Core HTTP 没有权限查询或认证代理；profile/state 不提供这些实时权限字段的公开契约。Core 内部 `ToolHandlerContext.request` 不是对插件开放的接口，不能把私有能力当成已公开能力。

平台待补的要求应限定为：以当前绑定身份提供只读权限查询，返回全局动态受众、发布/删除策略及有效临时授权和到期时间，不暴露账号令牌、不修改权限、不生成审批或真实动态。平台已有 HTTP 接口，但连接器的插件接入能力尚未开放；不能写成平台根本没有权限查询。

不以读取官方令牌自行请求、缓存或默认权限、DSH 工具审批、Liveware 访问策略，或者先尝试 POST/DELETE 再看结果作为替代。官方创建动态工具没有原子“本次仅 owner 受众”入参；全局受众已扩大而发布仍被允许时，直接创建可能成功，无法替代鲸栖现有的提交前受众核验。尝试写入也改变了 ask/deny 时不提交审批或写请求的现有行为。当前 GET 后再 POST 也不构成永久或原子受众锁，现有预览已告知未来全局受众设置可能影响历史动态。

结论：第二项的业务部分已经在鲸栖；剩余只读认证查询属于平台连接器需开放的能力。当前不能无损删除该 Core 工具，没有新增兼容层或运行改动，保持现有发布/撤回功能。

### 验证证据

执行 `node scripts/test.mjs --reuse test/diary-publisher.test.mjs`，7/7 通过，覆盖默认私人归档与正文确认、受众/权限变化阻断写入、撤回 ask、去重、未知结果及重启恢复、ClawChat 与 QQ 发布分离。模型、动态和账号均为本地替身，没有发布真实动态；字段缺省、临时窗口和完整平台端原子行为不因这 7 项被宣称已实网重验。

原始报告及结论保存于 `.whale-nest/verification/connector-convergence-full-20261125/permissions-review/`。与已验收 dev.19 对照的 538 个非 Markdown 文件全部摘要一致。调用位置见 [diary-publisher.mjs](../../src/diary-publisher.mjs)；固定工具登记见 [Core 补丁](../../integration/clawchat/core-media/core-extension.patch)。

## 第三项：实时通话共享原私聊核查

按用户“下一项”继续核对 `withPrivateVoiceSession`，范围为保留当前文字/通话接续、同队列排队、取消及会话生命周期，不扩大到修改通话界面、音色或传输策略。固定来源仍为官方 0.2.23 / `adfec616c51f61ee6cccf8ce08dd99b80c825c50`。本轮只做源码核对、独立 Core 回归及记录，没有修改运行源码、连接测试机、调用真实模型或真实通话，也没有部署或发布。

### 现有 Core 与鲸栖职责

用户先文字聊天、再打开通话、挂断后回文字时，当前实现继续使用同一主人私聊与原生线程。Core 扩展承担下列协调：

- 核验请求属于当前绑定的主人私聊，核验调用插件仍为当前有效代际。
- 根据 Core 权威的当前会话选择及新建意图，准备或创建该私聊的逻辑会话，拒绝已不一致的旧 `sessionRef`。
- 通过原 `sessionKey` 进入与文字/客户端共用的任务队列；取消排队票据或正在运行的任务，并协调会话关闭、归档和绑定切换。
- 从原会话取得工作区、模型配置及同一个 Runtime Session 句柄，原生线程 ID 继续由标准回调附回 Core。

Core 没有实现通话 UI、录音、ASR/TTS、音频播放、HTTPS 每次 16 帧、通话模型覆盖层、语音 RPC、通话业务取消或播放账本；这些均已在鲸栖及随包通话服务中。通话用户输入与模型回复通过同一 Session 写入原生历史；played/interrupted 播放确认保存在鲸栖自己的 Map/JSON，不把它描述成额外写入官方原生 journal。

### 官方已有能力与尚缺入口

官方本来就有共享 Session 能力：ConnectClient 的 `enqueueClientTurn(sessionRef, ...)` 使用 Core 的同一队列、工作区和模型，也有取消能力。不能把本项缺口概括为“官方没有共享会话”。但现有公开接入仍不能完整替代：

| 已核对入口 | 当前限制 |
| --- | --- |
| 官方 ConnectClient | 已核验的官方客户端只列 Codex/WorkBuddy 兼容；DSH/鲸栖不在支持列表，插件没有获授同等 Core application port |
| 公开 Session 目录/详情 | 有 sessionRef/isCurrent/binding，但没有对应 chatId/owner/native thread 的完整权威映射；isCurrent 按每个聊天分别计算，不能选 binding 下任意 current 作为主人私聊 |
| Runtime Adapter 的公开 `start` | 能得到所属 chatId、逻辑/原生线程信息，但须等 Core 实际启动该 Session；不是可主动查询当前选择或取得队列的入口 |
| 普通 Client turn | 不提供当前所需的受控原 Session 借用及准备/播放状态协作入口，不能只把转写文本提交成功当作语音流程完整等价 |
| 官方 DSH browser-chat/browser-stream | 使用临时目录及 `harness.session()` 执行传入的浏览器 transcript，不是接入原 ClawChat 私聊及原 Core 队列；协议 session_id 不能直接当作原生共享会话保证 |

缓存“最后一次 start 的 Session”也不能替代权威选择。新建或切换可以先关闭旧句柄、改变 Core 选择或保存 planNext，然后等下一条输入才调用新的 start；空历史首次通话则还没有可复用句柄。只建鲸栖自己的队列，不能让 Core 的文字、归档、关闭等操作同时受同一把生命周期约束；拿另一个 SDK 或复制历史新建会话也不等价。

### 结论与平台需求

本项业务适配已在鲸栖，没有新发现可严格无损移出的运行代码。当前不能无损删除 `withPrivateVoiceSession`：剩余是宿主/连接器的权威会话选路、调度与生命周期能力。既有功能保持，不猜会话、不改写 Core 会话表、不另建 SDK、不假冒官方客户端或其 Runtime 兼容身份。

需要官方向 DSH/鲸栖插件开放受当前绑定身份约束的共享会话接入：权威定位/准备主人当前私聊，以同一队列和生命周期提交、取消并接收事件，允许与插件自身语音准备及播放状态管理协作。具体公开形式可由平台定义，不要求鲸栖获取 Core 私有对象、全局 registry 或自行维护第二套权威会话。

### 本地证据与边界

针对当前固定构建源码串行执行：

- `bun test --max-concurrency 1 tests/connect-runtime.test.ts -t "keeps voice and text on the same queued runtime handle"`：1 项通过，验证原句柄只创建一次、通话占用时正文排队、排队通话取消不执行、释放后正文继续，以及未将该通话回合重复投影到聊天。
- `bun test --max-concurrency 1 tests/plugin-platform.test.ts tests/voice-plugin-activation.test.ts`：8 项通过，包含真实宿主/绑定的主人私聊隔离与插件生命周期、当前代际核验，以及 6 项引用 Bundle 完整性/平台资产校验；不将全部 8 项称为语音专项。

本轮共 9 项通过，均使用独立本地状态、MemoryTransport 或替身 Runtime，未声称本轮重新测过 ASR/TTS、麦克风、听感或真实通道；已验收 dev.19 的自有 Runtime/原生通话证据按原覆盖范围保留。命令与原始日志位于 `.whale-nest/verification/connector-convergence-full-20261125/shared-session-review/`。

关键源码为固定官方树的 `src/runtime/connect-runtime.ts`、`src/runtime/session-turn-executor.ts`、`src/service/binding-runtime.ts`、`src/plugin/{host,sdk,store}.ts`、`src/plugin/official/connect-client-manifest.ts`、`src/client-contract/index.ts`、`src/workspaces/session-continuity.ts` 及 `platform/deepseek-harness/browser-chat.mjs`；鲸栖侧见 [platform-voice-bridge.mjs](../../src/platform-voice-bridge.mjs)、[runtime-provider.mjs](../../src/runtime-provider.mjs)，增量见 [Core 补丁](../../integration/clawchat/core-media/core-extension.patch)。

## 第四项：正文确认后自动补发表情核查

按用户“第四项”继续核对 `afterClawChatReply`。本节针对已适配官方 0.2.23 / `adfec616c51f61ee6cccf8ce08dd99b80c825c50`，要求不改官方插件、不丢失当前表情和回执行为、不用计时、轮询日志或猜测发送结果替代平台通知。只做固定源码、独立本地回归与记录，没有修改运行源码、连接测试机、操作真实账号、部署或发布。

### 实际用途及责任分配

该扩展仅把“最终正文已经由平台确认接受”的事实，按原会话和本轮输入通知鲸栖，供自动追加一张预选表情使用。确认是平台 ACK，不是用户已读或要求用户点击确认。

Core 的具体门槛为 `sendReply` 成功返回、活动为 final/complete、返回正文非空且同次 delivery 不含媒体，然后等 `surface.complete()` 完成，再调用当前已有原 Session 的 `afterClawChatReply`。参数是原入站 `message.messageId`／native inputId，不是出站 ACK 的 messageId。会话无有效句柄时不执行回调；在 complete 之前发送失败、超时或断线，不会执行该回调。

是否抽取自动表情、按场景和语义选图、避免重复手动媒体、开关及心情、持久选定结果、原输入核验、取消、发送占位、稳定媒体请求 ID、业务回执和确认后的使用记录/轮换，均已在鲸栖 `runtime-extension.mjs`、`expressions.mjs`、`sticker-selection.mjs`、`stickers.mjs` 与自身 Native Bridge 中，不在 Core 里重新实现。

收到通知时，鲸栖要求 pendingSticker 与原 inputId 相同且未取消，先清除内存 pending，再执行 afterReply；原生业务还要求对应原生回合已完成、原 connectInputId 匹配、记录符合补发条件且未有 stickerResult。发送前持久占位，只有图片确认才更新使用记录；未知不另起请求重发。Core 回调自身没有独立的 terminal==completed/cancel 判断，不能把所有取消过滤都说成 Core 做的。

自动语音在最终正文交给 Core 前，由鲸栖合成并发送，确认后才将展示正文改为“（语音回复）”；表情随后等待该正文确认。实时通话、歌曲、普通文字回复、QQ 表情及手动图片不靠本 after 回调触发。

### 官方已有能力与缺口

| 信号或替代方式 | 当前真实含义及限制 |
| --- | --- |
| Runtime `onAccepted` | 模型输入已受理，不是 ClawChat 正文已送达 |
| 原生 turn/end、Runtime final/complete、迭代结束 | 模型输出完成；Core 普通正文仍在 surface 缓冲，需等 prompt 迭代结束后 complete 才投递 |
| Client transcript/SSE complete | 运行内容/投影状态，不是出站消息 ACK；公开事件集合没有等价正文投递结果 |
| `reply_sent` 日志 | Core 在交给传输时记录，不代表 ACK；不能解析日志猜成功 |
| WebSocket ACK | 平台已有真实消息接受回执；官方 Core 内部使用，但未向 Runtime 插件公开正文发送结果通知 |
| 两条有序输出 | 官方 complete 会依次 await，已有先正文后图片的发送顺序；但 Runtime 不会收到图片实际 ACK/messageId 或对应结果，不能完整保持现有业务账本、确认后轮换、取消及未确定处理。不能把顺序本身说成扩展独有能力 |
| 一条图文正文 | 可发送图文，但改变“正文成功后独立表情”的消息形态及独立失败行为；现有实际上传字节校验也未在该通路等价，不作为无损迁移 |

### 收口结论及平台需求

本项没有新的可严格无损移出的运行代码：业务策略和状态本来就在鲸栖，Core 剩下薄的正文发送确认通知。不能以模型完成、计时延后、读取内部发送记录或接管普通正文发送来声称这项已经解耦。

平台需要向 Runtime 插件提供标准、与原会话及原输入相关联的正文投递结果事件/钩子；由官方明确已接受、失败、未确定等结果，再由鲸栖决定是否发表情。该能力属于投递结果的开放，不要求官方实现鲸栖的概率、图库、轮换或人格策略。当前保留已有扩展及功能，不增加新回调补丁或替代发送链路，不混同第一项“附件真正发出去”的媒体执行接口。

### 回归证据与边界

本轮串行执行 Core 的 `runs a supplement only after confirmed final text`，confirmed/failed/suppressed 三项通过；随后 `node scripts/test.mjs --reuse test/expressions-native.test.mjs test/expressions.test.mjs test/stickers.test.mjs` 15 项通过。共 18 项相关本地回归，覆盖正文确认门槛、原生 inputId 不匹配、重复通知、语音先行及文字保留、表情不重发、取消、图库/使用记录和重启恢复等既有行为。

Core 使用替身连接；Native 回归运行实际本地 DSH，模型、语音服务及消息发送为独立替身。没有声明本轮重新验证真实 ClawChat 入站、平台 ACK、麦克风、听感或真实表情投递。原始日志和结构化结果在 `.whale-nest/verification/connector-convergence-full-20261125/after-reply-review/`。

源码证据：固定官方树 `src/runtime/turn-surface.ts`、`connect-runtime.ts`、`session-turn-executor.ts`、`types.ts`、`src/clawchat/ws-client.ts` 和 `src/client-contract/index.ts`；鲸栖 [runtime-extension.mjs](../../src/runtime-extension.mjs)、[expressions.mjs](../../src/expressions.mjs)、[connect-bridge.mjs](../../src/connect-bridge.mjs)。

### 第四项结论澄清：回复内容与发送结果是两个问题

用户指出表情本身可以属于完整回复，随后要求给出准确结论。复核后确认：官方 0.2.23 的普通输出缓冲在 complete 时顺序 await 投递，两条正常回复可先发文字再发图片；这项基础能力本来存在，不能说“官方不能发表情”或“文字成功后再发图片一定需要我们的补丁”。选图、概率、场景匹配和同一聊天的输出可以保留。

严格保留现有行为的缺口是：普通回复输出没有向自己的 Runtime 开放真实投递结果，鲸栖不能据此准确更新图片已确认使用次数和按当前聊天最近实际使用时间轮换的记录。选中或提交输出不能当成平台已接受；未知请求也不能凭推测换编号重发。因此，完整保留既有功能与结果处理时，第四项当前不能直接删除；此结论属于连接器的插件接口能力缺口，不是基础图文投递故障。此前将“表情必须单独补发”当作不可改变前提的说法撤回，不将它用作补丁必要性的论据。

额外复核了 `requiredControl`：`output-visibility.ts` 和 `turn-surface.ts` 的实现允许该标志让 accept 立即 await 投递，从而在 yield 恢复时推知内部调用已返回。但该标志没有普通回复结果通知的公开契约，官方既有用途是审批/补充输入的控制通知；相关测试明确保证控制通知不受后续 no-reply 否决。把普通文字或表情标记成必达控制消息会改变正常回复缓冲、后续抑制及失败边界，不作为本轮无损收敛路线，也不新增此类适配。

本次为固定源码与现行需求复核，不新增测试，不修改运行源码或测试机。此前 18 项本地回归仍按其原覆盖范围保留，未将它们冒充新的替代方案验收。

## 平台开发技术交接

用户要求系统汇总并交接平台连接器开发者。本轮新增[独立技术交接](../technical/clawchat-connector-platform-handoff.md)，以固定官方 0.2.23 与已部署 dev.19 为基线，列明官方已有能力、四类剩余 Core 扩展、当前补丁的授权/回执保证边界、生产与运维 SQL、配置及安装记录结构依赖、建议接口和逐项验收。建议不冒充已经实现的官方接口；第四项不强迫照搬补发机制。平台功能实现与鲸栖后续迁移仍未进行。

并行只读复核更正了原生线程 SQL 范围：src/clawchat-state.mjs 的生产查询是精确工具回执及首次关联/就绪；scripts/probe-live.mjs 才直接查询 runtime_sessions，生产通话由共享会话接口和 prepareVoice 取得原生身份。现行 STATUS、技术设计及计划已同步澄清。另登记 clawchat-core.mjs 对官方配置/安装记录的读取；已存在公开插件/绑定查询，但尚未证明完全等价，不将其武断列为新增平台接口缺陷。

交接稿经媒体/权限、会话/状态/更新、普通回复结果三个方向交叉复核。本次交付仅文档，未改运行代码，未操作远端或真实账号，未重跑此前已成功的功能回归，未发布新版本。文档链接/来源检查和格式差异检查另存 .whale-nest/verification/connector-convergence-full-20261125/platform-handoff/。

## 平台职责重审：撤下专属接口要求

用户纠正：交接重点是平台连接器，不应为了鲸栖当前设计专门开放接口。本轮从官方支持范围和公开契约重新审查，已重写同一[平台文档](../technical/clawchat-connector-platform-handoff.md)，原稿保存在忽略目录 platform-handoff/platform-scope-review/ 的独立基线中。

撤回将四类运行依赖直接归为四项平台必需整改的判断。原 Session 对象借用、主人私聊自动选路、nativeId 暴露、afterClawChatReply/表情轮换、首次绑定 SQL JOIN/时间比较、锁文件/配置哈希和定制启动都是鲸栖实现，不应直接要求平台照搬。官方无活跃回合拒绝 send_file 是明确安全策略；发送执行时读取的路径文件未承诺等于此前预哈希内容，因此字节替换反例只能证明契约不同，不能证明平台违约。

通用操作结果查询、只读权限入口、第三方会话控制和受授权异步发送，改列为平台可讨论的扩展提案；已有插件/绑定查询应先在鲸栖适配。没有证据表明未支持 DSH/第三方调用者、Runtime 不回传普通 ACK、固定工具目录未开放权限 GET 本身违反官方现有契约。平台未接受提案时，不记作已授权开发事项。

唯一新增验证是独立于鲸栖的官方 ConnectWsClient 与 toolFailureState：普通文字帧交给内存传输、尚无 ACK 后触发 remote onClose(1006) 和 local close，实际分别抛 TransportError/StateError，分类均为 failed。仅证明该结果分类链路；未运行持久工具 worker 全流程、未证明服务端接收或实际重复发送。平台应先明确 failed 的正式语义及原操作查询，再决定是否按交接阶段修正，不能把所有同类异常一律改为 unknown。脚本与结构化结果为 platform-scope-review/ws-close-classification.mjs 和 .json。

现有运行依赖、源码、版本、测试机及发布状态保持；本轮不实施解耦。文档经平台职责、媒体/权限和结果语义方向重审，最终链接/来源和非 Markdown 指纹检查另记本轮验证报告。

## 恢复完整解耦交付目标

用户指出只审查平台职责并列泛泛提案偏离了彻底解耦的目标。本轮保留“不为鲸栖硬编码专属接口”的约束，同时恢复可执行交付：对外[完整通用契约](../technical/clawchat-connector-platform-handoff.md)定义G1–G7必要语义；内部[全部依赖对应及退出方案](../technical/clawchat-decoupling-plan.md)覆盖I01–I14与A01–A11验收。必要语义不再被删除为可有可无，但不把平台尚未支持的扩展说成现有漏洞。

补充核查了此前未完整纳入的安装/回退路径：update-m2直接写官方Runtime绑定/override、lock代际与retainedVersions；liveware-service独立入口读lock/activeArtifact；connector-cutover解析官方release/state/receipt；serve-media读取host.json后在内存替换main的agent目标（没有写回官方host.json文件）。这些均纳入鲸栖退出工作，不能仅改四个Core调用。原样factory/helpers和公开SDK依赖单独列为兼容依赖，不误报为源码侵入。

具体替代链已定义：G2回合内等待及回合外受限发送＋实际bytes/类型/元数据；G3提交前可恢复关联、逐消息结果、旧请求查询；G4只读权限；G5当前会话定位、空历史prepare、同队列Runtime声明操作、执行时上下文和旁路取消；G1区分稳定身份、插件代际和连接新鲜度；G6/G7公开安装/绑定管理及原版启动升级。Bootstrap授权仍需确认，agent add整项覆盖不能承诺已有绑定无损，须保留原公开设置并实机验证。自己的provider仍通过公开onRuntimeThreadId向Core登记线程，不对外新增nativeId读取。

三路独立复核对上述覆盖表审查；提交响应丢失、交互重复、取消与后续消息、并发安装状态、旧请求迁移等边界已纳入。当前充分性是条件级设计：G1–G7满足、I01–I14迁移且组合验收通过后，才可标记彻底解耦。没有实现新平台接口/适配，没有连接测试机或发布。此前测试只证明旧组合。原稿基线和本轮覆盖核对保存在 platform-handoff/complete-decoupling/。

## 现有启动器与更新器的迁移可达性核查

用户追问未来平台补齐接口后，现有用户能否通过当前启动器/更新器进入解耦版。源码及既有回归确认：当前dev.19对custom→更高官方基线或officialOnly返回migration-required，worker在目标包安装前终止；启动shim及serve-media仍由connector-override选择定制Core，单独升级官方包不会清理接线。测试plugin-updates已有这一拒绝路径，并未重跑。

在内部实施方案新增6.1：当前通道先安装实际兼容现定制组合的过渡版本；待旧更新任务完成并释放互斥，由新持久迁移执行器核验新官方能力、迁移旧请求并切到原版启动和解耦包。仅把迁移代码放入一个旧worker会拒绝的最终包不具可达性；过早在插件激活时改身份/接线，也可能与旧worker观察/回退竞争。后续需实现两阶段接续、断线恢复和保留数据的组合回退，再从真实旧入口测试发布。当前没有实现或部署这段迁移，也未发布过渡/最终版本。

## 现在实现并启用升级引导（dev.20）

用户明确要求当前发布前就解决未来更新入口。本轮代码增加updateProtocol=1、受限updatePath元数据、不可变精确发行解析、持久父计划/各单跳记录及source归属交接。旧请求仍走原单跳；新路线一次确认最终目标和每步要求，不因最终officialOnly先阻断兼容桥，桥接版本实际兼容现环境且声明接续能力。无需用户手动寻找中间版本，也不从metadata运行远程命令。

复用原worker.sqlite互斥和原官方安装/SDK恢复入口；每步完成只交接，新artifact目录helper才可开始下一步。review发现并修复了busy恢复被旧helper接手、queued外部改选被当新基线、child终态与parent写入之间同版本资产变化三个边界，均加入故障回归。child成功持久精确selection，避免把entry integrity误当整包SHA。初轮旧official CLI fixture触发真实激活等待而超时，已显式提供其scope之外的激活替身，生产激活逻辑不放宽。

本地96/96、Linux95/95通过；实际官方Core完成新包解析/安装/激活，运行包声明协议1。源机22257按原runtime-bundle入口预检/空闲复核后，39.6秒完成dev.19→dev.20，generation104→105；未传media-core或official-base，不改33项Core/宿主资产。源码618份冻结，安装420个sources逐一匹配。原instance/绑定、原生线程、四份通话歌曲源码、三App两入口及URL均保留，SDK/Core/官方中继各一个，无OOM。

真实运维自测通过原通话桥在原私聊执行companion_update status，原生日志确认一次工具调用及成功结果，回答dev.20空闲，原通道文字取得真实messageId；关闭运维通话后再取健康通过。脚本首次before失败是歌曲登记只存URL而无独立appId的检查器假设，修正为从已核验平台URL推导并对照官方列表后通过；失败原记录保留，没有因此操作生产服务。只读诊断原始结果存忽略目录，不含对话原文输出。

发布版现在应携带此引导能力；未来真正的接口/启动迁移代码仍须按实际平台契约实现并验收。这个边界不再要求旧用户届时先人工修更新器。当前没有发布标签、Release或资产，公开版仍beta.3。代码、回归、部署及源机验收完成；客户端感受及用户确认另记，不冒充已经用户验收。原始记录 .whale-nest/verification/update-bootstrap-20261125/，最终实机记录在activation20/raw。
## 源机冗余文件清理

2026-11-25用户要求检查测试机冗余并清理无效文件，范围为源机22257；不清空用户数据，不改变现有版本和功能，不操作镜像机37303。

先核对当前实例、官方及自有插件登记、实际进程参数/工作目录/可执行文件/打开文件/内存映射、配置/技能引用、最新部署记录及回退输入；扫描保留目录的软链接，确认没有指向删除目标。最新有效回退点为`2026-11-24T235448644Z-before-m2-live`，对应dev.19→dev.20，完整保留。当前与回退登记中仍存在的本地发行源包也保留。旧部署诊断原始记录在删除远端副本前归档到本机忽略目录，没有新增用户数据副本。

| 已清理类别 | 按硬链接去重估算释放字节 |
| --- | ---: |
| 三份过期部署备份 | 460,402,688 |
| 两套无引用旧定制连接器（22.1、23.1） | 307,314,688 |
| 旧候选源码、构建、诊断与传输副本 | 260,218,880 |
| 六份已解压官方下载缓存 | 290,029,568 |
| 当前候选的重复传输压缩包 | 6,971,392 |
| 未登记的dev.2、dev.3插件资产 | 15,405,056 |

删除前取得官方更新互斥锁、再次核对配置摘要、插件代际、目标inode/修改时间和进程引用。六份官方缓存逐个与官方已登记的完整解压目录核对：各26–34份普通文件的长度和SHA-256全部一致，才删除压缩缓存。删除采用44项明确路径，不跟随目录软链接；没有修改官方state/lock、当前代码、用户数据或运行入口，也没有重启服务。官方仍登记的六个安装版本和插件历史版本保留，不直接删除登记所指向的资产。

实测`du -x -B1 --max-depth=1 /home/node`由3,800,006,656字节降至2,459,684,864字节，净释放1,340,321,792字节，约1.34 GB；统计是用户目录分配块，不是整机系统占用。估算与实测有20,480字节差异，期间健康记录等文件仍有正常写入，未将共享硬链接重复计算为可回收空间。

保留的主要内容：QQ网关及桌面依赖约1.24 GB、官方登记的完整安装版本约786 MB、当前自有连接器约137 MB、官方登记的插件资产约181 MB、最新回退点约11.4 MB；当前候选和历史登记的源包约47.9 MB。`/opt/dsh/node_modules`约1.31 GB是运行依赖，位于上述用户目录统计范围之外，保持原样。

清理执行报告确认114份配置、当前连接器及回退文件摘要不变，SDK/Core进程PID与清理前一致。最终运行验收调用当前候选的`verify-remote.mjs ... after`：dev.20/代际105、官方selected/running 0.2.23、33份连接器资产、SDK/Core/官方relay各一个、ready/connected/idle、通话鉴权与本机页面、歌曲主人页面/匿名拒绝、三个App公网路由、原配置与业务文件及原生线程保留均通过，无OOM。仅做文件及只读运行验收，没有再次发送模型对话、登录账号、测试麦克风听感或付费生成新歌。

本机`npm run check`通过：57份Markdown、643个仓库内链接/锚点及来源/许可摘要核对通过。只修改状态和任务记录，没有修改业务源码，因此没有重复执行功能回归。

原始证据：`.whale-nest/verification/file-cleanup-20261125/`中的`before.json`、`plan-result.json`、`cleanup-result.json`、`after.json`、`final-health.json`及`final-summary.json`；执行脚本与旧部署诊断归档同目录保存。运行版本没有变更，没有发布标签、Release或资产。

## 已登记历史版本的后续清理

用户了解剩余2.46 GB的组成后明确要求继续清理历史版本。复核当前官方host源码及匹配adfec提交的Core安装管理实现：官方host仅支持status/check/install/upgrade/rollback，Core仅支持整插件删除，没有逐历史版本清理命令。本次采用一次性维护脚本整理登记和无引用资产，不新增产品清理逻辑，不修改官方源码、当前激活、权限、配对或消息逻辑。

先在忽略目录保存原官方state、当前插件lock、最近回退lock和现场文件/配置摘要，准备精确删除清单。保留官方selected/running 0.2.23、鲸栖dev.20，以及最近回退所需dev.19和当前另外两个插件。当前官方Runtime原source路径仍指16目录；与23目录安装包核对完整SHA-256相同（27073fd5…），因此仅将当前和回退登记中的source指向已存在的23原包，未新增副本或替换其已安装代码。

取得官方update.lock后核对空闲、实际进程/打开文件/映射、配置/软链接引用、目标inode/修改时间与三个登记原摘要。官方state只删除五个旧installed项并清空previous，保留selected、当前installed条目、minimumSequence及job；当前插件lock仅保留精确dev.19回退项，其余历史列表清空；最近回退lock保留原选中项并清空更早历史，当前选择、代际、状态、配置与完整manifest均不变。旧官方22的快捷rollback因此不再可用；最近鲸栖dev.19回退使用相同官方23和Core，不依赖22，继续保留。

先原子提交登记，用实际安装的Core执行`plugin list`、官方`plugin status`和当前状态检查；任一失败会在删除前恢复原登记。通过后才删除28项显式路径及空版本目录：五个旧官方版本约654.5 MB、旧登记插件资产约148.1 MB、无引用的dev.17/dev.18原安装包约18.7 MB。当前dev.19/dev.20安装来源与已安装资产仍齐全。删除后重复实际Core登记解析与当前空闲状态检查，112份未纳入登记变更的配置/组件/回退文件摘要不变。

实测用户目录由2,459,926,528字节降至1,638,453,248字节，净释放821,473,280字节，约821 MB。与首批间的少量增长为在线运行文件的正常变化。本次后主要占用为：QQ运行环境1,241,776,128字节、当前自有连接器137,064,448字节、官方23目录131,596,288字节、当前插件及dev.19回退33,148,928字节、候选来源29,253,632字节、最近回退快照11,374,592字节。统计不含用户目录外的系统和DSH依赖。

实际`clawchat-dsh plugin check`通过：current、installed 0.2.23、签名目录sequence48，未安装或升级。当前候选`verify-remote.mjs ... after`通过：dev.20/代际105、官方selected/running 23、33份连接器资产、唯一SDK/Core/relay、原配置/业务文件/原生线程、三个App/两个launcher及URL、通话鉴权、本机歌曲主人页面/匿名拒绝、三路公网、无OOM。当前Core进程未更换，没有停止或重启服务。没有实际切换回退，也没有重新发送模型对话、登录或付费生成歌曲。

现场输入、计划、执行脚本、执行报告、更新检查及最终健康集中在`.whale-nest/verification/file-cleanup-20261125/registered-history/`。没有修改业务源码，没有发布。

## dev.20按原号发布准备

用户明确要求将当前beta dev20发布到GitHub，本次授权包括发行标签、GitHub预发行及资产上传；使用完整版本号`1.0.0-beta.4.dev.20`，替代此前拟定beta.5的安排。发布前核对618份冻结文件，仅文档在部署后变化，运行源码保持测试机已验收版本。再次实机健康检查通过，官方23、自有Core、原绑定/线程、三个App/两个入口、通话与歌曲路由和33份连接器资产保持。

根package及lock的版本同步为dev.20，新增本次发行说明，README与当前状态/计划指向本次版本。随后从独立干净检出构建并比较已部署包的SHA-256，执行版本与分发相关回归、来源/许可/链接检查，再发布。原始准备、构建及GitHub证据位于`.whale-nest/releases/1.0.0-beta.4.dev.20/`，发布是否完成以该记录和GitHub实际状态为准。

## dev.20发布完成

2026-11-25 02:17:43 UTC已按用户授权公开[GitHub预发行v1.0.0-beta.4.dev.20](https://github.com/LoveMaker-art/whale-nest/releases/tag/v1.0.0-beta.4.dev.20)，release ID 457569211。源码提交187ca5b162d830ff3c3d3cb43c1ab9c3504bc9c5，main及注解tag已原子推送，GitHub发布结果immutable=true。随后仅同步发布完成的状态文档，不重写发行tag。

发布前从该提交独立干净检出，复用未变化的锁定依赖；来源/许可及文档链接检查通过，12组96项发布相关回归全部通过，无跳过。Core扩展patch的单空格上下文是diff格式，保留原始摘要，其他源码的空白检查通过。生成422条运行文件、420份sources摘要与已部署候选相同，实际运行包9,204,702字节，SHA-256为0e11d415d75b05617033a39278846b9a211d4bc82c18dfee7cbee6ac0f477f7a，与测试机包逐字相同；没有重建或替换Core。Linux95项与实际Core安装/入口激活沿用此前相同运行包结果，发布前最新实机健康另行获取并全部通过。

三份资产为Linux x64 `.connect-plugin`、distribution.json、SHA256SUMS。先上传草稿并核对GitHub返回的三份digest及uploaded状态，再公开预发行。公开后通过GitHub重新下载三份资产，全部与本地SHA-256一致。distribution元数据携带协议1、官方集成包最低/目标0.2.23及简明更新说明。

本机匿名API读取遇到出口限流（403、remaining=0），没有为此修改产品代码。随后在源机以实际已安装的dev.20发行解析器、匿名GitHub连接读取精确tag及beta频道，分别核对同一版本、不可变发行和资产摘要、协议1与前置要求；均通过。比较输入使用beta.3，仅用于只读发行发现，不是运行旧beta.3实例或执行真实升级。没有安装、重启、发送消息、调用模型或改变原实例设置，测试机仍为dev.20/代际105。

新开纯官方实例、早期定制底座到当前组合的迁移、手机麦克风听感及付费歌曲生成不因此视作已验收；发行说明已列明配套要求和四类必要接口边界。原始源码基线、干净检出记录、回归、构建、GitHub草稿/发布响应、回下载校验、限流观察与远端解析结果均保存在`.whale-nest/releases/1.0.0-beta.4.dev.20/`。
