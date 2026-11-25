# 开发、测试与实例维护

开发流程见[AGENTS](../AGENTS.md)，后续功能及待确认范围见[开发安排](MIGRATION.md#首版收尾的开发安排)，运行事实见[STATUS](STATUS.md)。本文维护可执行方法。所有命令从仓库根目录执行，涉及实例的命令须先核对实际路径与授权范围。

## 工程入口

| 位置 | 职责 |
| --- | --- |
| [companion](../src/companion.mjs)、[aurabot-native](../src/aurabot-native.mjs) | 陪伴模块装配、原 Aurabot 宿主启动及会话接线 |
| [routing](../src/routing.mjs)、[companion-policy](../src/companion-policy.mjs) | 可信身份、目标与共同任务/预算 |
| [update-m2](../scripts/update-m2.mjs)、[runtime-upgrade](../src/runtime-upgrade.mjs) | 当前原实例更新、兼容迁移与回退 |
| [build-distribution](../scripts/build-distribution.mjs) | Linux x64运行包、来源/许可及文件摘要 |
| [test](../scripts/test.mjs)、[package.json](../package.json) | 测试集合、串行资源约束与命令 |

### 对话代码路径

- **ClawChat 私聊。** Connect Core 接收消息并维护原会话。`runtime-extension.mjs` 核对绑定和会话来源，准备文本与附件。`connect-bridge.mjs` 在原生 DSH 会话中挂载陪伴能力，普通回复沿原 Runtime 返回 Connect Core，由 Core 发回私聊。[Runtime 适配](../src/runtime-extension.mjs) · [会话桥](../src/connect-bridge.mjs)
- **QQ 聊天。** 宿主的 OneBot 网关把消息交给 Aurabot 宿主和 QQ Hub。Hub 按聊天选择 DSH 会话，并经 OneBot 将普通回复发回原聊天。扫码、主人关联和重连从 `qq-connection.mjs` 查起。[运行中的 QQ Hub](../src/aurabot-hub.generated.mjs) · [QQ 接入](../src/qq-connection.mjs)
- **通知和媒体回执。** 从 `routing.mjs` 查投递目标。待投递的后台通知由 `connect-bridge.mjs` 取出，并按目标调用 ClawChat 或 QQ 出口。`delivery.mjs` 记录这些通知的结果，工具媒体发送由 `media-delivery.mjs` 处理。[目标选择](../src/routing.mjs) · [通知投递](../src/connect-bridge.mjs) · [通知回执](../src/delivery.mjs) · [媒体投递](../src/media-delivery.mjs)
- **本地隔离验证。** `npm start` 经 `scripts/start.mjs` 启动本地 DSH 宿主，`host.mjs` 将标准输入中的 `receive` 请求传给 `companion.mjs`。[启动脚本](../scripts/start.mjs) · [本地宿主](../src/host.mjs)

`vendor/aurabot/` 保存固定上游源码，`src/aurabot-*.generated.*` 是兼容构建生成的运行文件。修改行为时从对应适配器或生成脚本入手。各模块的原始实现和适配入口可在功能索引中查找。[原宿主构建](../scripts/build-aurabot-host.mjs) · [功能索引](technical/README.md)

## 本地检查与回归

需要 Node.js 24 及现有锁定依赖。实时通话回归会自动选择支持 SQLite 的 Python 3.11 或更新版本。也可通过 `WHALENEST_TEST_PYTHON` 指定解释器。按变更范围选择相应检查和回归。

```sh
npm run check
npm run check:vendor
node scripts/test.mjs test/media.test.mjs test/distribution.test.mjs test/runtime-upgrade.test.mjs
npm run test:deployment
```

核心全量为npm test，上游集合为npm run test:upstream。--reuse只在源码指纹、测试集合、Node版本及平台相同且已有通过报告时使用。健康检查每次重新获取，不使用测试缓存代替现场状态。

默认回归使用真实DSH/工具/SQLite和可控模型或网关，不自动发送真实平台消息；实际推理、消息回执和客户端效果分别记录。报告保存在私有.whale-nest/verification；不同轮次有重叠的用例不相加。

## 构建测试版

发布新版本按[项目交付约定](../AGENTS.md#5-更新状态并交付)申请授权。

Node.js 24 执行 `npm ci` 后，运行 `npm run build:distribution`。默认版本来自根 `package.json`，产物保存在 `.whale-nest/distribution/`。可用第四个参数传入同版本的发行说明，将摘要保存在 `distribution.json`。

官方 Core 与独立 Liveware 的测试机候选使用明确的开发版本。

```sh
npm run build:distribution -- .whale-nest/distribution linux-x64 1.0.0-beta.4.dev.9
```

GitHub 预发行标签使用 `v` 加完整版本号。发行资产包含同版本的 Linux x64 `.connect-plugin` 和 `distribution.json`。安装前核对 SHA-256、DSH、Connect Core 和实例数据格式。云端聊天更新对发行源的要求见[更新说明](tasks/plugin-updates.md#发行与实例配置)。

## 本地开发后进行测试机最终验收

后续默认在本地仓库完成已确认需求的开发、对应回归及候选构建，再在测试机做最终实测；测试机暂不可达不阻断本地开发。沿用STATUS记录的DSH/Core与宿主基线，不另写一套本地业务。环境或平台合同未明确的部分保留具体依赖，不以模拟结果认定平台支持。

本地交付包含同一份源码、候选包及摘要、受影响回归报告和远端待验清单。分别记录代码完成、本地回归通过、已部署和远端验收通过；本机macOS测试及Linux包构建各有证据，不将构建成功计作Linux运行通过。

本机可运行真实DSH SDK、SQLite、原QQ Hub和ClawChat桥，配合可控模型及模拟网关验证业务、权限、共享状态、投递、迁移和恢复。取得兼容网关、账号范围及有效平台认证后，也可在本地做真实QQ和平台调用实测；本流程不自动授权登录、关联账号或付费生成。

分发目标为 Linux x64。本地通过后固定同一份插件候选及摘要。实机更新前核对宿主版本、实际配置、当前任务和恢复点。最终验收覆盖插件安装、启用、更新、回退、原数据保留，以及真实 ClawChat 和 QQ 下的模型、媒体、重启和资源表现。按版本分别记录本地回归、部署和实机结果。

Beta 预置实例以 2 GiB 为目标。切换前核对实际容器配额、授权范围和恢复路径。

测试并发为1、V8堆上限384MiB；Linux记录容器内存与OOM，连续三次扣除inactive_file后的用量超过85%则停止测试进程组。Mac临时目录解析真实路径，不修改上游断言规避目录检查。

## 本地宿主与Core接线

本机隔离验证可使用npm start -- /absolute/path/to/instance.json。配置含instanceId、可信owners、home、dataDir、cwd和model，目录须为对应验证实例独立设置。stdio管理命令仅供可信宿主/运维，不直接作为网络API。

实际ClawChat实例由原Core管理sdk profile；含clawchat配置的实例不能通过standalone start启动第二个写入者。需要准备桥接配置时使用npm run prepare:connect -- INSTANCE_JSON OUTPUT_DIRECTORY。

## 现有实例的直接更新

实例更新统一使用 `scripts/update-m2.mjs` 的 `preflight`、`install` 和 `rollback`。单独更新鲸栖时只传运行包，继承已有功能与连接器配置。需要另行更换 Core 扩展时，才使用 `--media-core` 并核对配套来源、程序、技能和宿主修正。[Core 扩展方法](../integration/clawchat/core-media/README.md)

鲸栖启动脚本校验已登记的 Core、兼容启动器、完整 Runtime/Skills 和 Liveware 文件集合，然后进入官方宿主的启动流程。新组合仅在鲸栖桥进程 overlay 禁用原生 JSON-RPC，全局 SDK 接口保持开启，供官方问候及 SDK 客户端使用；旧组合沿用原 profile，不能单独迁移 profile。连接器版本及源码提交的配套核对在构建与安装准备阶段执行。

鲸栖更新保留实例数据结构检查，历史元数据的 `core`、`coreCapabilities`、`dsh` 和 `dshVersions` 不作为更新限制，不调用 Core/DSH `--version`。目标发行通过独立 `prerequisites.clawchatIntegration` 声明官方集成包最低版本与升级目标；更新器通过原生 `clawchat-dsh plugin` 协调官方升级并核对真实运行，再切换鲸栖。实际仍指向旧定制程序且不满足要求时明确停止，业务及启动迁移由后续版本完成。包来源、摘要、目标、身份、空闲与健康继续核验。[协调规则](tasks/plugin-updates.md#已实现的协调接口与边界)

主人手动「检查更新」每次读取发行源；后台自动检查和失败退避继续使用六小时间隔。并发检查复用正在进行的读取。新版本仍需主人确认准确版本号后才安装。

版本号按标准顺序比较。用户已明确批准将测试机当前 `1.0.0-beta.4.dev.20` 按原号发布，本次不改为此前拟定的 `beta.5`。未来目标版本必须高于已安装版本；`beta.4` 低于 `beta.4.dev.N`，不能作为它的后续更新。每次新发行仍须单独取得用户明确同意。

先在构建环境装依赖并运行 `npm run build:distribution`。将 Linux x64 包和同目录的 `distribution.json` 复制到用户实例，使用现有更新器安装。更新器对实际版本切换要求已构建的运行包，并在预检时核对包摘要。以下命令使用测试机上已准备的包路径。

```sh
node scripts/update-m2.mjs preflight --runtime-bundle /path/to/whalenest.connect-plugin
node scripts/update-m2.mjs install --runtime-bundle /path/to/whalenest.connect-plugin
node scripts/update-m2.mjs rollback
```

| 参数 | 作用 |
| --- | --- |
| --media-core | 现有同连接媒体Core扩展及Runtime |
| --official-base DIRECTORY | 已由官方 `clawchat-dsh plugin install --version X.Y.Z` 暂存的底座；配合 `--media-core` 在线准备整组，停机后通过官方公开命令选中，失败恢复原组合 |
| --core-build DIRECTORY | 以指定的 Core、构建清单和匹配 Skills 作为更新输入 |
| --runtime-bundle FILE | 安装已验证的 Linux Runtime 包，切换前核对同目录的 distribution.json 和包摘要 |
| --activities | 活动、B站、日记及共同策略入口；保留原自动开关 |
| --speech、--expressions | 平台ASR/TTS及共同表达 |
| --images、--songs | 平台图像/歌曲执行体与作品管理，不自动生成 |
| --song-liveware | 启用歌曲作品页并通过现有 Core 使用已核验的官方 Liveware 程序，要求 `--media-core` |
| --realtime | 启用实时通话，要求 `--media-core --speech` |
| --qq-modules | 装配原QQ专属模块，不登录/绑定QQ，不打开自动空间互动 |
| --probe-prompts FILE | 合并最多三轮有标记的真实对话探针；独立核对模型/生成用量 |
| --sticker-catalog FILE | 版本切换时导入经过审核的私有图库，素材放在清单旁 `images/` 下并按 SHA-256 命名 |

停机前检查账号/会话、工作目录、可执行文件、profile、配置与源码指纹，准备候选、运行包和回退备份；再次核对输入不变、任务空闲后停止同一个dsh-agent，冻结最终数据并切换。更新器恢复原Session、检查当前健康和历史摘要；already-active时不重启。预检失败保持服务运行。

媒体 Core 更新使用同批源码的 `deploy/serve-media.mjs` 及配套源码工具。扩展、官方包、技能、启动依赖和 profile 均在 `preflight` 返回前核验；同鲸栖版本但底座、扩展或启动工具不同仍执行切换。暂存部署会同批复制并备份启动/安装器依赖，回退先核对官方选择归属与前后摘要，保留新增会话、作品和未知回执。官方资产先暂存；停机选择时仍需要在线签名目录复核，网络失败会恢复原组合，不能把 `--defer` 当成只暂存。从暂存目录执行时，更新器自动复制启动脚本并保留原件用于回退。已启用的 Liveware 由宿主分别启动 `whalenest-call` 和 `whalenest-song`，从当前安装的鲸栖包加载各自页面。通话网关使用仅在本机开放的鉴权端口接入原生会话。更新器核对两个本机服务及各自的公网 `liveware-status`，再记录更新成功。

`build:distribution` 生成插件代码、运行清单、兼容版本及摘要。构建参数依次是输出目录、目标平台、版本、可选更新说明文本文件、可选前置要求 JSON 文件、可选升级路径 JSON 文件。最后一个文件内容为 `{"clawchatIntegration":{"minimumVersion":"0.2.23","upgradeVersion":"0.2.23"}}` 形状，默认取当前源码登记的发行要求；它描述版本条件，不包含命令或发行源。构建清单登记 updateProtocol=1；可选路径为 schema=1、steps 数组，每项仅含同仓库的 version 与插件包 sha256，具体校验和接续规则见更新任务。用户数据、凭据与 `instance.json` 由宿主按实例配置提供，更新脚本按实际路径核对及保留。发行文件与聊天更新配置见[更新任务](tasks/plugin-updates.md)。

回退先保存前向数据和未知回执，再恢复兼容写入方；旧版本不理解的新增能力关闭，其任务/作品保留。离线安装器、更新技能目录和技能版本摘要也属预检，不只替换二进制。

## 歌曲 Liveware

使用现有更新入口的 `--media-core --song-liveware` 启用。原版官方 Exposure 管理账号级中继，鲸栖通过公开 Managed Web App 接入通话服务；Core 不再自行启动中继。作品页监听实例回环端口 `8898`，首次发布使用 `clawchat-connect liveware` 登记私有应用。服务核对应用归属及中继状态，在 `dataDir/song-liveware.json` 保存 `binding`、`owner`、`appId` 和 `url`。已有实例沿用已登记的私有应用。[Core 构建](../integration/clawchat/core-media/SOURCE.json)

验收先检查应用根路径的 SongSmith 首页和三个入口，完成创作问答后核对原私聊与预填草稿。使用已有歌曲检查曲库、单曲链接、分段播放、下载和乐谱，并核对关联主人与匿名的访问结果。现有作品的乐谱按原 MusicHub 任务读取。验证页面及草稿可以使用已有歌曲和未发送草稿。

旋律验收覆盖哼唱、手绘、试听、乐谱保存和私聊草稿。歌曲保存后复查版本、封面、精修草稿、试听及下载。扩展旋律使用实例上的 Python 3 执行随包的 SongSmith ABC 工具。测试复用隔离样曲及替身任务，验证两次提交的状态检查、重启和未知回执。

按[适配清单](tasks/songsmith-adaptation.md)逐项核对。重点验证 `companion_songs draft` 的真实原谱与填词计划已经进入模型请求，`sing_song` 回执说明实际旋律采用状态，超量歌词在平台提交前被拒绝。已有整曲的精修沿原歌词约束，旧任务查询或恢复不重新生成。制作中页面只向主人提供进度；词、谱取回及标签修改分别核对回执和无新增生成任务。真实付费验收按[歌曲用量约定](requirements/singing.md#3-用量与真实验收)确认。

当主人明确选择参与分享的 ClawChat 用户后，在 `singing.playback.audience` 设置相同的用户 ID，并按原 Connect 的 Liveware 管理入口更新已有应用的 `allowlist`。使用主人、受邀好友和未受邀者核对作品可见性、互动和撤回。默认名单为空。歌词精校读取可选的 `singing.playback.alignment.configPath`。该绝对路径指向包含 `baseUrl` 与 `apiKey` 的对齐服务配置。实例有 FFmpeg 时先将歌曲转换成适合出站的单声道音频。验收只对主人选定的歌曲启动精校。

测试应用若按用户要求切到 `public`，只写入一首已标记为运维自测的 `publicDemoWorkId`。此入口只展示选定测试歌，仍遵循平台的 ClawChat 登录门槛。[Liveware 访问策略](https://agent-connection.clawling.com/use/liveware.md#who-can-open-it)

## 测试机用户状态重置

按用户已确认范围只清理用户状态，保留 ClawChat 配对、传输水位、模型与运行配置、随包默认素材及两个 Liveware。先核对实际配置和清理范围，停止所有业务写入者并等待 QQ 子进程退出，再清理用户状态及旧用户备份，不保留用户数据副本。复核默认人格、空用户状态和保留项后恢复服务，重新检查就绪、唯一 SDK 进程、Liveware 及账号登出状态；连接握手、初始工作区等运行元数据不属于清空目标。原始记录留在忽略目录，避免其中包含用户内容。 0.2.22 及后续已适配组合还需清理 `browser-turns.json`、`web-activity/`、`operator-sessions.json` 及含正文的首次问候草稿，保留已有真实 `greeting-receipt.json` 防止重新问候；不能恢复旧 profile 备份覆盖新的 JSON-RPC 接线。无引用自有旧连接器须核对配置、技能、启动器和 profile 引用后才删，官方登记的历史包保持登记一致。群策略的默认同步标记属于运行元数据，不能要求其行数为零；实际群设置和聊天数据必须为空。

## 离线恢复与迁移操作

仅对已停止supervisor的目标实例执行；核对锁的主机、实例与PID，活进程或身份不确定时拒绝回收，禁止并发写入。

主服务在容器重启后无法启动时，先检查实际 DSH stderr。现有桥可能将握手超时统一显示为 `workspace-registry-missing`，不能只按此文字补装组件。若实际错误是 `runtime.lock` 的 `EEXIST`，停止同一实例的主服务，使用 `waitForSdkExit` 确认其 SDK 全部退出，再通过下列恢复入口核验并回收已死进程的锁；不要直接删除正在使用的锁。恢复后重新检查原身份、唯一 SDK、队列和官方宿主健康。

```sh
node scripts/recover-lock.mjs /absolute/path/to/instance.json --offline
node scripts/migrate-memory.mjs /absolute/path/to/instance.json import /absolute/path/to/snapshot.json --offline
node scripts/migrate-memory.mjs /absolute/path/to/instance.json rollback SOURCE_HASH --offline
```

导入使用mnemon Runtime v1结构化entries；未确定范围保留原件待核对。原Aurabot SQLite中的事实与导入凭据同事务，重复处理不恢复后来删除/纠正内容；JSON降级后端不能冒充成功。回滚仅撤回自有未修改导入，并输出完整私有备份，保留新增内容；不自动反向转换回mnemon。

Core桥从原生已完成调度日志恢复投递意图及检查点，不重新运行模型；导入旧会话先建基线，已确认/未知/抑制回执保留。

## 首次开通

平台准备全新用户实例时，在实际 `DSH_HOME/companion/aurabot-v1/instance.json` 的 `clawchat` 段设置 `"firstBinding": true`，沿用实例内 Connect 程序和配置的绝对路径。新实例的 `owners` 为空，由 Connect 在配对后提供身份。准备未绑定的桥时可将同一实例配置传给 `prepare:connect`。已有绑定实例沿正常更新流程保留其身份和资料。

用 `prepare:connect` 处理未绑定模板时，输出的 `instance.json` 默认开启写歌、歌曲作品页和实时通话，并准备平台模型接线。预装实例使用这份配置经过支持 Liveware 中继的 Connect 启动。用现有更新入口准备源实例时，使用 `--media-core --speech --songs --song-liveware --realtime`。首次绑定核验主人后，两个本地服务启动，并通过原 Connect 绑定登记私有入口。已登记的私有入口分别保存在 `dataDir/call-liveware.json` 和 `dataDir/song-liveware.json`。验收时在原私聊打开[歌曲作品页](#歌曲-liveware)和[通话入口](tasks/realtime-call.md#接入与验收)。

Connect 完成配对并准备 DSH 时，桥从本机 Connect 数据库核对原生绑定、安装主人和私聊，写入实例路由。握手成功后，插件经既有 Connect 工具生成并投递开场白，读取并按需初始化 Agent 头像。首配记录保存在 `dataDir/first-binding.json`。开场白在这次用户开通中最多调用一次模型。内存保护或模型失败时仍发送文字兜底并处理头像。头像使用随包的[鲸鱼娘头像 PNG](../src/assets/whalenest-avatar.png)。未知发送结果按原请求核对回执。真实平台验收从新配对码开始，查看手机端头像和首条文字，再发送一条普通聊天消息并重启复查。[开通体验](tasks/feature-experience-review.md#3-开场白与头像)

## ClawChat 对话自测

用户已要求可自动执行的ClawChat对话由Agent自行验证。测试输入明确标记运维自测，分别保存实际模型/工具、原会话、回答、平台message ID和当前健康；原生桥注入不能冒充客户端入站或播放。

scripts/probe-live.mjs参数依次为INSTANCE_JSON BRIDGE_PATH OUTPUT_JSON [PROMPTS_JSON]。默认三参数只恢复和检查，不调用模型；可选JSON数组最多三轮，每项含id、text，可附requiredTools/forbiddenTools。ID以whalenest-selftest-开头，同一被测组合重试复用持久回合，未知先核对，不换ID重做。

普通探针前核对身份与空闲，停止同一个 `dsh-agent` 并确认原 SDK 退出，再冻结最新 `companion`、`sessions` 和 `storages`，只回收已退出进程的锁。更新器在停机后和探针退出后检查该 `DSH_HOME` 的 SDK 进程。探针启动前复核，即使另一个 SDK 尚未取得数据锁，也会拒绝重叠启动。使用原 sdk profile 和实际安装桥，最后恢复服务并核对身份、历史与健康。

语音/媒体工具需要Core在线取得回执：通过原loopback控制面/core/v1/bindings/quiesce，带X-ClawChat-Connect-Core-Config-Path并使用完整bindingIds暂停入站；等待唯一原SDK退出后再运行探针。若未退出，只能在队列已暂停、空闲且PID/patch身份匹配时终止该进程，不能启动两个写入者。探针结束后释放暂停、重启原服务并复核，失败路径同样执行。`resume` 只恢复队列，Core 可能继续持有已经退出的 DSH 子进程引用。收尾须核对原服务启动了新的 SDK 进程，并核对原会话完成新回合、平台确认文字回复。连接健康只证明链路在线。

探针回复经原Core文本/媒体工具发回原私聊，稳定request ID与真实message ID关联；平台失败、余额不足和未知结果如实记录，不自动改ID重试付费生成。麦克风、上传、显示、下载和播放须有实际对应客户端证据。禁止computer use的用户约束继续有效。

## QQ测试网关运维

测试机的独立网关启动入口为[serve-qq-gateway.py](../deploy/serve-qq-gateway.py)，不包含QQ聊天或主人关联业务。`~/.clawling/supervisord/whalenest-qq.conf`管理它，原`dsh-agent`继续独立运行。程序使用`autostart=true`、`autorestart=true`，正常退出也须恢复；仅设unexpected曾留下停止的网关。使用`/opt/clawnest/bin/supervisord ctl status|start|stop whalenest-qq`检查和启停；不要向所有QQ进程注入或修改用户原生QQ配置。

运行依赖在`~/.local/share/whale-nest/qq-gateways/`：SnowLuma、官方Linux QQ、Debian用户目录依赖及私有虚拟显示。没有sudo安装，也没有把这些程序打进鲸栖插件。Xvfb的用户目录迁移保留原二进制及`desktop-deps/xvfb-relocation.json`的前后摘要；重启时恢复该私有路径。

中文字体也是启动前提：本机采用Debian `fonts-wqy-microhei`，解包后在用户字体目录链接并建立缓存；启动器以fontconfig核验实际`zh-cn`覆盖。缺字体时二维码仍可能出现，但QQ中文错误/验证弹窗会空白，不能把二维码能显示当作完整环境检查通过。字体变化需在加载新进程后复核界面；不自动确认客户端弹窗或用户安全验证。

实例的`qq.gateway`选择`snowluma`，控制台使用回环5099及独立`tokenFile`。`loginQrFile`和`loginRequestFile`指向服务私有`login/qr.json`、`request.json`，只有运维可配置。有效码直接复用，失效时在原QQ窗口刷新，不重启QQ或SnowLuma；原ClawChat媒体发送负责回执。实际窗口状态写入同目录status.json，二维码PNG按请求号、时间及摘要核对，不能仅凭PNG文件新写入就认定二维码有效。

运维以实际网关回执校验账号和聊天通道。二维码和登录状态留在实例私有目录。主人关联仍需原聊天确认。资源状态由宿主采样，后台任务按内存门禁延后。

## 功能运维入口

| 范围 | 入口与资料 |
| --- | --- |
| 人格/记忆 | companion_persona、companion_memory；[人格设计](technical/persona-management.md)、[记忆设计](technical/long-term-memory.md) |
| 自动策略与首选 | companion_settings；[共同投递](technical/proactive-delivery.md)、[主动联系](technical/active-contact.md) |
| 音色与自动表达 | companion_voice、companion_expression；[语音](technical/voice.md)、[心情](technical/mood.md) |
| 表情 | companion_stickers及QQ原别名；[共同图库](technical/stickers.md) |
| B站 | 原工具、bili_config、bili_inbox；[设计](technical/bili.md) |
| 私人日记与发布 | companion_diary；[共同档案与分平台发布](technical/diary.md) |
| 画作与歌曲 | companion_paintings、companion_songs；[图像](technical/image-generation.md)、[歌曲](technical/singing.md) |
| QQ空间 | qq_qzone_social status/run/update；[模块清单](IMPLEMENTATION-INVENTORY.md) |
| QQ接入与关联 | ClawChat主人私聊的companion_qq；[接入范围与验收](tasks/M4-qq-dual-platform.md#接入范围与真实验收条件) |

当前实例默认值和开关只维护在STATUS。模型认证沿配对provider配置，不读取/公开Key、不由模型指定任意端点；账号登录、互动、发布与付费生成均沿既定授权范围。请求和作品恢复只补下载/发送，不重新创建付费任务。
