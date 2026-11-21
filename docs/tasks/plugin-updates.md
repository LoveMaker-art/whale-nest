# 已交付实例的插件更新

鲸栖在现有 ClawChat 或已关联 QQ 私聊提供检查、确认和查询。两端共用更新任务及安装状态。实际进度见[STATUS](../STATUS.md)。

## 已确认范围

本任务维护鲸栖插件的版本发布、检查更新、安装切换、数据迁移和回退。更新面向已安装鲸栖的实例，复用 ClawChat Connect 插件管理器。

插件更新应保留用户人格选择、聊天、记忆、心情、经历、作品、账号配置和投递记录。源码及依赖版本变化与用户持久数据分开处理，继续复用既有模块和平台设施。

## 独立插件与复用原则（已确认）

项目目标是吸收原插件的有效功能，形成支持ClawChat与QQ的鲸栖独立插件。插件身份、发行版本、更新元数据、发布包及更新源均属于鲸栖；用户实例仅接收本项目集成并验证后发布的代码，上游新版本作为维护输入，由本项目评估合入。

原更新能力按实际适用性复用：版本检查、缓存、稳定/测试频道选择和提示数据可吸收，版本比较须按本项目版本规则验证；检查源使用本项目元数据。原DSH桌面命令和面板入口改接当前容器/Connect支持的执行与交互方式，复用现有安装管理、数据分离和必要恢复能力。保留唯一更新流程，避免重复开发同一能力。

## 现有代码证据

- [构建器](../../scripts/build-distribution.mjs)可生成Linux x64 .connect-plugin运行包及distribution.json摘要；数据位于包外。
- [原机更新器](../../scripts/update-m2.mjs)已有预检、备份、迁移、切换、会话检查及失败回退，但依赖本地工程、原实例配置和私有Core构建目录，不能直接视为普通用户更新产品。
- 固定b540的Connect插件管理源码支持GitHub Release来源及plugin update/replace；update要求来源身份不变，本地包改GitHub来源需显式replace。指定预发布须带确切tag，未指定版本的GitHub解析只选择稳定版。以上来自固定源码，平台当前开放入口及实际行为尚未在线核实。
- 固定上游的[更新检查器](../../vendor/aurabot/src/core/update.js)根据传入package元数据读取仓库，检查main/beta版本、缓存6小时并返回命令/提示；[原客户端](../../vendor/aurabot/client/client.js)呈现结果。它可作为复用来源，本体安装由DSH负责，云端执行须适配。
- 本项目还依赖Core media.3、宿主input.1和匹配DSH。运行插件包不包含完整Core升级步骤，更新方案需区分普通插件更新与底座兼容升级。

## 版本兼容

鲸栖比较发行版各段，`dev.20` 排在 `dev.9` 之后，同一基础版本的正式版排在预发布版之后。引导安装沿用现有运维预检，兼容来源经回归后放行。聊天更新在 Linux x64 预检实际 DSH 和 Core 版本、数据格式版本、实例归属与当前安装来源。

## 更新入口核查

| 核查对象 | 已有能力与适用范围 |
| --- | --- |
| Connect插件管理器 | 固定b540源码支持安装、update、显式replace来源及select保留版本；管理CLI调用实例内回环Core。可复用下载、包校验、配置继承、暂停相关会话及切换能力；不能据此声称平台已有云端批量更新API。 |
| 宿主兼容性 | 发布清单列明支持的 DSH、Core 和桥版本，更新前按实例实际版本预检。 |
| 原更新检查器 | 可复用检查、缓存和提示结构，替换为鲸栖自己的版本元数据与更新源；它返回桌面安装命令的部分需适配。无需另建下载和安装引擎。 |

