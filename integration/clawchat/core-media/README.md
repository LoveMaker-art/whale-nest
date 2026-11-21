# ClawChat 同连接媒体发送扩展

用户已批准连接器和鲸栖插件两层接通。音频、文件和视频已真实发送，主人确认播放与下载，重启后未重复投递。此目录固定 media.3 的复现补丁和来源；实际已启用版本与完整验收边界见[当前状态](../../../docs/STATUS.md)。

## 来源和改动

[core-media-send.patch](core-media-send.patch)基于实际官方 0.2.10 使用的 b540bc211dc924d0200e6f71c18082de490d68f4，源树逐 blob、子树与根树验证。版本、构建摘要及补丁摘要见 [SOURCE.json](SOURCE.json)，[MIT 原许可](LICENSE)随扩展保留。旧 2cb 实验不用于当前部署。

连接器新增 clawchat_send_media，支持明确 chatId/chatType、filePath、可选 caption、expectedKind、SHA-256、毫秒 duration 和像素 width/height。文件上传调用同一个 wsClient，收到平台消息确认后才返回 sent 和 message ID。上传失败或类型不符时不发送；明确拒绝记为失败，发送后断线/关闭保留不确定状态。

CLI 新增 tool status REQUEST_ID，只读取已存在请求，不创建请求或重发。鲸栖的 send_media 和 media_status 对这两个命令做受控适配：收件人固定为已验证主人私聊，保存附件快照和持久回执，原请求重复调用复用结果。插件单附件上限默认 16 MiB，Core 单文件上限 100 MiB。

media.3 另增加无输入参数的 clawchat_get_agent_permissions，仅通过原 Core 认证上下文读取 GET /v1/agents/me/permissions。用于 M3 动态发布前核对当前全局受众、发布/删除策略及临时窗口；没有增加任意 HTTP 请求、权限修改接口或独立凭据管理。工具目录共 26 项。

## 保留平台兼容性

官方签名发行文件不覆盖。独立扩展目录包含新 Core、匹配版本的技能清单，以及原版平台 runtime、官方插件包和更新技能目录副本。

平台发行包还提供公开源码没有的 __clawnest-state / __clawnest-owner。启动包装器仅将这两个私有管理命令交回原程序；其余命令与唯一常驻聊天连接由扩展 Core 处理。该分派不会创建第二个聊天连接。

现有宿主继续验证完整官方基线并持有原运行锁，用户 Supervisor 配置仅覆盖同一个 dsh-agent 的启动命令。启动前校验源码基线、程序和包装器摘要；官方基线改变时要求重新评估扩展。此Core媒体扩展不提供管理页面，不改ClawChat客户端/服务端，也不增加生成模型服务。Liveware 通话入口见[通话设计](../../../docs/tasks/realtime-call.md)。

## 构建与测试

在固定 b540 源码上应用补丁：

~~~sh
git apply /absolute/path/to/core-media-send.patch
bun install --frozen-lockfile --ignore-scripts
bun test --max-concurrency 1 tests/media-send-tool.test.ts tests/tool-executor.test.ts tests/tool-catalog.test.ts tests/ws-client.test.ts tests/cli.test.ts tests/tool-failure-state.test.ts tests/deepseek-harness-frame.test.ts tests/deepseek-harness-history.test.ts tests/deepseek-harness-history-seed.test.ts
bun run typecheck
bun build ./src/bin.ts --compile --minify --target=bun-linux-x64-baseline --outfile=dist/clawchat-connect
~~~

158 项相关测试通过，0 失败；类型检查通过。新增固定权限路径、原认证上下文及工具目录/CLI 回归。构建目录还须携带补丁中的匹配版 skills 全目录，不能只替换二进制。Bun 1.4.4 在本机交叉编译，原测试机不承担完整 Core 构建。构建和私有清单位于 .whale-nest/core-media-current。

原机安装沿用 node scripts/update-m2.mjs install --media-core。它在停机前检查程序、技能清单、原生状态命令和更新技能目录复制，再冻结最新数据、安装 Runtime 插件、做实际原会话探针并切换。失败回退保留前向数据，回退不恢复旧业务数据库。

## 宿主图片声明修正

`input.1`修正的是宿主生成DSH模型配置时遗漏`models[].input`，不改Core二进制。固定来源的 [runtime-lib.original.mjs](runtime-lib.original.mjs) 保留b540原文及本目录MIT许可，其原始与修正后摘要记录在 [SOURCE.json](SOURCE.json) 的hostRuntime字段。

`src/connector-extension.mjs`在检查原始宿主SHA-256后，只在独立拷贝中传递已有input；未声明的型号保持未声明，不按名称补image。目标目录使用layout4-input1，通话准备可选追加-call1以校验和发现官方companion，这不代表relay已连接；记录runtimeLibSha256，安装复用和启动时均校验该文件；旧layout3目录与签名发行不被改写，旧回退记录仍可启动。

鲸栖Runtime m3.5已启用此修正，复用media.3程序和现有更新入口，无需重新编译Core。原生回归使用回环HTTP替身验证模态目录、图片字节与转写进入请求、重启回执复用；随后原SDK真实图片对话正确读出新图的颜色、形状和随机数字，测试图及回答经原ClawChat获得平台确认。当前运行状态和真实客户端上传边界见 [STATUS](../../../docs/STATUS.md)。

