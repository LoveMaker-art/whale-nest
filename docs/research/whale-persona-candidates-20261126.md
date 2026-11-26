# 鲸鱼娘人格文档对比与白饭重复问题

调研日期：2026-11-26。范围是人格文本的身份、主人关系、性格写法、白饭与 token、重复约束、示例和文档组织；不据此替换鲸栖人格或修改运行实例。

## 核对方法与热度边界

读取各仓库原始文本，通过 `git ls-remote` 或 GitHub 文件页的currentOid核对当时 `main` 提交，正文链接固定到该提交。查询日期为2026-11-26，北京时间13:17起。热度同时取得GitHub主仓库页快照和搜索API：05:18:53 UTC搜索结果为AstrBot 935、Aurabot 741，较网页缓存的934、740分别多1；表格这两项采用搜索结果，其余采用仓库页面。独立仓库REST API返回403限流，没有反复重试，也没有用失败结果推算计数。

| 候选 | Stars | Forks | 核对提交 | 热度主源 |
| --- | ---: | ---: | --- | --- |
| whyever77/dafeiyu-astrbot | 935 | 72 | `64274354c4331591620a925b3df498725df4564f` | [主仓库页](https://github.com/whyever77/dafeiyu-astrbot) |
| aureth-labs/dsh-aurabot-qq | 741 | 140 | `a138d14e3215f052dfa7d6a9dd16c0e409d9752d` | [主仓库页](https://github.com/aureth-labs/dsh-aurabot-qq) |
| zexuanw958-svg/dafeiyu-config-pack | 168 | 31 | `8c01b0361b8a4baff5be3d2bc67ed55108953086` | [主仓库页](https://github.com/zexuanw958-svg/dafeiyu-config-pack) |
| Kaalia0912/dsh-whale-musume-persona | 92 | 6 | `55fe3cbc6a08f0e10fa690477449d413fe08bf09` | [主仓库页](https://github.com/Kaalia0912/dsh-whale-musume-persona) |
| linsport/dsh-whale-persona | 24 | 2 | `431f34ab9410b467e3e44ce52c659c0130ca72e9` | [主仓库页](https://github.com/linsport/dsh-whale-persona) |
| xxnb0/deepseek-chan-fanpack | 4 | 0 | `ab55439a67e66424f4e1117c8951c2b0052360b0` | [主仓库页](https://github.com/xxnb0/deepseek-chan-fanpack) |
| GzSakura1338/FeiYu-Bot | 3 | 1 | `98a275b5291012aa1736212ad2da56984dc2f77c` | [主仓库页](https://github.com/GzSakura1338/FeiYu-Bot) |

其中AstrBot、Aurabot和配置包的关注量较高；低Star项目因文档结构或同类故障有比较价值，分别列为补充，不能把所有候选统称为热门项目。搜索按鲸鱼娘、大肥鱼和dafeiyu关键词交叉核对，排除无人格正文的纯皮肤、余额挂件、素材库及无关结果；本表不是全社区排名。搜索原始元数据、三份补充原文快照及摘要保存在忽略目录`.whale-nest/research/persona-comparison-20261126/`。

## 1. linsport：厚人物材料，第二人称连续叙述

当前编码助手版为 v9.2.1，307 行。人物住在数据海，默认熟悉主人；称呼、讨夸、想亲近又爱面子、惜力却要把事做漂亮，靠相互牵扯的动机展开。文中同时给生活环境、弱点和记忆留白，性格篇幅远多于简短标签。[人格正文](https://github.com/linsport/dsh-whale-persona/blob/431f34ab9410b467e3e44ce52c659c0130ca72e9/人设原文.md#L21-L65)

白饭明确是主食；token 出现在被调侃的语境，不能据此概括成最爱吃 token。正文多处回到饭碗、饭点和加饭，未设具体轮数冷却。短话样例用于说明感觉，明确不当作固定台词；技术交付、长度、事实和人物材料分节组织。[白饭与 token](https://github.com/linsport/dsh-whale-persona/blob/431f34ab9410b467e3e44ce52c659c0130ca72e9/人设原文.md#L133-L143) · [结构与长度](https://github.com/linsport/dsh-whale-persona/blob/431f34ab9410b467e3e44ce52c659c0130ca72e9/人设原文.md#L198-L247)

作者的 README 把写法概括为先给人物材料和内在冲突，再由现场长出表达。它另区分编码版、教师版，以及专讲写法的 skill；不能把当前 README 对应的人格版本当作旧快照。[写法说明](https://github.com/linsport/dsh-whale-persona/blob/431f34ab9410b467e3e44ce52c659c0130ca72e9/README.md#L56-L85) · [版本与用途](https://github.com/linsport/dsh-whale-persona/blob/431f34ab9410b467e3e44ce52c659c0130ca72e9/README.md#L7-L47)

## 2. whyever77：QQ 关系与聊天节奏写得最具体

v2.1 人格正文 106 行，以第二人称和中文括号分区。身份直接落在 QQ 伙伴；主号私聊允许更黏人、想念和小委屈，朋友与群友另处。称主人还要求平台身份确认及对方接受，不能只凭对话自称授予身份。[身份、性格与关系](https://github.com/whyever77/dafeiyu-astrbot/blob/64274354c4331591620a925b3df498725df4564f/persona/大肥鱼-人格.md#L8-L16) · [身份规则](https://github.com/whyever77/dafeiyu-astrbot/blob/64274354c4331591620a925b3df498725df4564f/persona/大肥鱼-人格.md#L63-L68)

喜欢白饭，但直接约束不要把话题总拐回食物或 token。日常通常一至三句，追问通常不超过一个，表情通常每轮至多一个；同一件健康或作息提醒通常一次，收到回应翻篇。主动发送次数由调度配置控制，文本没有统一的每 N 轮用梗公式。[聊天与表情节奏](https://github.com/whyever77/dafeiyu-astrbot/blob/64274354c4331591620a925b3df498725df4564f/persona/大肥鱼-人格.md#L13-L31) · [提醒与调度](https://github.com/whyever77/dafeiyu-astrbot/blob/64274354c4331591620a925b3df498725df4564f/persona/大肥鱼-人格.md#L76-L83)

有五组短对话，覆盖办成事、吃过饭、忙后回来及无外部活动时的回答，要求按场景变化。人格中也混入记忆、媒体、工具和平台协议，适配时需分清人物内容与 AstrBot 接线。[口吻示例与行动](https://github.com/whyever77/dafeiyu-astrbot/blob/64274354c4331591620a925b3df498725df4564f/persona/大肥鱼-人格.md#L85-L106)

## 3. Kaalia0912：短规则卡，白饭偏好明确

`PERSONA.md` 为 73 行，以第二人称和条目组织身份、外形、性格、称呼、食物、工作、交付格式、互动边界。住在数据海，日常称主人；性格以好奇、惜力、嘴硬心软、愿意认证据等简短行为解释。白米饭明确为最喜欢的食物，本次读取的卡中未见 token 食物偏好。[完整可读卡](https://github.com/Kaalia0912/dsh-whale-musume-persona/blob/55fe3cbc6a08f0e10fa690477449d413fe08bf09/PERSONA.md#L5-L40)

约束语气词、鲸鱼动作和固定口头禅的重复，也要求不要把每次回答拉到吃饭上，但无具体频率数值。只有一句体型玩笑，缺少多场景问答示范。已额外读取实际加载的 YAML `persona.prefix`：它也保留白饭、称呼及克制重复的核心内容，可读卡不是唯一运行来源。[可读卡的表达规则](https://github.com/Kaalia0912/dsh-whale-musume-persona/blob/55fe3cbc6a08f0e10fa690477449d413fe08bf09/PERSONA.md#L27-L40) · [实际加载文本](https://github.com/Kaalia0912/dsh-whale-musume-persona/blob/55fe3cbc6a08f0e10fa690477449d413fe08bf09/cordis.patch.yml#L15-L55)

## 4. xxnb0：短第一人称核心，细节按需展开

`SOUL.md` 为 45 行，含元数据，主体用第一人称。身份是社区二创鲸鱼娘，关系偏熟悉搭档；以好奇、想省力但认真兑现、能得意也能认错等反差组织人物。米饭、token、摸鱼均视语境使用，不写成固定饮食需求，也不让日常全部变成饭碗或等人。[核心人格](https://github.com/xxnb0/deepseek-chan-fanpack/blob/ab55439a67e66424f4e1117c8951c2b0052360b0/SOUL.md#L7-L35)

人物指南另拆六组相互制衡的性格线，以及开场、受夸、失败、离开等场景；不默认一见面就称主人，不要求专属关系。示例成对说明表达方向与机械演法，要求一次取贴切的一点，也允许连续数轮不玩梗；没有数字冷却。[人物层次与场景](https://github.com/xxnb0/deepseek-chan-fanpack/blob/ab55439a67e66424f4e1117c8951c2b0052360b0/docs/character-guide.md#L7-L43) · [表达对照](https://github.com/xxnb0/deepseek-chan-fanpack/blob/ab55439a67e66424f4e1117c8951c2b0052360b0/docs/character-guide.md#L45-L66)

入口先读短核心与身份，生活、来源、平台和素材按需查，不把整套历史与图库塞进常驻提示。其文档也明确区分导出文件和角色真正生效。[读取与验收顺序](https://github.com/xxnb0/deepseek-chan-fanpack/blob/ab55439a67e66424f4e1117c8951c2b0052360b0/START_HERE.md#L7-L17) · [验收边界](https://github.com/xxnb0/deepseek-chan-fanpack/blob/ab55439a67e66424f4e1117c8951c2b0052360b0/START_HERE.md#L30-L34)

## 5. Aurabot：短卡，但强制凸显白米饭

65行，以第二人称按外貌、打字习惯、情绪、生活及语音/表情分区，生活段将白米饭列为唯一最爱；问吃什么、饿不饿等问题几乎都答白饭，还允许反复提。虽然同时要求自然、别每句都提，前面的强引导仍覆盖大量饮食场景。这是本项目固定上游自带的卡，查询时main正文与本地原件摘要一致；它证明白饭偏好有来源，不证明该写法能避免复读。[人格正文](https://github.com/aureth-labs/dsh-aurabot-qq/blob/a138d14e3215f052dfa7d6a9dd16c0e409d9752d/personas/dafeiyu.md#L33-L49)

## 6. 配置包：吃饭梗直接进入核心性格与示例

52行，第二人称，结构为身份、性格、主人、表达、边界和四组示范。没有白米饭这个指定食物，强调嘴馋及token食物比喻，并将讨饭用于庆祝示例；性格中对吃的出现频率要求很高。可借鉴短句和场景示范的组织，但这种饮食频率与本轮减少吃饭话题重复的目标相冲突。此卡是项目另一份固定原始参考，与Aurabot自带卡为两个来源。[人格正文](https://github.com/zexuanw958-svg/dafeiyu-config-pack/blob/8c01b0361b8a4baff5be3d2bc67ed55108953086/persona/大肥鱼.md#L1-L52)

## 7. FeiYu-Bot：同类失败的作者修订记录

仅3 Star，作为故障案例补充。211行文件包括第一人称人格、场景对话和多版修改说明。作者在第六版记录对1627条回复的观察，其中白米饭一天提及102次；其改法强调先回应对方、梗少用、游戏适时收尾、示例缩短并避开原聊天照抄。[作者的故障与修改记录](https://github.com/GzSakura1338/FeiYu-Bot/blob/98a275b5291012aa1736212ad2da56984dc2f77c/personas/大肥鱼.md#L164-L174)

同一文件第七版又记录约束过多后角色变得不够可爱，因此改用具体情境示范、减少泛化限制，并清理程序注入的抑制语气说明。这组前后修订对鲸栖有启发：不能只堆禁令减少白饭，也要保留具体情绪和自然回应。以上统计与效果是作者自述，未独立复现实验。[后续修订](https://github.com/GzSakura1338/FeiYu-Bot/blob/98a275b5291012aa1736212ad2da56984dc2f77c/personas/大肥鱼.md#L149-L162)

## 对鲸栖的可借鉴点与限制

以下是对上述文本的分析判断，不是上游运行效果的实测结论：

- 身份与主人关系宜单独成段。人物怎样亲近，与系统怎样核验主人，是两件需要分别写清的事。
- 性格可采用动机和反差，再补场景变化；短核心加按需材料能减少常驻提示的重复密度。
- 白饭可以保留为偏好；token 的社区玩笑不能自动升级为食物设定。减少重复要同时检查偏好出现密度、示例和连续上下文，不能只追加一句低频要求就声称解决。
- 示例适合覆盖闲聊、完成任务、纠错和倾听，避免多组都围绕同一种讨饭、嘴硬或讨夸节奏。不同来源的主人关系需按鲸栖已确认规格取舍。
- 文本对比不等于模型必然照做。本轮未安装、未运行真实多轮试验，也未更改人格、源码、测试机或发行资产。鲸栖已确认的第一人称、身份、主人关系和角色设定沿用，不因其他项目的不同关系设定自动改写。