固定 b540 的实现依据见[CLI](https://github.com/x-metheus/clawchat-plugin-connect/blob/b540bc211dc924d0200e6f71c18082de490d68f4/src/service/cli.ts)、[Core 管理入口](https://github.com/x-metheus/clawchat-plugin-connect/blob/b540bc211dc924d0200e6f71c18082de490d68f4/src/service/core-control.ts)和[插件切换](https://github.com/x-metheus/clawchat-plugin-connect/blob/b540bc211dc924d0200e6f71c18082de490d68f4/src/plugin/host.ts)。可用执行入口以实机验证为准。

Core插件存储位于实际配置文件的父目录下plugins/及plugins.lock.json，默认在~/.clawchat-connect；状态库允许单独指定绝对路径。鲸栖数据位于DSH_HOME/companion/aurabot-v1，原生聊天及身份沿用实际DSH配置。开发时应读取实例真实路径，不能只检查默认目录，也不能凭路径位于HOME就认定已持久化。

## 已确认的云端聊天更新流程

主人在 ClawChat 或已关联 QQ 私聊可以说「检查更新」或「查看更新进度」。确认操作需输入提示里的完整 `确认更新 <版本号>`，也可以输入 `暂不更新 <版本号>`。后台在回合空闲后执行，结果回到确认更新的私聊。原人格、聊天、记忆、心情、作品和账号继续沿用各自的数据目录。

| 编号 | 需求与验收行为 |
| --- | --- |
| U1 自有发行 | 沿用whalenest.runtime.deepseek-harness身份，从鲸栖自己的发布源读取确切版本、更新摘要和兼容条件；Linux x64包的tag与包内版本一致，发布资产有Connect要求的GitHub sha256 digest。上游变化先由本项目集成验证。 |
| U2 检查和提醒 | SDK 运行时复用六小时检查缓存。后台提醒使用全局首选私聊，同版去重，沿用当前人格和后台模型额度生成提示。额度不足或模型失败时使用简短兜底。支持仅正式版和接收预发布，默认跟随当前安装版本。 |
| U3 主人确认 | 提示当前版、目标版、更新内容及短暂中断；只接受可信主人私聊确认该目标版本，允许暂不更新。QQ与ClawChat指向同一实例，同一更新仅执行一次；普通好友和群聊不能发起管理操作。 |
| U4 后台执行 | 对话将确认写入实例数据目录。独立 Node 进程核对原绑定、兼容条件、空闲及旧版本完整性，调用实例内 Connect 完成切换。 |
| U5 保留数据 | 保留身份、人格、聊天、记忆、心情、作品、账号设置和投递记录。首版沿用数据格式 1，跨格式升级需要另行验收迁移与回退方法。 |
| U6 结果与恢复 | 以 Connect 安装状态与原绑定状态核对结果。目标版本启用异常时选择记录的旧版，保留升级后的数据。回执不明确时核对原任务，主动终态回执可由独立进程使用简短兜底发送。 |

安装复用一个Connect管理器：旧本地来源迁移到鲸栖GitHub仓库时首次显式replace，后续同源update，预发布指定确切tag。Connect保留旧包可供select，但提交后的激活失败可能标记不可用，完整恢复仍需本项目现有步骤配合。

## 发行与实例配置

管理员在实例 `instance.json` 配置 `pluginUpdates.repository`，值为鲸栖维护的公开 GitHub 仓库 `owner/repo`。`channel` 可选 `stable` 或 `beta`。`dshExecutable` 可指定实际 DSH 可执行文件的绝对路径，默认 `/opt/dsh/node_modules/.bin/dsh`。用户通过既有私聊接收或查询，账号绑定由宿主及网关提供。

每个发行使用与包版本匹配的 GitHub 不可变 Release。资产放同版 `distribution.json` 和一个 Linux x64 `.connect-plugin`，两者都使用 GitHub 返回的 SHA-256 摘要。构建命令可用第四个参数传入纯文本更新说明文件。启用不可变发行并校验 tag 和摘要后再作为更新源。当前固定的 Connect 解析器按发行选取插件资产，因此首版每个发行只放一个插件包。[GitHub 不可变发行](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases) · [GitHub Releases API](https://docs.github.com/en/rest/releases/releases?apiVersion=latest)

## 完成条件

本地已验证实际 Connect 安装器的切换和失败回退。公开发行源配置和真实聊天更新验收由维护者在发行后完成。核对目标版本、独立进程执行、原私聊回执、重启后继续原会话，以及失败回退后保留配置和用户数据。
