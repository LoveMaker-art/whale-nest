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
node scripts/test.mjs test/media.test.mjs test/distribution-inputs.test.mjs test/runtime-upgrade.test.mjs
npm run test:deployment
```

默认`npm test`运行全部源码回归，不执行发行包构建。`npm run test:distribution`单独执行发行包构建／分发回归，必须在测试机源码验收并获准打包后运行；直接选择`test/distribution.test.mjs`也必须加`--distribution`。上游固定源码使用`npm run test:upstream`，与源码和发行集合分开。

`--reuse`只在源码指纹、测试集合、所属集合、Node版本及平台相同且已有通过报告时使用。健康检查每次重新获取，不使用测试缓存代替现场状态。

测试共享准备集中在`test/host-helper.mjs`、`bridge-helper.mjs`和`platform-fixture.mjs`。平台fixture通过公开CLI返回身份／就绪状态，不模拟官方私库和安装锁。QQ原生回归按`native-qq.test.mjs`（接入、管理和路由）、`native-qq-media.test.mjs`（语音、图片、表情、引用和歌曲）、`native-qq-activities.test.mjs`（B站、日记与QQ空间）选择；共同准备由`native-qq-helper.mjs`维护。旧参数、历史任务和迁移数据的测试在当前实现仍有接续或拒绝义务时继续保留。

默认回归使用真实DSH/工具/SQLite和可控模型或网关，不自动发送真实平台消息；实际推理、消息回执和客户端效果分别记录。报告保存在私有.whale-nest/verification；不同轮次有重叠的用例不相加。

## 构建测试版

先完成测试机源码验证并汇报，用户同意打包后才执行本节构建命令。公开发布另按[项目交付约定](../AGENTS.md#5-更新状态并交付)申请授权。

Node.js 24 执行 `npm ci` 后，运行 `npm run build:distribution`。默认版本来自根 `package.json`，产物保存在 `.whale-nest/distribution/`。可用第四个参数传入同版本的发行说明，将摘要保存在 `distribution.json`。

官方 Core 与独立 Liveware 的测试机候选使用明确的开发版本。

```sh
npm run build:distribution -- .whale-nest/distribution linux-x64
```

GitHub 预发行标签使用 `v` 加完整版本号。发行资产包含同版本的 Linux x64 `.connect-plugin` 和 `distribution.json`。安装前核对 SHA-256、实例数据格式、原绑定及实际接口可用性；连接器和DSH版本仅作环境信息，不作为鲸栖更新门槛。云端聊天更新对发行源的要求见[更新说明](tasks/plugin-updates.md#发行与实例配置)。

## 本地开发后进行测试机最终验收

提出替代功能方案时，先说明用户效果和实际取舍，同时覆盖失败／超时／重启、并发／取消、数据与文件归属、回收／容量，以及可预见的新增问题和验收方法。说明深度与变更规模相称，不要求每项内部流程照搬旧实现；也不把接口可调用直接写成完整方案。临时文件需要同时设计创建、使用、回收与总量控制；未知结果不能通过盲目重试或清理记录消除。未解决的边界明确列出，再进入实施与切换。[当前替代方案与边界](tasks/connector-026-upgrade-plan.md#替代方案的完整性要求)

后续默认按“本地修改与受影响回归 → 测试机源码部署与实测 → 汇报并申请打包 → 获准后构建及验包”推进；公开发行另需用户明确同意。源码验收前不运行发行构建，也不运行会触发完整打包的分发测试。测试机暂不可达不阻断本地开发。沿用STATUS记录的DSH/Core与宿主基线，不另写一套本地业务。环境或平台合同未明确的部分保留具体依赖，不以模拟结果认定平台支持。

源码阶段交付同一份源码清单及摘要、受影响回归报告和远端待验清单；获准打包后再补发行包及摘要。分别记录代码完成、本地回归通过、已部署和远端验收通过；本机macOS测试及Linux运行各有证据，不将构建成功计作Linux运行通过。

官方原版启动候选使用`instance.clawchat.officialHost=true`，自有启动器调用公开`/usr/local/bin/clawchat-dsh serve`，不读取Core扩展覆盖记录；`delivery.connectBin=/usr/local/bin/clawchat-connect`随官方已选择发行工作。`realtime.sessionEnabled=false`用于维护暂停；当前独立通话候选由`--enable-independent-call`在一次源码切换内启用，回退同时恢复原开关。当前源码候选不等于安装登记已更新，安装包仍须在实机验收后取得打包授权。

源码测试使用[scripts/source-mode.mjs](../scripts/source-mode.mjs)：同步原始源码和`source-manifest.json`（schema=1、version、files相对路径到SHA-256的映射），不执行发行构建。preflight校验源码、原绑定、安装记录、任务和通话空闲及受控AGENTS；activate保存独立恢复点，停止原服务，切换自有启动接线和dataDir/source-candidate.json，再恢复同一Core/SDK及两个Liveware。失败恢复启动文件和原指令来源，用户会话、设置与回执保留。

```sh
node /absolute/source/scripts/source-mode.mjs preflight /absolute/instance.json /absolute/source /absolute/project
node /absolute/source/scripts/source-mode.mjs activate /absolute/instance.json /absolute/source /absolute/project
node /absolute/source/scripts/source-mode.mjs rollback /absolute/instance.json /absolute/backup /absolute/project
```

源码入口同时支持DSH业务、Liveware及自有Core侧Provider。Node加载器和仅在`clawchat-connect-core`中注册的Bun加载器只映射已登记的鲸栖`src`及鲸栖包内复用的官方factory到已核验候选；官方文件、编译Core和插件安装存储不改写。源码、安装代际及身份校验全部保留；后续插件激活使旧选择失效，不阻断正式更新。Bun预加载文件所在部署路径不得含空白，预检先核对。编译Bun夹具验证模块与资源映射，Linux另核对实际Core加载日志。

故障实例可显式在上述命令末尾加`--recover-offline`：仍须官方激活、账号、主人及私聊完全匹配，任务/队列为零、没有SDK写入者或通话。它只允许在该条件下恢复不可用实例，不跳过身份检查。切换前冻结原状态；失败保留新增会话及请求，恢复原启动接线，并如实记录原先已离线的状态。正常在线实例继续按原空闲预检执行。`scripts/update-m2.mjs install`仍用于获准打包后的运行包安装。

镜像初始化使用平台提供的`CLAWNEST_INSTANCE_ID`，不使用SSH端口或主机名推定身份。已登记的实例标识变化但agent仍旧时，自有SDK与Liveware等待平台新激活；同实例重启保留原账号与回执。运维原生探针须继承被测服务的公开实例标识和Core epoch，禁止读取/复制平台凭据。首次引入标识的旧安装只能登记当前已验证激活，不能倒推未登记时期的镜像来源；更换主人仍须明确交接。

本机可运行真实DSH SDK、SQLite、原QQ Hub和ClawChat桥，配合可控模型及模拟网关验证业务、权限、共享状态、投递、迁移和恢复。取得兼容网关、账号范围及有效平台认证后，也可在本地做真实QQ和平台调用实测；本流程不自动授权登录、关联账号或付费生成。

分发目标为 Linux x64。本地通过后固定同一份源码候选及摘要。实机更新前核对宿主版本、实际配置、当前任务和恢复点。源码阶段验证启用、原数据保留及受影响通道下的模型、媒体、重启和资源表现；获准打包后补做发行包安装、更新及回退验收，并核对与实测源码一致。真实ClawChat和QQ验收分别按实际账号范围记录，不将禁用通道视作已实测。按版本分别记录本地回归、部署和实机结果。

Beta 预置实例以 2 GiB 为目标。切换前核对实际容器配额、授权范围和恢复路径。

测试并发为1、V8堆上限384MiB；Linux记录容器内存与OOM，连续三次扣除inactive_file后的用量超过85%则停止测试进程组。Mac临时目录解析真实路径，不修改上游断言规避目录检查。

## 本地宿主与Core接线

本机隔离验证可使用npm start -- /absolute/path/to/instance.json。配置含instanceId、可信owners、home、dataDir、cwd和model，目录须为对应验证实例独立设置。stdio管理命令仅供可信宿主/运维，不直接作为网络API。

实际ClawChat实例由原Core管理sdk profile；含clawchat配置的实例不能通过standalone start启动第二个写入者。需要准备桥接配置时使用npm run prepare:connect -- INSTANCE_JSON OUTPUT_DIRECTORY。

## 现有实例的直接更新

已获准打包后的实例安装使用 `scripts/update-m2.mjs preflight|install --runtime-bundle FILE`。该入口验证已批准包和同目录distribution.json，停机前核验并保存当前版本的本地原包，通过官方offline plugin replace管理安装与离线回退，仅备份、部署和恢复鲸栖自己的文件，不修改官方lock/config。旧的Core构建开关已从当前入口退役，历史构建材料只作追溯。

启动器直接调用官方 `clawchat-dsh serve`。官方签名更新器管理Core、Runtime及Skills；鲸栖仅在自己的DSH进程overlay装配业务桥。`dataDir/installation.json`由鲸栖自己的包记录代码位置、入口摘要，并使用公开Runtime Context观察激活代际。在线版本、完整性、来源和实际代际通过官方`GET http://127.0.0.1:47822/core/v1/plugins`查询，附带`X-ClawChat-Connect-Core-Config-Path`限定配置范围；不解析plugin list文字，也不读取官方安装目录或lock。测试源码选择仍与真实安装登记分开。