软件回归、真实平台确认、客户端播放下载分别记录。此扩展交付了发送端；后续附件入站及客户端结果见STATUS中的对应记录，不将早期发送端验收当作完整入站验收。

## 回放结束消息兼容

本机M4实测收到平台`replay.done`的`{truncation_check:"clean", ack_epoch:...}`格式；固定b540仅接受空对象，导致正常控制帧被隔离。新增[兼容补丁](core-replay-compat.patch)在media.3之上应用，保留旧空对象格式，仅接受与当前协商epoch一致的`clean`结果。其他状态、额外字段和错误epoch继续隔离，不放宽用户消息、路由或权限校验。

[来源与摘要](REPLAY-SOURCE.json)记录补丁顺序、139项媒体/目录/执行器/CLI/WS回归（包含61项WS）、类型检查及macOS ARM/Linux构建。测试机现已启用replay.2，实际组合见[STATUS](../../../docs/STATUS.md)；原media.3固定摘要继续保留作基线。重建时先应用本目录media.3补丁，再应用此兼容补丁，运行`bun scripts/generate-tool-reference.ts`和`bun scripts/generate-skills-manifest.ts`，构建并同步安装匹配版本的技能清单。兼容补丁不新增业务工具；工具目录仍由media.3提供，清单版本必须与Core一致。补丁同时修正清单生成脚本直接使用URL.pathname导致中文/空格路径失效的问题，使用fileURLToPath恢复真实文件路径。

须在独立源码根目录实际应用补丁；本机曾在外层仓库的忽略目录运行git apply，命令成功但跳过路径，导致版本名带media.3而程序没有媒体工具。当前已在Git仓库外应用并逐文件核对。构建后必须执行实际程序的`tool describe clawchat_send_media`、检查`tool status`入口及匹配技能清单，不能只看退出码或版本名。replay.2已完成这些检查及真实媒体发送；replay.1本机组装记录不作为media.3能力证明。

## ClawChat 自动续期

在 `replay.2` 之上应用[续期补丁](core-token-renewal.patch)。参照 Hermes 实机证实的原绑定续期，用现有 ClawChat 接口和原配对的 REST 设备标识。连接器运行时提前续期，启动与重连也检查有效期。SQLite 只轮换同一绑定的两个凭据，校验绑定身份后一起写入。并发触发合并为一次请求，短暂错误有重试间隔，持久化失败重试保存收到的新凭据。新凭据生效时保留可用的 WebSocket，后续握手及媒体请求使用新凭据。可恢复的断线沿用原连接器的消息确认和回放。

按[固定来源清单](RENEWAL-SOURCE.json)应用三个补丁，重新生成工具和 Skills 清单，再编译 macOS 或 Linux。Linux 构建目录包含 `clawchat-connect`、`manifest.json` 和匹配的 `skills`。测试机现有更新入口可通过 `--media-core --core-build <目录>` 选用该构建，随 `dev.20` 配套核验。当前候选对应测试机的官方 `0.2.10` 基线。

## 歌曲 Liveware 中继

在续期版本之后应用[中继补丁](core-agent-liveware-relay.patch)。实例的歌曲作品页启用时，宿主设置 `CLAWCHAT_CONNECT_AGENT_LIVEWARE_RELAY`。连接成功后，Core 使用现有绑定和已核验的官方程序启动一个中继进程。退出后重试，绑定停止时退出。歌曲页面仍由鲸栖 Runtime 提供，已绑定应用的访问策略由 Liveware 管理。

重建继续使用相同 Bun 版本和 Linux x64 目标，按[构建摘要](LIVEWARE-SOURCE.json)核对程序、补丁及 Skills。开发流程见[歌曲 Liveware](../../../docs/DEVELOPMENT.md#歌曲-liveware)。

## 同一 DSH 会话的实时通话

在 Liveware 中继版本上应用[通话补丁](core-shared-voice-session.patch)。Core 仅向鲸栖运行时提供主人私聊回合入口，按已激活的主人和会话核对请求，并沿用原 Session 队列和执行器。电话的文字、工具过程和音频回执由语音链路处理。鲸栖运行时按持久来源从 ClawChat 补读历史中隐藏通话回合。

使用 [VOICE-SOURCE.json](VOICE-SOURCE.json) 对照补丁、Core、Skills 及构建版本。首个配套插件候选为 `0.3.0-whalenest.m4.1-dev.35`。通过既有更新入口同时安装对应 Core 与插件。

在 `voice.1` 上应用[通话启动校验补丁](core-voice-activation-check.patch)得到 `voice.2`。已加载的通话运行时每次接收语音时，从当前插件锁读取自身的启用状态和激活代次。完整清单及保留版本的校验仍由原插件安装与加载流程执行。Linux 构建摘要及配套测试见 [VOICE-FAST-SOURCE.json](VOICE-FAST-SOURCE.json)，与插件 `dev.37` 配套。

## 正文确认后的表情发送

在 `voice.2` 上应用[正文交付回调补丁](core-sticker-after-reply.patch)。ClawChat Core 沿用普通聊天发送，在最终正文确认且本次回复没有媒体时，将回合标识交给已激活的运行时会话。鲸栖按该回合已保存的选图结果补发，图片失败独立于正文送达。QQ 继续从原 Hub 处理。[配套版本与构建摘要](STICKER-SOURCE.json)
