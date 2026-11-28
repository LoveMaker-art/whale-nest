# 表情包开发设计

依据[产品基线](../PRODUCT.md#表情包)和[功能需求](../requirements/stickers.md)维护两端共用图库与选图流程。实际部署、启用与验收见[当前状态](../STATUS.md)。

## 1 复用与实际差异

复用原[createStickerStore](../../vendor/aurabot/src/features/stickers.js)的library、match、addFromBuffer、rename、remove、markUsed，以及原[stickers模块](../../vendor/aurabot/src/modules/stickers/index.js)的QQ入口。[构建器](../../scripts/build-aurabot-stickers.mjs)校验固定来源后生成兼容产物，为 rename 增加 toQQ 选项，将收藏导入的单文件读取上限统一为 5 MiB。关闭视觉起名时逐张处理后释放下载缓冲。[共享入口](../../src/stickers.mjs)统一两端工具规则，增删改分别传toQQ:false、fromQQ:false；[expressions.mjs](../../src/expressions.mjs)继续负责表达出口。

未经适配的原qq_collect_sticker受自动收图开关控制，qq_save_sticker/qq_add_sticker默认带QQ收藏语义。当前这些入口及qq_edit_sticker已委派到同一共享动作，原工具名称和原store保留；QQ原发送仍经Hub执行。非主人不能管理主人图库，原QQ其他参与者的发送权限沿原通道保留。

## 2 最小改动

| 位置 | 处理 |
| --- | --- |
| 原stickers模块及[兼容构建器](../../scripts/build-aurabot-host.mjs) | 手动收录与自动收图分开。明确收录通过主人及手动请求校验后直接调用同一store，不依赖collect=true；原自动收录继续关闭。QQ工具别名调用同一动作，不保留能绕开显式要求的收画作分支。 |
| 原store及现有CC管理工具 | 共同图库操作传toQQ:false，删除传fromQQ:false；非QQ收藏动作不附带账号写入。首轮caption=false，空备注用简单默认名，不调用视觉模型起名。 |
| [QQ Hub](../../vendor/aurabot/src/chat/hub.js)、[media.mjs](../../src/media.mjs) | 各自解析当前会话实际图片/引用，或主人明确指定的获准作品；没有素材或指代不清则返回缺口，不读取另一端未收录图片。 |
| [expressions.mjs](../../src/expressions.mjs) | 保留管理、素材检查和媒体回执，发送复用store.match与现有发送者；一轮手动发图后取消自动补图。 |
| 原QQ收藏导入 | 保留qq_import_qq_stickers及主人校验，只在明确要求并具备网关权限时执行。向共同图库增删图片不隐式同步QQ收藏。 |

工具层必须核实主人手动请求，不能把模型自行选择调用等同于主人明确要求。保留原QQ能力入口，涉及本轮收录规则的别名统一约束；非主人不能改名、改标签、删除或收录主人共同图库。

[sticker-material.mjs](../../src/sticker-material.mjs)按当前Session读取已完成的附件记录，QQ沿原recentMedia和已解析引用取材。多图需index，旧图片可用同会话inputId；明确给出的工作区文件或图片URL也可使用。沿原QQ手动收图的5MiB上限；校验文件和摘要，拒绝跨会话未收录图片。画作使用本会话编号或主人明确给出的完整文件名，停用全局“最新画作”的隐式回退。真实ASR命令可使用已确认转写，附件名字及工具参数中的文字不构成收录授权。

## 3 状态与表达

原图库文件继续作为唯一权威数据，不复制QQ库和CC库。已明确收录素材成为共同获准成果；原MD5去重、使用次数及文件校验继续使用，操作成功按真实写入结果反馈。

开关、50%基础概率及原心情倍率采用[语音设计中的共同表达接线](voice.md#3-与表情共用原表达选择)：一份表达设置、一次选择，QQ由原Hub发，CC由现有媒体通道发。匹配、无素材反馈和手动优先保持一致，不改动心情算法。

删除保留原规则和初始化标记，不撤回历史聊天图片，不在重启时重新播种已删初始素材。expressions/sticker-operations按原生调用身份保存动作结果，旧收录输入重放不恢复已删除图片；QQ发送回执单独关联原请求，只有真实messageId才确认，未知保留。手动发送回当前会话，后台通知是否附表情仍按各自范围。

[共同选图实现](../../src/sticker-selection.mjs)在 DSH 本轮第一步按表达设置和当前心情抽取一次，只在抽中后给本轮模型加入场景指令。模型在原回复流末尾给出单个内部结果。DSH 流适配在文字被记录和投影前提取该结果，对分段、无效和多结果按产品基线处理。普通查询、搜索、读取成功后沿用同一抽取，工具续步不重抽；QQ 原回复中的表情标签只为明确的手动请求保留。

工具动作在同一选图模块中按完整tool-call分类：B站资料/搜索、记忆读取、网页及文件读取等已核实入口保留配图；可读写的管理工具核对action/command，bili_config携带patch即视为写入。未知工具、非法参数、写入或媒体调用保留取消行为，不以工具名包含read/get等片段推断。开始/参数增量不提前取消，完整调用未完成则取消。续步只核对本轮记录过的toolCallId，SDK isError以及本适配器约定的结构化ok=false或失败标记会取消；普通文件/网页正文中的JSON错误字段作为内容处理。原始概率、语境、素材匹配、正文ACK、使用记录和重复送达保护保持。

图库用原标签保存[场景、话题与表达方向](../requirements/stickers.md#2-入库用途与本轮配图)，用「不随机」保留只手动使用的约定。两端共用这套标签和精确匹配。实际获确认的用图时间按通道、账号和会话保存，重启后继续用于排序。手动编辑标签仍保留只手动权限，通过明确操作可重新开启自动使用。

QQ 原 Hub 在正文收到回执后补发，ClawChat 在最终正文确认后发送已准备的表情。两端依据同一图库和实际发送状态复查，自动图片每轮使用稳定请求标识。同一请求结果不确定时保留原回执和素材选择。手动操作可用 companion_stickers 的 status 和 ClawChat 的 media_status 核实。ClawChat Core 扩展（历史文件已退役，原文保存在Git记录）

## 4 回归与交付

扩展现有expressions/native、native-qq与媒体回归：两端操作同一个store、collect=false仍可明确收录、普通图片不自动收、画作不被私自收录、不调用QQ收藏/视觉起名、同图去重、主人权限、修改和删除重启保留。QQ原工具及CC工具均验证，避免只修其中一个入口。

验证早抽取、原概率倍率、同一次模型生成、标记不可见、精确匹配、同会话用图排序、手动发送防重复、GIF真实发送及未知回执。ClawChat沿原通道自行测试，QQ先真实SDK和模拟网关；QQ收藏及真实客户端呈现单独记录，不能拿共同图库测试替代。

## 逐图标注和精确匹配

复用原图库的五个短标签位置保存已确认场景、话题和表达方向。抽中后，`sticker-selection.mjs` 才向当前模型给出按场景分组的图库词表。内部结果采用 `场景|主要话题,补充词|表达方向`，也支持跳过。明确相反的方向或主要话题缺失时淘汰候选，补充命中和方向匹配优先，随后按已确认送达记录轮换。旧仅场景标签可显式匹配通用用途，缺少合适图时沿正常文字回复。漏标记时使用已抽中回合的用户原话与最终正文做保守双向匹配，唯一且方向清晰的低风险候选才进入原选图器。模型明确跳过或结果无效时不兜底，也无需新模型请求。

测试机可通过更新器的 `--sticker-catalog` 导入已审定的私有资料。清单旁的 `images/` 目录按 SHA-256 命名。更新器预检大小、类型和摘要，停用原 SDK 后通过原 `addFromBuffer` 写入，已有图片保留原有标签及收藏。产品预置素材与主人自有素材分别登记，均独立于程序传输；插件发行包只包含程序。

## 预置资源与重置恢复

产品审定清单保存于[deploy/stickers/catalog.json](../../deploy/stickers/catalog.json)，包含100条名称、场景、话题、方向及原图来源/摘要。图片原件独立预装在产品素材目录，实例以`expressions.stickerCatalog`登记清单的绝对路径，清单与images均位于可清空的dataDir之外。程序不在启动时联网补图或请求模型起名。源机使用`/home/node/projects/whale-nest/assets/stickers/default-v1/`，资产不放入临时诊断目录；程序发行包和素材独立管理。

[sticker-catalog.mjs](../../src/sticker-catalog.mjs)复用原导入器的类型、体积、摘要和标签验证，[default-stickers.mjs](../../src/default-stickers.mjs)在原SDK唯一store上初始化。`expressions/seed.json`的schema=2记录已导入素材SHA与原MD5，每项成功后保存；中断通过原去重恢复。旧一图初始化记录可迁移，既有素材/名称/标签/使用记录保留。普通重启只导入尚未初始化的新项，已导入后被删的图片不复活；完整重置清理用户图库与该初始化记录后，重建整套预置图库。未登记资源的历史实例沿用原初始化，部署时需显式登记产品素材。

prepare-connect、源码切换与运行包更新预检登记的资源，切换前再次核对输入未变化。清理须保留产品素材、instance.json中的资源登记，以及当前源码模式的source-candidate.json和它引用的活动程序目录；恢复原图库只由运行中的SDK写入，不另起第二个管理进程。
