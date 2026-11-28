# 上游来源与许可

仓库内的第三方源码、角色参考和平台组件按各自来源保留。固定版本与摘要见[来源锁](../upstream.lock.json)和各组件目录。依赖版本见根 lockfile。

## 固定来源

| 对象 | 来源与版本 | 使用位置 |
| --- | --- | --- |
| Aurabot | [aureth-labs/dsh-aurabot-qq](https://github.com/aureth-labs/dsh-aurabot-qq/tree/a138d14e3215f052dfa7d6a9dd16c0e409d9752d)，1.2.1 | 陪伴流程、内部模块与产品联动的改造起点 |
| 早期ClawChat兼容桥 | [x-metheus/clawchat-plugin-connect](https://github.com/x-metheus/clawchat-plugin-connect/tree/2cb2d450c381e3b64a337c907e72ba6d9e299316)，0.1.0-beta.9 | 固定桥及SDK参考资产，不能当作当前媒体Core来源 |
| ClawChat Core、DSH provider 与 Exposure | 官方0.2.26签名发布物，connect_commit为`2ed6b947e38a733f6a7d1d410d0431c128c1a8f5`。[适配来源](../integration/clawchat/SOURCE.json) | Core与Exposure使用原版；Runtime factory及四个Bridge辅助文件按该版本校验原样使用，不携带Core补丁。 |
| DSH | 仓库依赖 @deepseek-ai/dsh 0.2.2-rc.1，源机运行 0.2.2-rc.5 | 依赖与实际运行分别记录，不以 DSH 版本阻断鲸栖更新 |
| 原始人格 | [dafeiyu-config-pack](https://github.com/zexuanw958-svg/dafeiyu-config-pack/blob/8c01b0361b8a4baff5be3d2bc67ed55108953086/persona/大肥鱼.md) | 当前构建包的初始预置与迁移校验来源。鲸鱼娘修订稿的出处见[人格说明](persona-sources.md) |

## 署名与原文

Aurabot 原许可证为 MIT，原作者为 Aurabot contributors。原文保存为 [Aurabot LICENSE](../licenses/aurabot.LICENSE)，第三方声明逐字保存在 [Aurabot 第三方声明](../licenses/aurabot.THIRD-PARTY-NOTICES.txt)。

Aurabot 的 purpose 纯逻辑核心移植自 Mieksido/surfcore，第三方声明附有原版权及 MIT 全文。后续提取该模块时保留对应声明；Aurabot 对其他社区项目的设计致谢与直接复制代码的来源说明分别保留。[上游第三方声明](https://github.com/aureth-labs/dsh-aurabot-qq/blob/a138d14e3215f052dfa7d6a9dd16c0e409d9752d/THIRD-PARTY-NOTICES.md)

ClawChat 实时通话复用平台 ClawNest Voice 0.1.11 的页面和语音网关。鲸栖适配 DSH 会话、传输和通话界面。固定版本、摘要和修改文件记录在[平台发布物清单](../vendor/platform-liveware/SOURCE.json)，接入和实测见[实时通话任务](tasks/realtime-call.md)。

QQ 网关、模型服务、声音和图片素材有各自来源。当前设计不将某个网关或声音权重默认打入安装包，后续分发按实际依赖版本保存其来源和许可。Aurabot 的开源许可不替代外部依赖的条件。

QQ 网关与 Linux QQ 由宿主按实际兼容条件提供，使用各自的发行物和许可。

平台唱歌按SongSmith 1.0.6 的平台接口接入歌曲服务，作品 Liveware 复用同版本原版作品页。原 Aurabot 模块管理及完成联动保留原 MIT 声明。平台发布物版本及页面适配见[来源清单](../vendor/platform-liveware/SOURCE.json)和[作品页接入](technical/singing.md#6-clawchat-作品页)。

歌曲适配对照该发布物的 songwriting 技能及 humming、score-editing 说明。原版 ABC 工具和浏览器乐句划分程序保持固定源码；发音单位计数及按谱歌词位置推算参考原版 `serve.py`，由鲸栖的模型工具、任务和对齐模块接入。与原版多用户创作、品牌和宿主不同的范围见[完整核对清单](tasks/songsmith-adaptation.md)。

歌曲作品页的乐谱渲染使用 npm 发布的 [ABCJS 6.7.0](https://registry.npmjs.org/abcjs/6.7.0)。随包保留 MIT 原文和浏览器构建产物的第三方通知，由构建脚本核验文件摘要。[版本和摘要](../vendor/abcjs/SOURCE.json)

M3 本地二维码编码使用 [qrcode-generator 1.4.4](https://github.com/kazuhikoarase/qrcode-generator)，MIT、Copyright 2009 Kazuhiko Arase；未改动的源码以 .cjs 扩展保存，许可及 npm 完整性记录在 [vendor/qrcode-generator](../vendor/qrcode-generator/SOURCE.json)，构建前校验代码和许可摘要。它只编码登录链接，不调用生图或其他模型。B 站接线及验收范围见[功能需求](requirements/bili.md)。

## 源码与构建准备

Aurabot 固定提交的完整 252 个原文件已纳入 [vendor/aurabot](../vendor/aurabot)，文件哈希记录在 [来源清单](../vendor/aurabot.provenance.json)，通过 npm run check:vendor 校验；适配代码放在 src，不改写原文件。Core 的研究快照仍位于忽略目录 .whale-nest/research/，不随产品交付；需要时从来源锁的固定提交获取。

构建记录上游原提交、包内文件摘要和所需宿主版本。鲸栖自有代码采用 [MIT 许可证](../LICENSE)。第三方组件沿用各自的许可与署名。

## Runtime 与 Bridge 的来源边界

当前官方 Runtime Provider 从固定 `0.2.26` 资产校验后原样打包，由鲸栖 `runtime-provider.mjs` 使用公开 factory、`runtimeAdapter.createBridge` 和 Runtime Adapter 接口消费；构建器不再文字替换官方 provider。通话模型配置由鲸栖桥进程自己的配置覆盖层加载，官方宿主由平台管理，鲸栖只调用公开serve，不复制或覆盖宿主入口。

当前运行的 DSH 业务 Bridge 是鲸栖自有实现，位于 `src/dsh-bridge*.mjs`，由 `src/connect-bridge.mjs` 装载业务。构建器不再读取、改写或执行原版 `deepseek-harness-bridge.mjs` 作为业务桥；该原文件保留为固定来源资产。帧编码、历史分页、审批策略和问题提供器四个协议辅助模块继续复用已核验的官方原文件，保留原许可及摘要。[构建入口](../scripts/build-connect.mjs) · [来源清单](../integration/clawchat/SOURCE.json)

本地兼容 manifest 使用鲸栖自己的插件身份，不冒充原版官方 manifest。运行包携带必要许可、固定 Aurabot 原文与原人格，不打包用户凭据、研究缓存或开发依赖。当前支持目标为 Linux x64。
