# 上游来源与许可

仓库内的第三方源码、角色参考和平台组件按各自来源保留。固定版本与摘要见[来源锁](../upstream.lock.json)和各组件目录。依赖版本见根 lockfile。

## 固定来源

| 对象 | 来源与版本 | 使用位置 |
| --- | --- | --- |
| Aurabot | [aureth-labs/dsh-aurabot-qq](https://github.com/aureth-labs/dsh-aurabot-qq/tree/a138d14e3215f052dfa7d6a9dd16c0e409d9752d)，1.2.1 | 陪伴流程、内部模块与产品联动的改造起点 |
| 早期ClawChat兼容桥 | [x-metheus/clawchat-plugin-connect](https://github.com/x-metheus/clawchat-plugin-connect/tree/2cb2d450c381e3b64a337c907e72ba6d9e299316)，0.1.0-beta.9 | 固定桥及SDK参考资产，不能当作当前媒体Core来源 |
| 同连接媒体Core及宿主 | 官方0.2.10实际来源b540bc211dc924d0200e6f71c18082de490d68f4；[独立来源清单](../integration/clawchat/core-media/SOURCE.json) | media.3及input.1，构建与许可见[扩展说明](../integration/clawchat/core-media/README.md) |
| DSH | @deepseek-ai/dsh 0.2.2-rc.1 | 当前 SDK 运行和兼容验证目标 |
| 原始人格 | [dafeiyu-config-pack](https://github.com/zexuanw958-svg/dafeiyu-config-pack/blob/8c01b0361b8a4baff5be3d2bc67ed55108953086/persona/大肥鱼.md) | 当前构建包的初始预置与迁移校验来源。鲸鱼娘修订稿的出处见[人格说明](persona-sources.md) |

## 署名与原文

Aurabot 原许可证为 MIT，原作者为 Aurabot contributors。原文保存为 [Aurabot LICENSE](../licenses/aurabot.LICENSE)，第三方声明逐字保存在 [Aurabot 第三方声明](../licenses/aurabot.THIRD-PARTY-NOTICES.txt)。

Aurabot 的 purpose 纯逻辑核心移植自 Mieksido/surfcore，第三方声明附有原版权及 MIT 全文。后续提取该模块时保留对应声明；Aurabot 对其他社区项目的设计致谢与直接复制代码的来源说明分别保留。[上游第三方声明](https://github.com/aureth-labs/dsh-aurabot-qq/blob/a138d14e3215f052dfa7d6a9dd16c0e409d9752d/THIRD-PARTY-NOTICES.md)

ClawChat 实时通话复用平台 ClawNest Voice 0.1.11 的页面和语音网关。鲸栖适配 DSH 会话、传输和通话界面。固定版本、摘要和修改文件记录在[平台发布物清单](../vendor/platform-liveware/SOURCE.json)，接入和实测见[实时通话任务](tasks/realtime-call.md)。

QQ 网关、模型服务、声音和图片素材有各自来源。当前设计不将某个网关或声音权重默认打入安装包，后续分发按实际依赖版本保存其来源和许可。Aurabot 的开源许可不替代外部依赖的条件。

QQ 网关与 Linux QQ 由宿主按实际兼容条件提供，使用各自的发行物和许可。

平台唱歌按SongSmith 1.0.6 的平台接口接入歌曲服务，作品 Liveware 复用同版本原版作品页。原 Aurabot 模块管理及完成联动保留原 MIT 声明。平台发布物版本及页面适配见[来源清单](../vendor/platform-liveware/SOURCE.json)和[作品页接入](technical/singing.md#6-clawchat-作品页)。

歌曲作品页的乐谱渲染使用 npm 发布的 [ABCJS 6.7.0](https://registry.npmjs.org/abcjs/6.7.0)。随包保留 MIT 原文和浏览器构建产物的第三方通知，由构建脚本核验文件摘要。[版本和摘要](../vendor/abcjs/SOURCE.json)

M3 本地二维码编码使用 [qrcode-generator 1.4.4](https://github.com/kazuhikoarase/qrcode-generator)，MIT、Copyright 2009 Kazuhiko Arase；未改动的源码以 .cjs 扩展保存，许可及 npm 完整性记录在 [vendor/qrcode-generator](../vendor/qrcode-generator/SOURCE.json)，构建前校验代码和许可摘要。它只编码登录链接，不调用生图或其他模型。B 站接线及验收范围见[功能需求](requirements/bili.md)。

## 源码与构建准备

Aurabot 固定提交的完整 252 个原文件已纳入 [vendor/aurabot](../vendor/aurabot)，文件哈希记录在 [来源清单](../vendor/aurabot.provenance.json)，通过 npm run check:vendor 校验；适配代码放在 src，不改写原文件。Core 的研究快照仍位于忽略目录 .whale-nest/research/，不随产品交付；需要时从来源锁的固定提交获取。

构建记录上游原提交、包内文件摘要和所需宿主版本。鲸栖自有代码的发布许可由项目维护者确定，各第三方许可适用于对应组件。

## 兼容 Core 桥

既有 .3 兼容桥的桥代码及运行 provider 基线、原 MIT 和文件哈希保存在 [integration/clawchat](../integration/clawchat)。它基于上述 Core 固定提交，包含前期 DSH 兼容改动；不冒充未经修改的上游原文件。构建器先校验 [来源清单](../integration/clawchat/SOURCE.json)，再生成新桥。

M2 从同一已审核兼容包提取运行 provider 与 manifest，新增文件也纳入 SOURCE.json 校验。自己的 Runtime Adapter 和管理 provider 封装位于 src；构建产物携带许可、固定 Aurabot 原文与原人格，不打包用户凭据、研究缓存或开发依赖。支持目标当前仅 Linux x64。
