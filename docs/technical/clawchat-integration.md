# ClawChat 连接器与鲸栖业务接口

源机 22257 已部署鲸栖 `1.0.0-beta.4.dev.19`、官方集成包 `0.2.23` 和自有 Core 构建 `.0.2.23.2`，固定上游源码 `adfec616c51f61ee6cccf8ce08dd99b80c825c50`。Core 的 `CONNECT_VERSION`、命令行版本和 Skills 清单保持官方 `0.1.0-beta.9`，自有构建身份由来源及安装记录单独标识。来源见[上游清单](../UPSTREAM.md)，运行事实与验收边界见[当前状态](../STATUS.md)及[本轮任务](../tasks/connector-convergence-023.md)。

## 模块职责

| 模块 | 负责的内容 |
| --- | --- |
| 官方 Core 与四类必要扩展 | 平台连接、认证续期、入站确认、普通发送、回执、队列及补充接口 |
| 原样官方 Runtime Provider | 官方模型、工作区、目录、历史及 Runtime 基础行为 |
| `runtime-provider.mjs`、`runtime-bridge-client.mjs` | 通过公开 factory、`createBridge` 和 Runtime 接口管理鲸栖会话适配、桥进程与 FD 通信 |
| `dsh-bridge*.mjs`、`connect-bridge.mjs` | 自有 DSH 业务 Bridge、原生会话协议、审批与业务装载 |
| `runtime-extension.mjs` | 输入、输出、媒体能力及业务回调适配 |
| 官方 Liveware Exposure | 私有托管应用发布、官方中继进程、认证及恢复 |
| `liveware-managed.mjs`、`liveware-migration.mjs` | 自有 Managed Web App、通话代理、稳定聊天卡及入口迁移/回退 |
| `liveware-service.mjs` | 独立启动通话网关或歌曲作品页，不让一项业务依赖另一项后端 |
| `clawchat-core.mjs`、`clawchat-state.mjs` | 官方状态与管理入口、身份核验，以及必要的只读状态适配 |
| `first-binding.mjs` | 首次身份关联、默认头像、问候与进度 |
| `runtime-activation.mjs` | 更新与 QQ 重载后核对原 SDK、按需提交一次宿主重启并持久观察 |
| `platform-voice-bridge.mjs`、歌曲业务 | 通话轮次、字幕、打断、播放确认，以及作品生成、保存和回传 |

## Runtime 与 DSH Bridge

构建器校验并原样打包官方 provider，通过其公开 factory 注入 `runtimeAdapter.createBridge`，由鲸栖自己的 provider、通信客户端和 DSH Bridge 承担业务适配。Core 仍持有原绑定、队列和会话权威状态；鲸栖不读取官方 provider 的私有 Session 字段。官方 provider/bridge 构建时的文字替换已删除。