冷启动时，源码预加载及Liveware入口仅用鲸栖自己的安装登记定位自有代码。Core会先获取托管页面，再启动管理接口，不能让页面等待该接口后才启动。接口暂不可用时，既有本机页面继续提供服务，暂停登记／绑定等后台发布；接口恢复后再核验真实选中插件，确认换版或停用则退出旧服务。UI服务使用异步查询，避免管理器响应延迟阻塞页面。更新准入及线上安装查询仍须取得真实管理结果，不将冷启动登记当作平台在线成功。

官方配套组件采用原生更新器的停止／选择／启动流程。停机期间没有在线管理接口，公开offline命令确认后应在Core及管理接口都就绪时核验实际来源、状态和绑定。将Exposure从0.2.26构建在线替换为0.2.23旧构建时曾返回激活代际过期并留下error状态，已通过官方offline replace恢复；不得当作热替换成功，或通过修改官方代码绕过。当前验证范围见[独立更新验收](tasks/connector-026-upgrade-plan.md#结构化元数据与平台独立更新验收2026-11-28)。

更新器保留实例数据结构、来源、摘要、账号及空闲核验。DSH不作为自行设置的更新门槛；当前功能使用已验收的官方公开媒体／权限工具；连接器版本只作环境信息，由用户决定是否通过官方入口更新。原版运行实例的后续更新走公开管理入口；旧耦合发行的分步迁移仍须随获准安装包验证，不把源码实机验收当作发行包迁移验收。

主人手动「检查更新」每次读取发行源；后台自动检查和失败退避继续使用六小时间隔。并发检查复用正在进行的读取。新版本仍需主人确认准确版本号后才安装。

版本号按标准顺序比较。用户已明确批准将 `1.0.0-beta.4.dev.20` 按原号发布；测试机现已启用内部dev.21，公开版本不随测试部署变化。未来目标版本必须高于已安装版本；`beta.4` 低于 `beta.4.dev.N`，不能作为它的后续更新。每次新发行仍须单独取得用户明确同意。

完成测试机源码验证、汇报并获准打包后，在构建环境装依赖并运行 `npm run build:distribution`。将 Linux x64 包和同目录的 `distribution.json` 复制到用户实例，使用现有更新器安装并完成安装包验收。更新器对实际版本切换要求已构建的运行包，并在预检时核对包摘要。以下命令只用于已获准打包后的安装环节。

```sh
node scripts/update-m2.mjs preflight --runtime-bundle /path/to/whalenest.connect-plugin
node scripts/update-m2.mjs install --runtime-bundle /path/to/whalenest.connect-plugin
```

安装入口仅接收`--runtime-bundle FILE`。原功能开关和账号状态从现有instance.json继承，不借安装参数批量启用、登录或生成内容。独立运维对话使用下文的自测流程。

停机前检查账号/会话、工作目录、可执行文件、profile、配置与源码指纹，准备候选、运行包和回退备份；再次核对输入不变、任务空闲后停止同一个dsh-agent，冻结最终数据并切换。更新器恢复原Session、检查当前健康和历史摘要；already-active时不重启。预检失败保持服务运行。

当前源码部署使用同批源码的`deploy/serve-media.mjs`和`source-mode.mjs`。预检核对公开接口、原运行配置、启动依赖和完整源码清单；即使鲸栖版本号相同，源码变化仍通过完整切换启用。恢复点保留鲸栖自身文件及原接线，失败恢复不删除新增会话、作品或未知回执。已启用的Liveware分别由`whalenest-call`和`whalenest-song`托管；通话网关通过本机鉴权端口进入独立DSH线程。

安装包更新沿用`native-install.mjs`及官方插件管理入口，只处理鲸栖及其受控启动文件。更新后核对官方插件选择、主人归属、本机Runtime鉴权就绪和两个本机页面；平台入口及中继另用官方工具核对。公网页面需要ClawChat客户端认证，不再使用旧匿名`/liveware-status`辅助检查。官方连接器仅查版并提示，是否升级或回退由用户决定。

`build:distribution` 生成插件代码、运行清单、兼容版本及摘要。构建参数依次是输出目录、目标平台、版本、可选更新说明文本文件、可选前置要求 JSON 文件、可选升级路径 JSON 文件。前置要求文件内容为 `{"clawchatIntegration":{"minimumVersion":"0.2.26","upgradeVersion":"0.2.26","officialOnly":true}}` 形状，仅兼容历史格式，不包含命令或发行源；新发行默认不生成连接器前置条件，当前更新器也不会依据历史条件自动升级连接器或阻止鲸栖更新。构建清单登记 updateProtocol=1；可选路径为 schema=1、steps 数组，每项仅含同仓库的 version 与插件包 sha256，具体校验和接续规则见更新任务。用户数据、凭据与 `instance.json` 由宿主按实例配置提供，更新脚本按实际路径核对及保留。发行文件与聊天更新配置见[更新任务](tasks/plugin-updates.md)。

回退先保存前向数据和未知回执，再恢复兼容写入方；旧版本不理解的新增能力关闭，其任务/作品保留。离线安装器、更新技能目录和技能版本摘要也属预检，不只替换二进制。

## 歌曲 Liveware

歌曲页由实例singing.playback.enabled控制，安装继承现有开关。原版官方 Exposure 管理账号级中继，鲸栖通过公开 Managed Web App 接入通话服务；Core 不再自行启动中继。作品页监听实例回环端口 `8898`，首次发布使用 `clawchat-connect liveware` 登记私有应用。服务核对应用归属及中继状态，在 `dataDir/song-liveware.json` 保存 `binding`、`owner`、`appId` 和 `url`。已有实例沿用已登记的私有应用。Core 构建（历史文件已退役，原文保存在Git记录）

验收先检查应用根路径的 SongSmith 首页和三个入口，完成创作问答后核对原私聊与预填草稿。使用已有歌曲检查曲库、单曲链接、分段播放、下载和乐谱，并核对关联主人与匿名的访问结果。现有作品的乐谱按原 MusicHub 任务读取。验证页面及草稿可以使用已有歌曲和未发送草稿。

旋律验收覆盖哼唱、手绘、试听、乐谱保存和私聊草稿。歌曲保存后复查版本、封面、精修草稿、试听及下载。扩展旋律使用实例上的 Python 3 执行随包的 SongSmith ABC 工具。测试复用隔离样曲及替身任务，验证两次提交的状态检查、重启和未知回执。

按[适配清单](tasks/songsmith-adaptation.md)逐项核对。重点验证 `companion_songs draft` 的真实原谱与填词计划已经进入模型请求，`sing_song` 回执说明实际旋律采用状态，超量歌词在平台提交前被拒绝。已有整曲的精修沿原歌词约束，旧任务查询或恢复不重新生成。制作中页面只向主人提供进度；词、谱取回及标签修改分别核对回执和无新增生成任务。真实付费验收按[歌曲用量约定](requirements/singing.md#3-用量与真实验收)确认。

当主人明确选择参与分享的 ClawChat 用户后，在 `singing.playback.audience` 设置相同的用户 ID，并按原 Connect 的 Liveware 管理入口更新已有应用的 `allowlist`。使用主人、受邀好友和未受邀者核对作品可见性、互动和撤回。默认名单为空。歌词精校读取可选的 `singing.playback.alignment.configPath`。该绝对路径指向包含 `baseUrl` 与 `apiKey` 的对齐服务配置。实例有 FFmpeg 时先将歌曲转换成适合出站的单声道音频。验收只对主人选定的歌曲启动精校。

测试应用若按用户要求切到 `public`，只写入一首已标记为运维自测的 `publicDemoWorkId`。此入口只展示选定测试歌，仍遵循平台的 ClawChat 登录门槛。[Liveware 访问策略](https://agent-connection.clawling.com/use/liveware.md#who-can-open-it)

## 测试机用户状态重置

默认表情的审定清单见[素材清单](../deploy/stickers/catalog.json)。保留`instance.json`中`expressions.stickerCatalog`指向的产品资源目录及100张图片，禁止将其当作用户图库或临时缓存删除。完整重置可清空`aurabot/stickers`与`expressions/seed.json`，运行SDK随后恢复整套预置库。普通更新保留初始化记录和用户图库，尊重用户修改及删图。源码测试期间，`source-candidate.json`及其指向的活动源码目录属于运行程序，也必须保留；历史一次性清理脚本未经新范围核对不得复用。

按用户已确认范围只清理用户状态，保留 ClawChat 配对、传输水位、模型与运行配置、随包默认素材及两个 Liveware。先核对实际配置和清理范围，停止所有业务写入者并等待 QQ 子进程退出，再清理用户状态及旧用户备份，不保留用户数据副本。复核默认人格、空用户状态和保留项后恢复服务，重新检查就绪、唯一 SDK 进程、Liveware 及账号登出状态；连接握手、初始工作区等运行元数据不属于清空目标。原始记录留在忽略目录，避免其中包含用户内容。 0.2.22 及后续已适配组合还需清理 `browser-turns.json`、`web-activity/`、`operator-sessions.json` 及含正文的首次问候草稿，保留已有真实 `greeting-receipt.json` 防止重新问候；不能恢复旧 profile 备份覆盖新的 JSON-RPC 接线。无引用自有旧连接器须核对配置、技能、启动器和 profile 引用后才删，官方登记的历史包保持登记一致。群策略的默认同步标记属于运行元数据，不能要求其行数为零；实际群设置和聊天数据必须为空。

官方0.2.23托管Liveware的`plugin_durable_state`绑定记录及鲸栖`managed-liveware.json`属于入口接线，不能作为用户业务状态一并清空。按实际plugin/capability/lifetime核对后保留，其他持久状态逐项分类。源码模式保留活动候选及指针；清理旧候选中的实机副本时，仍须保留插件锁登记的安装包与校验文件，不以目录名推断可整删。新一轮从头测试默认保留用户最后确认的产品人格，清除其他自定义卡及个人偏好，音色、记忆整理时段和表达策略恢复当前产品默认。工作目录清空后重建产品问候与受控AGENTS，不恢复用户扩展区。清空后的最终验收只读，不新建模型会话、发送运维消息或生成媒体；同代码的真实模型证据在清理前完成并注明边界。

初始化修复后的完整重置还保留当前身份的`first-binding.json`（delegated开场／已有头像状态）及`greeting-input.json`，并在官方确切读取的`clawchat/greeting.md`重建完整人格输入。已提交且完成的`binding-transition.json`可清理；未完成绑定、未知投递或运行中的任务先核对，不能直接当作垃圾删除。QQ停稳后再清空用户资料及Crashpad转储，避免停止过程中刚生成的诊断残留。只清理未引用的运行临时目录，当前Core所用bridge patch保留。

首配记录中的`platformInstanceId`属于镜像身份校验接线，重置时与当前agent／主人／私聊一并保留。检查待发通知时，只有仍为pending、后台任务尚未进入投递、平台不存在原请求且没有执行中写入者，才可按用户重置指令取消；发送状态未知时仍须先核对。

停QQ不得只确认主管服务或QQ主进程退出：还须核对该实例的SnowLuma、Xvfb与D-Bus全部停稳，再清理及启动。不要暂停主管进程来代替这一步；残留的`:99`显示进程会让新Xvfb启动失败。只处理UID、程序路径和参数均能证明属于当前受管桌面的孤儿；确认进程已退出后才处理它的显示锁／socket。QQ重启失败时先停重试，查明原因并删除已核实的转储，不能让重试持续生成core文件。检查器应将暂未就绪的health记为失败项，避免空对象使后续数据检查提前中断。

QQ的`managed-desktop.json`仅登记受管桌面资料目录，是启动所需运行文件，和QQ账号资料、cookies分开保留。检查清空后的`session_intents`时，允许官方重新建立一条仅指向当前默认工作目录、名称/模式/模型/推理均为空、选项为`{}`的初始路由；实际会话、正文、用户模型选择和消息仍须为空，不能把保留个人选择的记录当作初始路由。

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

能力总览由[运行模板](../src/assets/capabilities.md)与其同目录摘要清单管理。首次准备、Runtime启动和受控更新会在实例实际工作目录的`AGENTS.md`维护鲸栖托管区块；手工说明放在区块外。预检发现托管区块被修改时保留原文件并停止受控切换，先核对该修改的归属。回退选择原安装包的模板；原包没有模板时仅移除仍匹配托管摘要的区块，保留其他内容。不要把本项目根目录给开发者使用的AGENTS.md复制给运行实例。

模板采用普通Markdown，围绕鲸鱼娘自身能力分节，简短说明各自的使用入口，语气沿用当前人格；QQ接入、两端聊天与共用档案属于伙伴能力，保留在总览。ClawChat通用平台管理及更新操作沿用各自工具和Skill入口。修改模板时同步更新`src/assets/workspace-instructions.json`的SHA-256，运行`node scripts/test.mjs test/workspace-instructions.test.mjs test/workspace-instructions-native.test.mjs test/distribution-inputs.test.mjs`，验证摘要、实际原生加载和分发输入；获准打包后再执行`npm run test:distribution`验证实际随包内容。格式依据与本轮内容审阅见[连续任务记录](tasks/connector-convergence-023.md#agents内容与格式优化)。

官方首次问候读取实际工作目录的`clawchat/greeting.md`。鲸栖以[运行模板](../src/assets/greeting.md)加当前完整人格，在准备、官方Core启动前和人格变更时同步这一确切文件；根目录的`greeting.md`不是官方输入。同步保留既有`greeting-receipt.json`，不重发已完成问候，鲸栖也不再另发欢迎语。历史文案保存在[deploy/clawchat/greeting.md](../deploy/clawchat/greeting.md)。

平台准备全新用户实例时，在实际 `DSH_HOME/companion/aurabot-v1/instance.json` 的 `clawchat` 段设置 `"firstBinding": true`，沿用实例内 Connect 程序和配置的绝对路径。新实例的 `owners` 为空，由 Connect 在配对后提供身份。准备未绑定的桥时可将同一实例配置传给 `prepare:connect`。已有绑定实例沿正常更新流程保留其身份和资料。

用 `prepare:connect` 处理未绑定模板时，输出的 `instance.json` 默认开启写歌、歌曲作品页和实时通话，并准备平台模型接线。预装实例使用这份配置经过支持 Liveware 中继的 Connect 启动。当前源实例采用原版官方连接器，源码候选直接验证；实时通话使用鲸栖独立DSH会话，实际开关以STATUS及实例配置为准。首次绑定核验主人后，两个本地服务启动，并通过原 Connect 绑定登记私有入口。已登记的私有入口分别保存在 `dataDir/call-liveware.json` 和 `dataDir/song-liveware.json`。验收时在原私聊打开[歌曲作品页](#歌曲-liveware)和[通话入口](tasks/realtime-call.md#接入与验收)。

启动准备和桥从本机 Connect 集中身份适配核对已验证的agent、安装主人与私聊，按身份维护`dataDir/first-binding.json`。复制来的runtime存在不再跳过首配；同一主人新账号只重建账号接线和应用引用，不删除源机云端应用或个人内容。仅私聊变化时更新路由并复用头像完成状态；源码候选在校验原安装与完整性后同批登记新接线，中断通过`binding-transition.json`恢复。不同主人仍须明确完成个人数据交接，不能直接继承旧授权。

开场由官方Runtime独占生成、发送并保管回执，鲸栖不再另外发送欢迎语。鲸栖在首次准备、Core启动前和人格切换／编辑时，用当前完整人格加[问候模板](../src/assets/greeting.md)维护工作目录的`greeting.md`；自定义文件发生冲突时保留，需另行检查。AGENTS继续只管能力总览。头像通过既有官方工具读取，已有头像直接保留，空头像按需设置随包的[鲸鱼娘头像 PNG](../src/assets/whalenest-avatar.png)。未知操作只核对原回执，不重发。真实首次开场和新账号应用验收须使用新实例；既有实例重启不会重发开场。[本轮初始化修复](tasks/image-machine-audit.md#2026-11-26初始化修复执行记录)

## ClawChat 对话自测

用户已要求可自动执行的ClawChat对话由Agent自行验证。测试输入明确标记运维自测，分别保存实际模型/工具、原会话、回答、平台message ID和当前健康；原生桥注入不能冒充客户端入站或播放。

scripts/probe-live.mjs参数依次为INSTANCE_JSON BRIDGE_PATH OUTPUT_JSON [PROMPTS_JSON]。默认三参数只恢复和检查，不调用模型；可选JSON数组最多三轮，每项含id、text，可附requiredTools/forbiddenTools。ID以whalenest-selftest-开头，同一被测组合重试复用持久回合，未知先核对，不换ID重做。

运维自测须在停止SDK前保存其实际运行环境，在同一指定实例内继承平台实例标识、自有源码预加载、模型接线和工作目录；不得用SSH默认环境冒充服务环境。只记录必要的非敏感字段及环境变量名称，不在报告中输出密钥。缺少平台实例标识会被镜像身份保护拒绝，不应关闭保护绕过。

普通探针前核对身份与空闲，停止同一个 `dsh-agent` 并确认原 SDK 退出，再冻结最新 `companion`、`sessions` 和 `storages`，只回收已退出进程的锁。更新器在停机后和探针退出后检查该 `DSH_HOME` 的 SDK 进程。探针启动前复核，即使另一个 SDK 尚未取得数据锁，也会拒绝重叠启动。使用原 sdk profile 和实际安装桥，最后恢复服务并核对身份、历史与健康。

语音/媒体工具需要Core在线取得回执：通过原loopback控制面/core/v1/bindings/quiesce，带X-ClawChat-Connect-Core-Config-Path并使用完整bindingIds暂停入站；等待唯一原SDK退出后再运行探针。若未退出，只能在队列已暂停、空闲且PID/patch身份匹配时终止该进程，不能启动两个写入者。探针结束后释放暂停、重启原服务并复核，失败路径同样执行。`resume` 只恢复队列，Core 可能继续持有已经退出的 DSH 子进程引用。收尾须核对原服务启动了新的 SDK 进程，并核对原会话完成新回合、平台确认文字回复。连接健康只证明链路在线。

探针回复经原Core文本/媒体工具发回原私聊，稳定request ID与真实message ID关联；平台失败、余额不足和未知结果如实记录，不自动改ID重试付费生成。麦克风、上传、显示、下载和播放须有实际对应客户端证据。禁止computer use的用户约束继续有效。

## QQ测试网关运维

测试机的独立网关启动入口为[serve-qq-gateway.py](../deploy/serve-qq-gateway.py)，不包含QQ聊天或主人关联业务。`~/.clawling/supervisord/whalenest-qq.conf`管理它，原`dsh-agent`继续独立运行。程序使用`autostart=true`、`autorestart=true`，正常退出也须恢复；仅设unexpected曾留下停止的网关。使用`/opt/clawnest/bin/supervisord ctl status|start|stop whalenest-qq`检查和启停；不要向所有QQ进程注入或修改用户原生QQ配置。

QQ主管通过`deploy/startup-status.mjs`读取当前选定源码或安装插件的首启状态，等待基础聊天及入口首轮完成后再拉起桌面；不是关闭QQ功能。`qq_gateway_lifecycle.py`只停止该主管创建的进程组，并逐组等待。当前仍运行旧版并行退出处理器时，源码切换使用`deploy/stop-qq-desktop.py`一次性核验父子PID后有序排空，再由supervisor停止主管；不得只暂停主管后留下显示或总线。源码验证继承并更新这组项目启动文件，回退一并恢复。

QQ程序配置必须保留`pre_stop_hook=/usr/bin/python3 /home/node/projects/whale-nest/deploy/qq-pre-stop.py`。该原生停止前钩子只匹配本用户、确切启动脚本的唯一主管，发送正常退出信号，并等待主管及其登记的QQ／SnowLuma／D-Bus／Xvfb进程组全部结束；启动中收到停止也会持续核对后续登记。禁止在钩子里再次调用supervisor stop，避免递归。现有源码更新入口继续先核验并排空旧进程；新钩子参与启动配套文件的复制和后续更新。

预装Go管理器的旧信号等待可能被其他子进程退出提前唤醒。本轮以同一二进制隔离复现；不修改该平台二进制，只在鲸栖拥有的QQ程序上使用其原生钩子。更新配置前保存原文件，先经现有安全入口停QQ，再重载发生变化的QQ配置；重载前检查没有其他待生效的程序配置，重载后核对聊天SDK及其他服务PID不变。验收使用原先失败的`ctl restart whalenest-qq`，核对全部旧进程消失、QQ就绪、无新增转储和配置保持。具体证据见[本轮专项](tasks/image-machine-audit.md#qq后台管理器重启残留专项2026-11-27)。

运行依赖在`~/.local/share/whale-nest/qq-gateways/`：SnowLuma、官方Linux QQ、Debian用户目录依赖及私有虚拟显示。没有sudo安装，也没有把这些程序打进鲸栖插件。Xvfb的用户目录迁移保留原二进制及`desktop-deps/xvfb-relocation.json`的前后摘要；重启时恢复该私有路径。

中文字体也是启动前提：本机采用Debian `fonts-wqy-microhei`，解包后在用户字体目录链接并建立缓存；启动器以fontconfig核验实际`zh-cn`覆盖。缺字体时二维码仍可能出现，但QQ中文错误/验证弹窗会空白，不能把二维码能显示当作完整环境检查通过。字体变化需在加载新进程后复核界面；不自动确认客户端弹窗或用户安全验证。

实例的`qq.gateway`选择`snowluma`，控制台使用回环5099及独立`tokenFile`。`loginQrFile`和`loginRequestFile`指向服务私有`login/qr.json`、`request.json`，只有运维可配置。有效码直接复用，失效时在原QQ窗口刷新，不重启QQ或SnowLuma；原ClawChat媒体发送负责回执。实际窗口状态写入同目录status.json，二维码PNG按请求号、时间及摘要核对，不能仅凭PNG文件新写入就认定二维码有效。

运维以实际网关回执校验账号和聊天通道。二维码和登录状态留在实例私有目录。主人关联仍需原聊天确认。资源状态由宿主采样，后台任务按内存门禁延后。

## 功能运维入口

| 范围 | 入口与资料 |
| --- | --- |
| 人格/记忆 | companion_persona、companion_memory；[人格设计](technical/persona-management.md)、[记忆设计](technical/long-term-memory.md) |
| 自动策略与首选 | companion_settings；[共同投递](technical/proactive-delivery.md)、[主动联系](technical/active-contact.md) |
| 音色与自动表达 | 主人私聊说“查看可选音色”“换成小鲸娘4”“恢复默认音色”，语音消息与下次通话使用保存的选择。companion_voice、companion_expression；[语音](technical/voice.md)、[心情](technical/mood.md) |
| 表情 | companion_stickers及QQ原别名；[共同图库](technical/stickers.md) |
| B站 | 原工具、bili_config、bili_inbox；[设计](technical/bili.md) |
| 私人日记与发布 | companion_diary；[共同档案与分平台发布](technical/diary.md) |
| 画作与歌曲 | companion_paintings、companion_songs；[图像](technical/image-generation.md)、[歌曲](technical/singing.md) |
| QQ空间 | qq_qzone_social status/run/update；[模块清单](IMPLEMENTATION-INVENTORY.md) |
| QQ接入与关联 | ClawChat主人私聊的companion_qq；[接入范围与验收](tasks/M4-qq-dual-platform.md#接入范围与真实验收条件) |

当前实例默认值和开关只维护在STATUS。模型认证沿配对provider配置，不读取/公开Key、不由模型指定任意端点；账号登录、互动、发布与付费生成均沿既定授权范围。请求和作品恢复只补下载/发送，不重新创建付费任务。

源码切换可同时指定`--exposure-bundle /absolute/official-package.connect-plugin`和`--exposure-rollback-bundle /absolute/original-official-package.connect-plugin`，预检核对旧包内容相同及输入指纹，停机后通过官方离线replace切换。回退只使用已记录的原官方包，不编辑安装锁。当前源码清单也同步鲸栖自己的程序目录并退役旧补丁文件；发行输入与安装消费者共用完整程序清单，源码阶段可运行distribution-inputs检查而不构建发行包。