自有 DSH Bridge 使用协议 2，复用四个已校验且未修改的官方辅助模块：帧编码、历史分页、审批策略和问题提供器。帧交互、原生会话及业务生命周期由鲸栖代码维护。通话模型别名由 `voice-model.mjs` 通过桥进程的配置覆盖层加载，复用既有模型和凭据引用；不改写官方模型文件或宿主 `runtime/lib.mjs`。来源及许可见[上游清单](../UPSTREAM.md#runtime-与-bridge-的来源边界)。

## Liveware 与稳定聊天卡

官方 Exposure 已更新为经官方 `0.2.23` 资产核验的原版插件，以 `private` 策略发布鲸栖贡献的一个 Managed Web App，并管理官方账号级中继。Core 自启中继补丁、companion 私有复制和路径覆盖均已删除；鲸栖不持有平台令牌。自有服务保留原主人、绑定及精确 Host/Origin 校验，HTTP、SSE、轮询和 WebSocket 均进入既有通话网关。

当前共有三个私有 App 资源，ClawChat 中显示两个入口：

| App 资源 | 用途与可见性 |
| --- | --- |
| 稳定通话 App | 绑定独立通话网关，保留原 appId/URL；注销 launcher 后仍供旧聊天卡访问。新实例也创建稳定卡片 App。 |
| 官方托管通话 App | 指向鲸栖托管入口服务；显示为“鲸栖通话 · dsh”。 |
| 歌曲 App | 独立绑定作品页，保留“鲸栖歌曲”可见入口。 |

托管应用在官方插件替换时可能重建，聊天卡始终使用独立稳定通话 URL。迁移在托管 provider 就绪前注销稳定 App 的 launcher，保留 App、隧道和数据；官方随后登记新托管入口。fresh create/bind 的操作 ID 与 App 归属先持久，只有确认 bind 才提供卡 URL；未知操作不重放，回退不能虚报成功。回退只通过官方命令恢复所属入口，不删除作品或通话数据。通话与歌曲后端可分别启停；通话关闭时托管服务提供禁用状态，歌曲继续使用官方中继。启动采用官方保留发布资源开关，中继进程与配套程序由官方 Exposure 管理。

实机已检查稳定通话、托管通话和歌曲三条路由、两个 launcher、官方 relay 程序路径、新托管入口的主人页面及歌曲身份读取。麦克风听感、客户端完整交互和付费歌曲生成的覆盖边界仍以 STATUS 为准。

## 身份与必要的只读状态依赖

正常 `dsh` 绑定的已绑定 Agent 身份改用官方 `__clawnest-state`，核对主人与私聊后供歌曲页面使用；异步查询避免阻塞作品页和音频。该官方命令当前固定面向 `dsh`，其他绑定名保留原只读适配。

生产代码仍通过只读适配核对首次绑定的全局安装主人、激活时间及新鲜握手，并按绑定、工具名和请求 ID 查询精确工具回执。生产通话通过共享会话接口取得原句柄/nativeId；直接读取 `runtime_sessions` 原私聊映射的是运维脚本 `scripts/probe-live.mjs`。现有公开查询不能完整表达上述核验条件；相应数据库只读打开，令牌仅作非空条件、不提取供业务使用，鲸栖不直接写官方数据库。`tool status` Core 修改已删除。结构不兼容或结果未知时保留未知状态，不猜测归属或重复发送。

更新、激活及 QQ 重载还读取官方配置和 `plugins.lock.json` 的安装/绑定记录；安装/回退脚本亦直接写入这些结构，独立 Liveware 入口也读取 lock。官方已有插件及绑定管理可用于迁移，但须核对调用范围和既有配对迁移；不能只改读取适配器便宣称完成。对外[通用契约](clawchat-connector-platform-handoff.md)不要求原 Session、nativeId、表情回调或 SQL 字段；内部[完整替代方案](clawchat-decoupling-plan.md)覆盖四类 Core 及私库、配置/lock、安装布局、启动分流等 I01–I14，并列出当前尚未实现的关闭条件。

## 保留的四类 Core 接口

| 接口 | 保留原因 |
| --- | --- |
| `clawchat_send_media` | 快照、业务目标、幂等和业务回执已经在鲸栖；当前 Core 扩展仍核验实际读取字节、执行平台认证上传、媒体 fragment/元数据和原连接发送，并等待真实 ACK。官方 `clawchat_send_file` 不验证附件原发起 turn，也缺少将业务预期摘要与实际上传字节相核验的等价接口，普通聊天附件不能仅换工具名安全迁移。 |
| `clawchat_get_agent_permissions` | 平台已有只读权限 HTTP 接口，但官方连接器未向插件开放等价认证查询入口；当前仅供 ClawChat 日记动态的受众、发布和撤回前核验使用，业务规则已在鲸栖。 |
| `withPrivateVoiceSession` | 核验代际及主人私聊，按 Core 当前选择共享原 Session、队列及生命周期；官方 Client 已有共享能力，但未向 DSH/鲸栖开放等价入口，缓存句柄或另建会话不能替代。 |
| `afterClawChatReply` | 仅把正文平台确认通知交给原输入的预选表情业务；官方虽有 ACK 和有序投递，未向 Runtime 公开等价结果通知。概率、选图、取消、回执和轮换均已在鲸栖。 |

这四类扩展及相应定制启动仍是当前完整功能组合的必要部分。普通消息协议、认证和发送权威仍由官方 Core 持有，鲸栖维护功能策略；不能把普通附件发送列为已经具备无损替换条件的遗留项。

## 基础投递原则与本次媒体收口

基础上传、认证与原会话授权、发送和平台 ACK 由平台及官方连接器提供，接口缺口交由平台补齐。不得以新增鲸栖基础发送补丁或替代通路绕过缺口，不构造假回合或借用另一活跃回合的授权，不以链接代替应送达的附件。当前必要依赖描述的是运行事实，不是继续自造平台基础能力的开发方向；既有功能保持。

`media-delivery.mjs` 已负责受控路径与内容快照、哈希、目标核验、稳定业务请求、业务级 confirmed/uncertain/failed 状态和只读恢复；Core 的执行 journal 与真实 ACK 仍是平台结果依据。业务幂等 ID 不等于平台认可的原 turn 授权。复核不再将这些现有自有能力列作待迁移开发。

本次连前台普通文档也未证明可严格无损切换：源文件预哈希、0400 权限或唯一名称不能替代发送方校验实际上传字节，原 turn 的可信授权也未补齐。因此本轮没有新的运行代码迁移、功能删除或部署，仍使用已验收 dev.19，等待官方提供等价接口。现有歌曲作品页是附加功能；只有实际附件 ACK 才能确认附件送达，不把页面链接冒充附件结果。

## 更新与启动

鲸栖业务兼容条件使用 `dataSchema`，官方前置条件由发行的 `prerequisites.clawchatIntegration` 单独声明。更新器通过官方 CLI 核对并按需升级，确认实际运行与原身份后再切换鲸栖。历史 `core`、`coreCapabilities`、`dsh`、`dshVersions` 不作为业务更新版本门槛，不调用 Core/DSH `--version` 设限。[更新协调](../tasks/plugin-updates.md#已实现的协调接口与边界)

部署准备核对官方完整资产、自有构建、技能、进程配置和摘要。定制启动用于加载上述四类 Core 接口；官方宿主文件保持原样，未启用另一套消息连接。安装与组合回退沿原排空流程执行，保留原账号、会话、作品、新增数据及未知回执。[部署操作](../DEVELOPMENT.md#现有实例的直接更新)

更新完成须确认原 SDK 租约恢复，通话关闭时仍覆盖 QQ 与后台业务；通话开启时另核对 8896 鉴权 settings。官方热替换只注册 Runtime 时可能尚未实例化，生产 helper 经原宿主提交一次持久重启意图，后续只观察，不另建 SDK。新 QQ 关联无需修改官方 Core 配置，重启原 SDK 即可加载自身 transition；历史未知重启意图不重发。

源机 dev.19 已通过一次真实公开同版本 replace、一次生产 helper 恢复及热更新后真实模型通话文本回执。Runtime ready 早于公网 relay ready 的首轮失败观察保留，后续三条路由均 200；因此 SDK 就绪与公网路由分别验收。最终原 Session/线程及稳定 URL 保留，SDK、Core、原版 relay 各一个。完整证据与未测客户端范围见 STATUS。
