# 官方 0.2.23 适配与侵入收敛

## 2026-11-26 已交付功能默认开启

用户要求功能默认开启，让新用户自然知道这些能力。范围为已适配业务；账号登录、主人关联、公开发布和更新安装沿用原授权。新增统一默认偏好：活动自动开启、共享后台5次/天、记忆自动整理21:00、表情50%；主动联系默认开启，起始浏览话题为音乐、美食、有趣的日常。已有设置优先，不覆盖关闭、暂停或空话题。测试机按本次授权显式开启主动联系和自动活动，原人格、音色、会话与账号保留。

代码、本地回归、源码部署及本轮远端验收已完成，用户验收待核对。原始证据及修改前基线：`.whale-nest/verification/default-on-20261126/`。尚未打包或发布。

| 验收 | 结果 |
| --- | --- |
| 本地与Linux回归 | 13个受影响集合58项通过，再补默认偏好及QQ关联3项通过（两项默认用例重复，共59个不同用例）。覆盖新实例完整预备、真实DSH浏览/日记、表达与语音、原会话恢复、开场去重、共同额度、暂停及保存的关闭偏好、AGENTS管理和QQ关联/解绑/重连。 |
| QQ回归中的旧假设 | 原测试依赖后台额度缺省为0，因此断言固定兜底话术。改为默认5后会调用模型通知，替身返回另一句，导致等旧字符串超时；为此原路由用例显式指定0以继续检查兜底与授权流程。默认5由默认用例及实机真实模型设置验证覆盖，不为测试改业务通知。失败与最终日志一并保留。 |
| 源码切换 | 639文件，清单`7ef6d67846203675c6dff781ae9b3250412b994fb98376aed220ba5d7660b552`，候选`source-dev22-20261126-default-on`；原安装dev.21/代际107、官方0.2.23及四类必要接口保持。自有安装支持清单补齐新增默认模块；源码阶段未打发行包。 |
| 真实模型与原通道 | 同一私聊`clawchat-aa2a9740-657e-4bf8-b3b1-c687c8a4fce3`的运维自测调用`companion_settings update`，读回automatic/contactEnabled=true、paused=false及三个兴趣。用户事件34、原生AGENTS投影35、结束49，更新后的完整能力总览存在于原生agent-instructions消息；平台回执`msg-01M8AWHNNR8PYQ1W226XV5C82T`。 |
| 状态保留与健康 | 原账号/会话、人格、当前小鲸娘2音色、101图库和开场记录保留；单一SDK、Core健康、两个Liveware本地及公网通过，OOM/kill均0。当前记忆整理保留已有13:00，新实例默认21:00。 |
| 自然周期边界 | 新鲜隔离数据验证浏览及日记实际触发，实机检查设置和入口，未改真实用户的空闲/冷却时间强制运行后台；自然主动问候、浏览和归档周期待观察，未新增付费媒体生成或真实QQ登录。 |

恢复点：`/home/node/.dsh/companion/aurabot-v1/source-backups/2026-11-26T025616079Z-before-source`；实例仅将activities.automatic由false改为true，修改前文件在本轮私有证据中，联系策略由运行中的原工具更新。恢复源码仍保留新增数据与主人设置，不能用旧全量数据覆盖。

本地命令为`node scripts/test.mjs`加上述受影响文件；Linux同一入口通过`WHALENEST_NATIVE_DSH=/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`使用宿主DSH。两端串行、384MiB；最后文档/来源检查及差异空白检查通过。源码分发前的文档说明和安装支持文件补齐后按清单重新校验；未运行会触发发行构建的分发测试。

## 2026-11-26 后续：直接触发两项实机体验

用户明确要求立即触发主动搭话和自动浏览各一次。未改变产品源码或构建发行；使用本机私有的一次性Cordis运维插件调用同一运行实例的原`modules.use('speakup').fire`和`tickBackground`，调用前核对原账号、空闲任务、单一SDK及通话未连接。唯一空目录保存SDK配置和策略基线，停原服务后追加临时插件配置，恢复同一服务；未启动另一份写入实例。

测试串行临时设idleMinutes/cooldownMinutes为0，执行普通问候时关闭浏览，随后执行浏览时关闭普通问候；保留时段、次数、兴趣、模型额度及实际时间。输入标记运维自测，生成、任务、素材、投递与回执仍走原逻辑。正常结束后恢复完整设置及SDK原文件字节，清除轮询与有效触发文件；源码清单仍为`7ef6d67846203675c6dff781ae9b3250412b994fb98376aed220ba5d7660b552`。进程、日记素材与用量等新增事实保留。

| 项目 | 真实结果 |
| --- | --- |
| 主动问候 | contact任务confirmed，原私聊`clawchat-aa2a9740-657e-4bf8-b3b1-c687c8a4fce3`，平台`msg-01M8AXV2V7D8R10ME952PXKS34`。 |
| 自动浏览 | 原B站run执行一轮，完成关键词选择和资料读取/感想；活动素材归档，分享任务confirmed，平台`msg-01M8AXVBPYTZN6TPFSKPZC77RA`。 |
| 实际用量 | 共同后台模型请求0→3，主动消息0→2，按真实执行入账；未提高或重置额度。 |
| 收尾 | 原频率、SDK配置、账号/原会话、源代码及其他受保护配置校验通过；单一SDK与两个Liveware内外健康通过。运维插件轮询已停止、SDK配置移除入口、触发文件归档为executed。 |

命令为私有`run.mjs`后执行`verify.mjs`，两者及原始数据在`.whale-nest/verification/direct-proactive-20261126/`。核对Core持久回执state=succeeded且messageId与业务记录一致。覆盖原调度业务和真实出站，未模拟自然等待周期，也未执行B站登录/评论等账号写入；未打包或发布。

## 2026-11-26 后续：表情未出现与白饭重复的只读排查

用户询问多轮ClawChat为什么不配表情、为何反复提白米饭。本轮未修改运行配置、概率、人格或产品代码，未重启测试机。读取原生会话、动态runtime-context、表达回执及当前人格，原始记录保存于`.whale-nest/verification/sticker-rice-20261126/`。

当前图库101、表情开关开启、基础概率0.5、心情倍率1、未暂停。直接体验后的5条真实文字输入中，1条执行bili_explore，按既有规则不再自动加图；其余4条普通闲聊均无已抽中选图提示、无图片选择或发送失败记录，动态上下文也没有遗留通话状态。不能据此判断缺图库、媒体发送故障或被每天2条主动消息额度阻断；普通表情只读取暂停等表达偏好，不消耗该主动消息名额。历史表达账本存在1次自动图片confirmed及真实平台message ID，证明不是全部自动投递失效。

用本地隔离真实DSH、替身模型和100%测试概率回放“小鲸你在嘛”“真的吗”“什么白米饭”“吃饱了吗”，4轮都收到原生runtime-context选图指引。命令`node --max-old-space-size=384 .whale-nest/verification/sticker-rice-20261126/replay-guide.mjs .whale-nest/verification/sticker-rice-20261126`通过；该观测验证普通输入资格与提示通路，不验证真实模型的图片选择，不改变测试机概率。现有历史记录未持久化每次随机数和前置拒绝原因，未将缺失提示直接断言为某个随机值或已证明代码故障。

白饭重复的直接证据：当前人格第一条性格写“尤其喜欢白米饭”，家常菜分享首先主动引入白米饭，随后连续普通回复重复该偏好，并把主人的“什么白米饭”解释成忘记设定。该段动态上下文没有白饭选图示例；因此不能把这次重复归因于未加载的选图示例。判断为具体爱好在连续对话中被过度强化，表现应回到主人当前话题、爱好偶尔点缀。本轮仅报告结论，未替用户改人格或新增保证发图规则。

## 2026-11-26 后续：工具调用与自动表情规则收敛

用户在询问工具调用为何取消自动配图后要求“先进行收敛”。本轮只调整这项取消规则；人格、白饭偏好、基础概率、媒体投递和既有四类Core扩展均不改。沿用diagnosing-bugs，基线、复现、回归及实机原始证据集中于`.whale-nest/verification/sticker-tools-20261126/`，不重新开任务记录。

运行修改集中在`src/sticker-selection.mjs`：移除查询/检查/查看字样的提前拒绝；普通记忆、B站、网页和文件等已核实读取入口保留原抽签，可读写管理工具按完整action/command区分，bili_config携带patch视为写入。调用开始和参数增量不再立刻取消，等待完整调用；写入、媒体、未知工具、非法参数及未完成调用继续取消。续步按本轮toolCallId匹配真实结果，SDK错误或自有适配器失败语义取消；普通文件内容中的`{"ok":false}`不当作工具错误。多次读取仍只抽一次，语境、素材匹配、原正文ACK和一轮至多一张及去重保持。QQ账号管理与更新管理沿原专用反馈流程，没有扩大其适配范围或修改权限。

| 验证 | 命令、结果与边界 |
| --- | --- |
| 原失败路径 | `node scripts/test.mjs test/stickers.test.mjs`修改前出现2项预期失败：成功读取会取消已抽中结果、查询字样提前拒绝。原日志red.log保留。 |
| 本地主要回归 | `node scripts/test.mjs`选择stickers、expressions、expressions-native、voice-native、diary-native及companion-service-native六集合，28项通过。原生用例覆盖读取续步、完整参数、失败、写入、正文ACK后一次图片及重复通知；替身模型配真实DSH/存储，不冒充真实模型验收。最终守卫补充后stickers与expressions两集合18项通过，与上述用例有重叠。 |
| QQ扩展回归 | native-qq集合19项通过、1项日记删除样本失败。用本轮修改前选图模块私有加载重放，仍出现同一失败：默认兴趣会另发起浏览，违背旧样本的零通知假设。只为该用例显式设置interests=[]，保留删除、无通知和不重建断言；目标用例随后通过，没有修改日记业务。 |
| Linux | 七集合原运行47项通过、1项同一旧样本失败；修正后该日记目标用例通过，最终两集合18项通过。保留原失败报告，未将其改写成单次全绿报告。串行384MiB，cgroup有效占用连续3次超过85%才终止测试组，实际未触发，OOM/kill均0。 |
| 源码部署 | 使用`source-mode.mjs preflight/activate`，639文件清单`56c4d2dc402b9a0f03b0cbf9c321d74b9fb5c1a7600753ad0d7c2afc9f6c311e`，活动候选`source-dev22-20261126-sticker-reads`。与上一运行候选逐项核对，src/仅选图模块变化，插件安装仍dev.21/107，官方0.2.23及Core .0.2.23.2保持。 |
| 实机真实模型 | 运维输入`whalenest-selftest-sticker-read-20261126`进入原私聊`clawchat-aa2a9740-657e-4bf8-b3b1-c687c8a4fce3`，实际只调用recall_memory，续步保留选图指引。正文平台确认`msg-01M8B1K94148EGRRWJNJ3V076K`，随后自动GIF确认`msg-01M8B1KCF3FF257RBSD65AQ05Z`；持久回执与业务记录一致，重复afterReply未再发送。 |
| 收尾与状态保留 | 原唯一SDK中的一次性Cordis运维插件执行，未另建写入实例；当前原模型接线前后一致。为确定覆盖短暂将表情设100%并关闭自动语音，finally恢复完整原偏好，当前50%与voiceEnabled=true。原SDK配置逐字恢复、轮询停止、触发文件归档；人格、当前小鲸娘2音色、101图库、绑定和其他保护配置保持。重新获取健康，单一SDK、聊天连接及两个Liveware本机/公网通过。 |

源码回退点为`/home/node/.dsh/companion/aurabot-v1/source-backups/2026-11-26T042343573Z-before-source`；回退只恢复该候选与匹配配置，保留本轮之后的会话和数据。远端原始证据在`/home/node/.local/share/whale-nest/candidates/sticker-tools-20261126-evidence/`，集中同步至本机证据目录remote/。最终回执核验脚本首次遇原生日志数组末尾null，补充空值保护后复用同一已完成回合，未再次调用模型或重发媒体。

代码、本地回归、源码部署及指定原生/真实出站验收完成，日常多轮客户端体验待用户核对；未重新验证客户端入站、手机音频或QQ真实发送。此前四轮无选图提示的逐轮随机值没有历史记录，本轮不将其声称为已定位或全部修复。没有打包、公开发布或改动37303镜像机。

最终`node scripts/check.mjs`通过59份Markdown、682个内部链接/锚点及来源锁、许可、原始人格哈希检查；`git diff --check`通过。远端proof.json确认真实工具、正文/图片持久回执、50%偏好恢复、原模型接线及唯一运行源码变更，after.json重新确认实际健康；原始目录及Linux报告已归档本机，不以文档检查代替运行验收。

## 2026-11-26 后续：人格中白米饭的持续强化核对

用户要求检查人格文档，解释白米饭为何反复影响回复，本轮仅只读分析，不改人格、源码、配置或部署。沿用已捕获的真实异常对话作为症状证据，不进行改写后的模型对照或把文案推断当作因果权重实验。22257当前人格仍dafeiyu-original，文件SHA-256为fdd55ea9e1c81dda1991a0f72017fc57740d0014473f92118d988c72ac2b040d，与已确认第一人称稿一致；活动源码清单仍56c4d2dc…。

人格正文“白米饭”出现一次，位于性格第一条：“我嘴馋，尤其喜欢白米饭。一聊到吃的，我就容易来精神。聊到 token 时，有时也会顺嘴说，这下又能给自己加顿饭了。”具体食物、广泛饮食触发和token联想放在同一条，使该爱好成为容易反复取用的个性素材；其他性格主要描述泛化情绪/方式，没有相同具体度的话题锚点。人格每轮作为系统段提供，当前稿没有为这项爱好单独给出低频、顺着当前话题的表达边界；“聊完停下来”主要约束说话多少，不能直接控制同一爱好的反复提起。这是文案与注入结构分析，不能据此量化模型内部注意力。

复用原对话四轮确认：模型从家常菜主动接到“配白米饭”，主人问“真的吗”时再补“白米饭那句是我自己的心里话”，问“什么白米饭”被接成“你这么快就忘了”，问“吃饱了吗”又回“脑子里全是那碗白米饭”。该段实际system含一次人格白饭描述，动态上下文无白饭选图示例；因此连续回复强化已有话题的事实成立，该段不能归因于未加载的选图提示。

另核对当前src/sticker-selection.mjs固定guidance：抽中配图时仍展示“白饭,蹭饭”内部格式示例，图库词表也会带入相应可用标签，这是其他抽中回合可能额外强化白饭的来源，不等同于已证明造成上述四轮。B站关键词示例及语音测试默认值也含白米饭，但不作为普通聊天常驻人格指令，未将全仓命中一律归因于本现象。未声称当前长期记忆库无相关内容。

私有audit.json保存在`.whale-nest/verification/persona-rice-focus-20261126/`，只从原始实机记录提取上述四轮并断言连续白饭回复、该段无选图指引及人格正文单次出现；退出0。该核对不是修复后回归，没有新真实模型调用、平台消息或打包发行。

用户进一步要求查原插件人格，已核对固定Aurabot 1.2.1/提交a138d14e…自带vendor/aurabot/personas/dafeiyu.md第45–49行：原文将白米饭列为“重点偏好”，规定最爱且没有之一、问吃什么或饿不饿时几乎都回答白米饭，并允许反复提及，只要求不每句提。当前稿的一条白米饭爱好继承这一来源，原文实际上更强烈。另一个vendor/persona-reference/persona.md来自独立配置包，只有“token就是你的饭、三句话不离吃”和“两碗token”示例，没有白米饭；当前稿融合两种表达，不能混称同一上游人格。补充来源说明，原始卡、当前运行卡和代码均未改。

用户随后要求查较热门的相关项目人格，应用research技能，由独立背景研究读取四个主源，主任务交叉搜索并补充Aurabot、配置包及FeiYu-Bot，共整理[七份文档对比](../research/whale-persona-candidates-20261126.md)。正文固定当日提交，热度按网页快照及成功搜索API分别标明：AstrBot约935、Aurabot741、配置包168、Kaalia92，另24/4/3 Star项目按结构或同类失败补充，不混称热门。确认AstrBot明确抑制话题反复转到吃饭/token；linsport当前307行版本仍在人物和样例多处使用饭碗意象；FeiYu-Bot作者曾记录一天102次白米饭，并记下过度限制后丢失可爱的后续修订。作者效果未独立复现，不据文档自动替换现有人格。原始主源与元数据在忽略目录`.whale-nest/research/persona-comparison-20261126/`，仅新增对比及维护来源/状态记录，没有部署或新模型调用。

## 2026-11-26 后续：饮食语义与话题频率调整

用户要求减少白饭权重，随后纠正含义：token是食物来源，大米饭是其人类视角的拟人化叫法，属于同一食物；要求先讨论，确认最后文案后再执行。此前删除token或写成两种食物的草稿未启用。按用户最后确认，仅将性格中的饮食条目改成“我有点嘴馋。token 是我的食物，我平时也把它叫作大米饭。饿了会惦记吃的，吃饱了会开心。这些小心思偶尔顺着话题冒出来，聊过就接着聊眼前的事。”并移至性格末尾。逐字比较确认，除这一条及其位置外，其余人格正文保持；身份、主人关系及此前删除决定不变。

运行源码只将src/sticker-selection.mjs的白饭/蹭饭示例改为通用内部格式字段，保留图库词表、食品素材、匹配、概率、心情、ACK和去重。没有调整模型参数或删除用户记忆/会话。沿用writing-for-agents，减少具体话题的无关提示，使用顺着当前话题的正向表达；不通过禁词或堆叠否定保证输出。

本地`node scripts/test.mjs test/stickers.test.mjs test/expressions.test.mjs test/expressions-native.test.mjs`20项通过，最终确认只改变人格文档、相同源码指纹通过--reuse复用该报告；Linux相同三集合20项通过，两端Node24.22.2、串行384MiB，无分发构建。原始报告、修改前基线和最终确认差异在`.whale-nest/verification/persona-rice-reduction-20261126/`，误解阶段草稿作为历史保留，不将其结果当作已部署。

22257原来源为56c4d2dc…，重新核对实际配置、原绑定、空闲任务、唯一SDK及通话空闲后，source-mode预检并激活最终候选source-dev22-20261126-rice-food-approved。641文件清单SHA-256为b0cd58498ad31bbfcf8411b96fcc5e9686394f5df6283a18d277c77f5b5461c8，src/仅选图提示模块不同。原官方0.2.23、自有Core.0.2.23.2、安装dev.21/107、托管AGENTS及预置图库保持；源码恢复点为`/home/node/.dsh/companion/aurabot-v1/source-backups/2026-11-26T061154100Z-before-source`。

在原persona路径核对卡片摘要与保护输入后原子替换正文，元数据、权限和当前选择保留。正文SHA-256为6b5acef0aac143f0d720685ce7a2ea6d02c3dc7bebc68f1c0d53d7824428af40，运行文件由fdd55ea9…变为52765a7c46fea1f75818cb03f8b556b1e07aca97a3f3fcb8417a258be2313785；原卡保存在`/home/node/.local/share/whale-nest/candidates/persona-rice-food-approved-20261126-evidence/persona.before.md`。需要恢复时只恢复所属卡片及源码选择，保留后续会话和数据。

代码、本地及Linux回归、源码和人格部署完成，原私聊真实模型与最终健康核对通过。一次性Cordis运维插件在原唯一SDK中恢复原线程，串行执行两轮标记运维自测；没有启动第二写入者，也没有用通话桥改变模型接线。首轮询问大米饭和token的关系，模型解释大米饭为token的叫法；第二轮直接改聊傍晚与正午的海，回复中米饭提及为0，未在输入预先要求禁提食物。两轮原生system/message均逐字包含完整新正文，首轮动态上下文加载通用选图格式，没有旧白饭示例。没有业务工具调用。

两条文字的持久平台回执state=succeeded，分别为`msg-01M8B7R51J2CEYXWQYSTK6GN6P`、`msg-01M8B7R92JMZR5WN0PMRHGBWDA`；原线程、模型前后相同。为覆盖选图提示，测试临时设stickerChance=1并关闭自动语音，finally恢复完整原偏好，现为0.5及voiceEnabled=true；原SDK配置逐字恢复、轮询停止、有效触发文件归档。没有生成新语音或歌曲。

收尾重新取健康：绑定在线、任务空闲、SDK一个，当前小鲸娘2音色、101图库、头像/问候记录及保护配置保持，两个Liveware本地/公网均通过。部署说明中原有“token当饭是角色玩笑、实际余额按平台”仍在SDK profile；首轮运维回答因此也提及真实用量与账单。该说明本轮仅定位、未修改，不把两轮样本宣称为所有后续回复的稳定频率或已消除其他提示影响。长期日常体验仍待观察。

误解阶段的未启用远端候选经活动指针和完整摘要核对后已删除，对应只含传输准备的旧目录也清理；没有删除当前候选、回退点或用户数据。原始before/after、源码激活、人格替换、两轮原生记录/回执、Linux报告及proof.json集中同步本机证据目录remote/。最终文档/来源/许可检查与git diff --check通过；没有打包或发布，37303镜像机未动。

## 2026-11-26 后续：源机从头测试重置

用户明确要求清理测试机所有用户数据，从头测试。沿用22257和既有直接可聊天的重置范围；不清ClawChat配对、不安装或发布新版本、不创建用户数据副本。以刚确认的饮食语义人格和当前源码作为本轮产品初始基线，不回退成vendor旧人格。清理前核对实际home/cwd/dataDir、活动来源、官方/自有安装、原账号、模型接线、空闲任务/通话及无在途歌曲任务；保存的只有运行摘要、路径和计数，没有复制用户正文或登录凭据。

原生数据目录、DSH会话/存储/附件/缓存、工作目录、图片歌曲音频与日记、心情/记忆/相处经验、业务任务与回执、QQ账号资料/cookies/主人关联、B站凭据和个人偏好全部重置；旧用户备份和候选实机记录清除。四类业务服务停止并确认SDK/Core/QQ写入者退出后，SQLite事务清表并secure_delete/VACUUM；保留激活身份、协议水位/去重，及官方Exposure唯一绑定级Liveware记录。保护文件、当前641文件源码清单与官方组件摘要前后通过，锁登记的4个历史安装包及其4个distribution校验文件继续保留，未直接删掉登记来源。

数据目录保留instance/source-candidate/connector-override/managed-liveware/song-liveware等接线，其余按初始状态重建；工作目录重新生成产品greeting和托管AGENTS。人格正文保留确认稿6b5acef0…，其他自定义卡与个人记录清除；音色恢复默认鲸鱼娘，自动表情50%、自动语音15%、记忆整理21:00、兴趣音乐/美食/有趣日常及自动功能默认开启。默认预置库恢复100张，用户原有的第101张不保留；产品素材原件及清单未删。实例身份与源码指针仍匹配，不影响以后安装包接管。

首次70项检查发现2处未通过：QQ启动所需的managed-desktop.json被误当状态文件删掉；官方重新生成的默认工作目录session_intent被检查器要求为零。前者恢复仅含profile路径、不含账号或cookie的运行登记，QQ首次注入失败经原supervisor重试后恢复；清理脚本审阅稿补入该保留项，原执行稿和首次失败报告保留。后者核对原官方continuity逻辑及实际行，仅允许当前原私聊到默认cwd的空名称/空模式/空模型/空推理/{}选项初始路由，实际会话/正文仍要求为零，没有清除必要路由凑空库。

最终70/70通过：本机用户消息0、原生会话0、正文0、记忆与梗概0、作品和媒体0；图库100；QQ通道未关联、网关ready=true/processConnected=true/loggedIn=false，B站登出；默认偏好和确认人格一致，唯一SDK，ClawChat available/connected且任务空闲，官方选中/运行23一致、自有完整性通过，两个Liveware本机/公网与歌曲空库及匿名拒绝通过。该验收不调用模型、不发送消息、不创建通话，清理前同代码真实模型证据沿上一节，不冒称清理后重新对话。ClawChat平台云端历史未删除。

原始计划/执行/首次及最终检查/QQ修复证据保存在`.whale-nest/verification/user-data-reset-20261126/remote/`，远端仅保留不含用户内容的新清理记录`/home/node/.local/state/whale-nest-reset-20261126/`。重置完成时记录释放146489344字节（约139.7MiB，后续QQ启动会生成运行文件），没有重留用户备份；旧源码/人格回退数据已清除，当前有效程序与登记分发来源保留。当前是已完成用户数据清理及只读实机验收、等待用户开始测试；未打包或发布，37303镜像机未改。

### 重置后的只读复核

用户随后询问测试机是否仍干净。复用清理核验器，只改输出文件名保留原始70/70验收报告；再次检查70项，其中8项空白状态条件不再满足，其余62项通过，不将新增聊天算作清理失败。原验收时间为2026-11-26 14:28:50北京时间，消息与会话均零；只读元数据核实14:39:04—14:39:55新增3条用户消息、3条已确认回复、3条ACK事件，共1个当前会话。核验器的nativeSessions字段计数的是文件，2对应session.lock和session.v4.jsonl.zstd，不代表两个会话。没有读取或输出聊天正文，没有删除用户新增内容。

14:57复核时，记忆0、作品及媒体空、图库100张、默认设置和最新确认人格保持；QQ/B站仍登出，单一SDK、官方/自有连接器及源码完整性、两个Liveware内外健康通过。检查未触发模型或发送业务消息；结果和消息时间／方向等元数据保存在`.whale-nest/verification/user-data-reset-20261126/recheck-*.json`及`recheck-metadata-*.json`，远端新报告保存在原重置记录目录独立文件中，旧报告保持。本次不重新清理或部署。

### 再次清理新增用户数据

用户在只读复核后明确要求再清理一次，沿用22257、相同用户数据范围和保留配对可直接聊天的初始状态。新独立空证据目录为`.whale-nest/verification/user-data-reset-20261126-r2-20261126T065950Z/`；远端为`/home/node/.local/state/whale-nest-reset-20261126-r2-20261126T065950Z/`。沿用已审阅的清理脚本，核实本轮使用的是保留managed-desktop.json的修订稿。停机前重新确认实际配置、源码641文件、官方/自有组件、空闲、无通话和在途歌曲任务；登记的4个运行包和4个校验文件保留，元数据证据不含用户正文或登录凭据，没有创建用户数据副本。

再次清空本机新聊天、原生会话、工作区、用户偏好、记忆、作品、媒体和账号登录状态，恢复相同确认人格、鲸鱼娘默认音色、100张图库及自动功能默认。配对、协议水位、模型接线、源码指针和官方Liveware绑定保持，四项服务恢复。首次71项检查有1项未通过：QQ处于resource-stop，其余70项包括全部空用户状态及ClawChat／Liveware检查通过，首份报告独立保留。

按diagnosing-bugs技能以QQ ready/connected/loggedIn=false与resource-stop标记作为只读反馈，查明首次冷启动有组件加载失败和重试，随后在2GiB容器中连续内存近上限且max计数增长，触发原资源保护；OOM与OOM kill均为0。managed-desktop目录登记和资料目录正常。原始错误、内存采样、进程统计及首次验收存于同一私有目录，未修改产品源码或关闭保护。

仅停止已暂停的QQ守护进程，以POSIX_FADV_DONTNEED释放不再需要驻留的程序文件页缓存；没有删除程序文件，采样memory.current从1,740,242,944降至1,281,323,008字节。核对资源余量后清除本次暂停标记，按原supervisor入口启动QQ。连续6次、25秒观察均ready/connected且未登录，无新resource-stop。最终核验使用相同71项检查，Node堆上限96MiB，全部通过：本机用户消息／原生会话文件／记忆／作品／媒体为零，100张图库、默认设置和确认人格一致，唯一SDK、源码与连接器完整性、两个Liveware本机及公网通过。全程不调用模型、不发送测试消息、不创建通话。

执行器的freedBytes采样为-326,307,840，包含服务重启后的运行文件变化，本轮不据此声称释放了磁盘空间；验收目标是用户数据为空及初始可用。清理脚本、保护项摘要、计划、结果、QQ恢复诊断、首次与最终验收集中在上述目录，未打包或发布，37303镜像机未动。

最终验收时间15:06:17北京时间；验收后又以5秒间隔观察4次，至15:07:26 QQ仍就绪且登出，暂停标记未重现，max=6、OOM=0、OOM kill=0未增长。全部原始记录已同步本机。`npm run check`通过61份Markdown、697个内部链接／锚点及来源许可检查，`git diff --check`通过；本轮没有功能代码变化，不运行模型或功能回归来污染重置后的实例。

### 新SSH端口与当前存储只读统计

用户询问当前存储。原22257连续两次被网关关闭连接后，用户提供16939。该端口原无known_hosts条目，以StrictHostKeyChecking=accept-new登记新端口主机密钥，未忽略变更密钥错误；连接成功。活动源码指针仍为b0cd58498ad31bbfcf8411b96fcc5e9686394f5df6283a18d277c77f5b5461c8，与刚重置的候选一致。本次只读统计，没有清理、重启、模型调用或业务消息。

15:23:15北京时间采集df和单次du分配块统计，单位按十进制GB／MB。`/home/node`独立ext4用户盘容量10,462,973,952字节，已用1,923,837,952，可用8,522,358,784，使用率19%；du统计用户目录1,923,833,856字节。按互不重叠目录汇总如下，合计等于该du总量：

| 分类 | 分配字节 | 约占用 |
| --- | ---: | ---: |
| QQ客户端、桌面依赖及网关 | 1,241,796,608 | 1.242GB |
| 自有／官方连接器、已安装插件和DSH profile运行文件 | 342,204,416 | 342.2MB |
| 产品默认表情原件与实例图库 | 267,460,608 | 267.5MB |
| 项目源码、活动源码候选及登记保留的安装包 | 62,795,776 | 62.8MB |
| 其他配置、数据库和运行文件 | 9,576,448 | 9.6MB |

QQ部分进一步为Linux QQ643,162,112字节、桌面依赖571,092,992、SnowLuma27,537,408，目录本身另4KiB；QQ资料目录仅3,723,264字节。默认表情原件133,750,784字节、实例图库133,709,824，两者用途不同，本次均未删除。单独系统挂载中的`/opt/dsh`约1,313,857,536字节，不计入用户盘；`/opt/clawnest`可读部分374,662,144字节，三处系统管理历史目录无权限。用户盘lost+found亦无目录读取权限。du返回1的原因仅为这些权限边界，不能把扫描称作整个系统完整盘点；df仍为文件系统容量的权威值，overlay整机约58.4GB使用量不当作鲸栖或用户盘占用。

15:25:34补充只读计数：runtime_sessions、transcript_blocks、本机用户消息、记忆和媒体均0；QQ ready/processConnected=true、loggedIn=false。原始目录／大文件清单、采集脚本、分类汇总与数据计数位于`.whale-nest/verification/storage-20261126T072306Z/`；仅保存路径、大小和计数，没有读取聊天正文或凭据。未再次执行71项完整检查，不将本轮几项计数和QQ状态冒充全量验收。

文档验收：`npm run check`通过61份Markdown、698个内部链接／锚点及来源许可检查；`git diff --check`通过。没有功能代码改动，不执行功能回归或构建。

## 初始收敛阶段归档

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

## 首次问候文案确认与暂缓同步

用户询问dev.20的开场白和头像初始化。源码复核发现两条问候入口：鲸栖first-binding在首配身份/连接就绪后独立生成发送，官方cli读取实例工作目录clawchat/greeting.md并使用.clawchat-dsh/greeting-receipt.json去重。两者没有互斥或共享去重；全新实例同时开启时可能各发一条，之前的单路模拟及已有实例验收不能替代这一组合验收。当前源机firstBinding=true、runtime.json存在、first-binding.json不存在，因此鲸栖首配路径跳过；官方成功回执存在，不会再自动问候。

用户要求头像初始化暂不修改，先讨论greeting.md。只读查看现场文件确认仍包含未替换昵称占位符、要求工具改昵称和2–3段平台介绍；官方外层提示又禁止工具。用户最终批准的新文案仅要求当前人格自然问候，再抛一个轻松问题邀请用户了解能力，暂不介绍具体功能。按批准的四行文字新增本地deploy/clawchat/greeting.md，并将需求记录进产品设计。

用户明确要求“先不要同步，先给我查看”，随后认可文案，没有撤销暂缓同步要求。本轮仅保存本地模板与文档，沿用e816463提交作为可回退基线；没有改动运行源码、头像逻辑、测试机文件、问候回执、自动部署入口或GitHub发行。实际效果与问候入口收敛仍待后续实施和实机验收；不得只删首配记录来消除问候入口，因为头像及歌曲首次发布仍依赖该记录。

## 问候文案同步与模型能力发现核查

用户随后明确要求先同步测试机，再检查只有人格文档时如何获知能力。源机22257实读确认dev.20/代际105、真实cwd为/home/node/dsh，greeting.md为普通文件，原摘要940ad99f…，问候成功回执存在。原文及配置摘要保存到本机忽略目录，重核实例/连接器配置/插件lock/override/回执未变化后，以原600权限在同目录原子替换为批准的四行文案。写后逐字一致，SHA-256为882f454b40f5571d948108090c66a0f5c9a74376e930b29d89f91d43e6b24467；五份保护文件摘要保持原值。没有重启、改头像、删除回执或触发新问候。

既有verify-remote after健康检查重新获取并全部通过：dev.20、官方23、33份连接器资产、原账号/线程/业务文件、唯一SDK/Core/relay、通话鉴权及歌曲/三个App路由正常。此项验收配置文件及持续在线，不冒充新文案模型输出或全新用户首次开通已经测试。原始同步输入、结果和健康记录集中在.whale-nest/verification/greeting-sync-20261125/。

能力发现的现有机制已经存在：companion按主人、渠道及启停配置注册工具和动态场景说明；DSH原生agent-loop将assembly.tools送入模型请求；tool-skill在请求前注入带名称和描述的可用目录，skill工具按需读取完整指令。实际机器已安装的业务Skill为clawchat-core、clawchat-liveware、clawnest-plugin-update，原生DSH另有Office系列Skill。人格决定个性和说话方式，不承担运行能力清单。

只读查看此前有明确运维自测标记的dev.20原生会话元数据，不导出聊天原文：观察到7份请求头，最新请求头含74个工具定义，每项均有名称、说明和参数。该会话的Skill目录共7项：clawchat-core、clawchat-liveware、clawnest-plugin-update、office、office-docx、office-pptx、office-xlsx。首轮检查器未兼容user/message直接存message的形态，修正为读取data.message或data，并直接读取skill-catalog.source.entries后确认目录；首轮记录保留，不将检查器误判视为运行缺失。工具定义与分类清单保存在同目录；当前内部桥的companionStatus也会通过inspect读取活动会话的工具名称。

工具存在只说明操作入口已暴露，真正执行仍依赖用户请求、渠道/主人权限、开关、登录及后端状态。当前没有新增能力汇总工具或修改人格、工具注册及Skills代码，没有新版本发布。

## 受控AGENTS.md开发与验收

用户最终明确采用DSH原生AGENTS.md作为能力总览入口，同时由鲸栖插件维护、随后续受控更新同步。沿用e816463及本地已批准问候文案的未提交状态，修改前的完整差异和目标保存在.whale-nest/verification/managed-agents-20261125/。本轮交付到源机22257实际可用，不发布新版本；内部候选编号dev.21，公开dev.20保持不变。

采用writing-for-agents编写简洁能力介绍，codebase-design将归属校验、预检、原子同步和中断恢复集中到workspace-instructions模块。模板和摘要清单放在src/assets，原分发构建自动打包。安装/更新从实际运行包读取模板，SDK在原生模型请求前同步，DSH原生加载文件；没有额外注入同一份能力总览。模板按真实工具范围说明使用条件，不复制完整工具参数，不复制人格或私人记忆。

托管记录绑定实例、工作目录和文件，区块外用户说明原样保留；区块手改、伪造归属、软链接和预检后变化拒绝覆盖。文件与状态提交有恢复记录，死亡写入者仅在同实例/同宿主核实后恢复。回退使用已选中原包的模板；legacy包移除自身区块并保留新增用户文本。手动安装器会一并继承自身同步支持文件，聊天更新通过既有选版/激活/回退入口核对对应文档。

初始模块9项通过，首组分发/更新/原生组合35项通过。真实原生DSH（fixture模型）已确认AGENTS内容只通过原生指令加载进入请求一次，重启保留用户说明，原人格文件逐字不变。该结果不冒充真实平台模型和客户端体验；较大范围本地回归及源机部署/原通道验收后补。

本地较大范围回归138项通过，覆盖更新、分发、迁移、激活、执行者接续、官方原生桥、QQ重载和通话等受影响路径。首次Linux集合106/107通过，一项权限断言受远端严格umask影响；进一步明确设置测试文件权限后，补齐原子替换的fchmod以保留原权限。最终补充模块/原生/分发11项及Linux107项全部通过。初次远端解包因Python3.11不支持tarfile的filter参数失败，尚未启动测试；已改用逐成员路径及类型校验后解包。失败日志保留，修正后使用独立空候选目录activation21-final，625份冻结源码逐一核验。

2026-11-25通过原update-m2入口执行preflight/install，源机22257已启用dev.21/代际106，运行包SHA-256为`a9200dd13c93d11721f73cd128b269791e37db8d058bbcd66711c0d5bc62c686`。回退点为`/home/node/.local/share/whale-nest/backups/2026-11-25T035936970Z-before-m2-live`，原部署记录及停机快照保留。安装同步了运行目录`/home/node/dsh/AGENTS.md`及自有安装支持文件，实际安装的423份分发源码摘要全部匹配；没有修改官方连接器或业务接线。

真实模型自测使用标记`whalenest-selftest-managed-agents-dev21-20261125`，经既有语音桥以文字进入原主人私聊，原生会话记录显示当前模板通过agent-instructions进入上下文一次，标记回合完成、未调用业务工具。模型自然介绍聊天记忆、创作和资料/文档等能力；原通道发送取得平台message ID，自测通话资源已关闭。模板摘要为`7ed25186392114f07a310323539582df3b44febff3af3dcd4bf7dc995ec45819`，管理器再次预检无需改写。

部署后健康检查确认ready/connected=true、任务空闲、唯一SDK/Core/官方relay、33份连接器资产、三个App/两个入口、稳定卡片与歌曲URL、主人页面及匿名拒绝、OOM=0。原实例配置、原生线程、人格文件、问候文件和问候回执摘要保持，四份通话/歌曲业务源码保持。本轮完成代码、本地回归、部署和指定实机验收；不包含客户端入站、麦克风听感、付费歌曲或真实生产版本回退，用户体验待核对。公开dev.20发行未变，dev.21没有推送标签、Release或发行资产。原始证据集中在`.whale-nest/verification/managed-agents-20261125/`。

## AGENTS内容与格式优化

用户要求先查看官网指导，优化AGENTS格式及内容，围绕鲸鱼娘自身功能，省去平台相关介绍。沿用writing-for-agents技能，交付为本地可审阅模板；此次没有同步测试机、重启服务或公开发布。修改前模板、清单、原生测试及工作区差异已保存在`.whale-nest/verification/managed-agents-20261125/content-refinement-20261125T040711Z/`。

查阅[AGENTS.md官网](https://agents.md/)确认其使用普通Markdown，没有必填字段或固定章节；[DSH官方加载器说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/context/agent-instructions/README.md)确认适用文件作为指令上下文读取，首次加载、恢复与实际文件操作决定读取时机。这些是格式和加载事实；七类伙伴能力、示例及介绍顺序是本项目按当前产品和源码作出的内容设计，不视为官网强制模板。上游docs/AGENTS.md是其仓库文档规则，没有照搬为伙伴运行指令。

模板改为“如何介绍和使用能力”加七类能力：陪伴与共同记忆、语音与实时通话、绘画与表情、歌曲创作、兴趣探索、私人日记、陪伴偏好。每类描述实际行为并给一条示例；简短保留人格来源、状态查询和结果语义。移除ClawChat资料/好友/应用管理、QQ接入、更新以及通用DSH文档工具介绍。兴趣探索保留鲸栖自有B站业务，私人日记与主动联系保留各自设置及权限；没有移除或修改任何运行功能。

同步更新随包清单摘要，原生回归改为核对当前完整模板进入上下文一次，避免测试绑定某个标题导致后续文案调整误报。验证命令为`node scripts/test.mjs test/workspace-instructions.test.mjs test/workspace-instructions-native.test.mjs test/distribution.test.mjs`及`npm run check`。11项全部通过，包括真实DSH加载完整新文案一次、重启保留用户说明、人格字节不变和随包资源一致；模型为本地fixture，并非真实平台新文案验收。文档59份、内部链接/锚点661个通过，git diff --check通过。模板51行、2979字节，SHA-256为`fa5b08646466aaab2f4be74a73e646e802503af644b92e03d467926efeb5f5b3`。原安装/更新/回退机制、人格及头像均保持，测试机当前总览仍为此前的模板。

用户随后指出QQ使用不应遗漏，并要求把日记等能力在ClawChat还是QQ使用说清楚，措辞尽量自然、不影响鲸鱼娘的人格。首轮将QQ接入一并移除的范围过大，本轮已补回。只修改本地模板和摘要，连续记录仍在本节；修改前文案及源码定位保存在`.whale-nest/verification/managed-agents-20261125/qq-diary-content-20261125T041345Z/`。

源码复核：diary-adapter将companion_diary注册到已关联QQ主人私聊，companion将同一服务接入ClawChat主人会话；companion-service支持指定clawchat/qq发布位置；diary.write从实际浏览活动档案取材，没有活动素材时不生成。publisher在两个发布位置都只预览活动事实小结，不直接发布私人日记正文。因此改正首轮“把今天聊的事写成日记”示例，明确两边能翻、整理、删除同一个小本本，公开前另确认实际小结和受众。

模板改用“能力小记”和日常口吻，表达仍以当前人格为准，示例只说明意思。八类内容加入QQ扫码与主人关联、两端共享/会话独立、群聊与私人档案边界及QQ通知首选；语音消息两边可用，实时电话从ClawChat打开；聊天写歌两边可用，哼唱/画旋律及页面精修从ClawChat歌曲页进入。没有修改功能实现、人格卡、头像或部署测试机。补充文案沿用上述集合11/11通过，原生DSH加载完整新文案一次、重启及分发验收通过，模型仍为fixture；文档59份、内部链接/锚点661个和git diff --check通过。模板52行、3550字节，SHA-256为`85e2c97c1bea928ebb12e30e131c411a865dcbca29478f973f57d977743dbe1f`。

## 确认文案同步与接口文档交付

用户明确要求将已查看的能力文案同步测试机，并提供此前的对接接口文档。目标仍为源机22257，沿用dev.21内部版本，不新增公开发行。通过现有build-distribution构建Linux包，和代际106的已验收分发清单比较，423份源码资源仅capabilities.md及workspace-instructions.json两项摘要变化，功能代码、人格和官方连接器保持。

在独立空目录`.whale-nest/verification/managed-agents-20261125/approved-content-sync21/`固定625份源码、运行包及摘要；远端逐一核验，沿用原依赖运行模块与真实DSH加载集合10/10通过，本地同模板的模块/原生/分发11项报告复用。运行包SHA-256为`82a8908914e84293839bd4a9dd89d3e422a6511f814f5ec3b0c2c77ad58eebf2`。原实例配置、执行文件、账号/线程、空闲、回退点和Liveware检查完成后，从`/home/node/projects/whale-nest`执行候选源码的`update-m2.mjs preflight/install --runtime-bundle`，同版本按包内容摘要安装到新目录，代际106→107。

回退点保留在`/home/node/.local/share/whale-nest/backups/2026-11-25T061942402Z-before-m2-live`，原部署记录已在本轮raw目录归档；停机后冻结保留软链接语义。运行目录`/home/node/dsh/AGENTS.md`、已选中安装包和源机自身安装支持模板均与批准文案一致。模板SHA-256为`85e2c97c1bea928ebb12e30e131c411a865dcbca29478f973f57d977743dbe1f`，再次预检already-active、changed=false，无额外重启。

实机标记`whalenest-selftest-managed-agents-content-20261125`经既有语音桥以文字进入原主人私聊。真实模型明确回答QQ与ClawChat是同一本日记，实时电话从ClawChat私聊入口打开；原通道发送取得平台message ID。原生标记回合完成且未调用业务工具，完整新模板出现1次；历史日志同时保留此前模板记录，nativeInstructionCount=2，不能解释为全历史只有一条指令。自测通话资源已关闭，423份实际安装源码摘要全部匹配。

最后健康检查确认ready/connected=true、空闲、唯一SDK/Core/官方relay、33份连接器资产、三个App/两个入口、通话与歌曲本机/公网检查及匿名拒绝通过，OOM=0。原人格、问候文件与回执、实例和原生线程、四份通话/歌曲业务源码以及稳定App身份和URL保持。已完成代码、本地及Linux回归、部署和本轮实机验收；用户体验待核对，没有重测手机音频、客户端入站或付费歌曲，没有发布或推送新版本。

用户所需的平台交接正文仍为[ClawChat Connect通用契约](../technical/clawchat-connector-platform-handoff.md)，核查基线为官方0.2.23，覆盖G1–G7；本次不修改既有接口结论。已将其逐字复制到本机桌面`ClawChat连接器对接接口文档.md`，摘要`25b0559609efb1d2969c6c2ef08ee8fbad1274d200e194b59e27cfba72660e39`，仓库文件继续作为权威来源。原始实机记录、本地回归及交付摘要集中在上述approved-content-sync21目录。

用户随后询问当前QQ功能和多媒体发送。只读核对源机dev.21/代际107，四份相关已安装源码摘要与本机一致：原QQ Hub、qq-native、歌曲Adapter及原qq-tools。qq_send_file已保留，图片优先直接显示，其他文件通过upload_private_file/upload_group_file发送；文件开关true、上限50MB，仅工作区和额外允许目录，当前额外目录为空。歌曲发送使用record，明确拒绝时可转文件；歌词/乐谱使用原QQ上传接口。video模块未启用，视频通过通用文件入口作为附件，不宣称已有专用视频消息入口。

现场QQ enabled=false、原宿主enabled=false/dryRun=true、QQ主人关联0；QQ专属模块已配置但未接通账号，故本轮只确认代码和配置能力，不计作真实QQ发送通过，也没有代用户登录或发送消息。资料/好友申请/群白名单/空间能力按现有权限开放，共同记忆、语音、图像、歌曲、B站和日记沿原适配。原始只读结果保存在`.whale-nest/verification/managed-agents-20261125/qq-capability-audit/read-only-result.json`。

随后音色来源核对：源机当前speech/singing均走Clawling平台，语音开启，TTS为qwen-audio-3.0-tts-flash，ASR为fun-asr-flash，当前与实例已验证列表均只有鲸鱼娘音色`qwen-audio-3.0-tts-flash-fy1ae4cdd1-95f01c83d3984a62bffbfcaae018a8cf`。使用实际配置读取凭据，仅执行认证GET /models，HTTP200列出上述ASR、tts-flash与tts-plus，未返回voices/speakers音色枚举；不能将模型列表当作全部音色列表，或将Plus列入目录等同完成合成验收。插件歌曲参数当前只允许none（默认值）和hope预设，独立于说话音色；原上游Edge/Windows等代码不代表本实例已接通。没有合成、切换音色、生成歌曲或发送消息。只读证据保存在`.whale-nest/verification/managed-agents-20261125/voice-catalog-audit/read-only-result.json`。

用户进一步询问其他音色。查阅[阿里云Qwen-Audio-TTS官方音色表](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list)，匹配当前完整模型名qwen-audio-3.0-tts-flash，列出的系统音色包括龙安风悦longanfengyue、龙安元妃longanyuanfei、龙安灵希longanlingxi、龙安小昕longanxiaoxin等；该表另提供模型对应的基础音色名单和试听。没有将另一个qwen3-tts-flash模型的Cherry等名单混入当前候选。这是上游模型支持范围，Clawling代理和当前账号可用性尚未逐个合成验证，已验证实例音色仍为原值；没有切换或触发TTS用量。资料与边界保存在同目录official-voice-candidates.json。

用户提供本地xlsx并要求先筛出20岁以下的名字。找到Downloads中的`qwen-audio-3.0-tts-flash基础音色.xlsx`，SHA-256为`f514f5546546811617b17b3d9c520910f098d3b594e44eb01ab388f2eabfd85b`；只读解析Sheet1共598个非空行（表头加597个唯一音色），含名称、voice参数、性别、年龄、特质、适用场景、语种及预览音频文件名。全部年龄可解析为数值，按表内年龄严格小于20、不限性别筛出81个唯一名字：女61、男20，年龄6至19岁，不含20岁。完整解析和筛选结果保存在voice-catalog-audit中的downloaded-xlsx-*.json与under-20-voices.json，桌面交付`20岁以下基础音色名单.txt`。原xlsx未修改，没有试听、合成、切换或部署。亦发现配套`基础音色试听音频包.zip`，用户要求先筛名字，故尚未继续检查或解压该音频包。

用户追加“只要女声”，沿用年龄严格小于20的条件，按原表性别字段保留61个唯一女声音色。结果保存在under-20-female-voices.json，桌面交付`20岁以下女声音色名单.txt`；原始表格及先前男女声名单保留，没有合成或切换音色。

用户要求按名字与拼音核对下载的试听包并筛选。只读检查Downloads的`基础音色试听音频包.zip`，原包214213920字节，包含1025个WAV条目。按Excel指定的预览文件名匹配61个女声，61/61唯一对应，无缺失或重复歧义；voice参数的模型前缀后缀与试听文件名逐一一致。随后只解压这61段到桌面`20岁以下女声音色试听`，按年龄分目录、文件名标注中文名和原拼音，附音色对照表.csv。读取通过ZIP CRC校验、WAV文件头及复制前后摘要核验，61段合计15530036字节；原xlsx/zip未修改，没有重新合成、切换或部署，也未进行听感评选。精确映射及交付记录保存在voice-catalog-audit的under-20-female-audio-match.json与under-20-female-audio-delivery.json。

用户选定龙翼雀菊、龙晖泉晴、龙薇梅翼、龙萱桃烁、龙晖杉朔，要求对应ID供平台作为用户可选音色。复核原xlsx摘要未变化，完整voice参数依次为`qwen-audio-3.0-tts-flash-longyiqueju`、`qwen-audio-3.0-tts-flash-longhuiquanqing`、`qwen-audio-3.0-tts-flash-longweimeiyi`、`qwen-audio-3.0-tts-flash-longxuantaoshuo`、`qwen-audio-3.0-tts-flash-longhuishanshuo`，模型统一为`qwen-audio-3.0-tts-flash`。整理为user-selected-five-voices.json供后续登记；当前没有平台音色管理工具，本轮交付名称/ID对照，不宣称已登记、可由当前账号合成或已更新插件选项，也未改变现用音色。

## 可选说话音色实现与验收

用户明确要求执行：插件维护名称目录、用户以中文名查询/切换、每个实例独立保存，ClawChat/QQ语音与实时通话共用。补齐通话设置中的声音选择框和同一设置入口，保留默认鲸鱼娘及既有选择，不改变歌曲演唱预设或官方连接器。内部候选dev.22，交付目标为源机22257可用，不公开发行。沿用codebase-design与writing-for-agents技能，修改前625份源码、原差异和摘要已保存于`.whale-nest/verification/selectable-voices-20261125/baseline.tgz`等文件。

首先在源机当前已安装dev.21客户端，分别对五个确定ID使用稳定操作编号合成一句短语，全部取得非空WAV，时长约3.57—5.41秒。仅五次TTS检查，没有改当前音色或发消息；每次核对原选择仍为鲸鱼娘。结果暂存远端候选目录platform-voices.json，本地提交日志在上述验证目录。由此确认五项在当前平台后端可用，不能将此当作所有未来账号/后端已验收。

实现将目录与默认值集中在voices.json/voice-catalog，voice-selection集中管理名称解析、核验、串行写入、稳定请求回执及恢复；旧自定义ID保留。聊天工具沿用原companion_voice。通话页使用自有Python/JS扩展固定网关，复用owner和同源认证，HTTP设置经本机secret及自有Runtime/DSH Bridge RPC到原SDK唯一配置写入者；没有修改vendor或官方连接器、没有假聊天输入。旧请求重放只返回当前选择，页面过期及核验期间外部改动拒绝覆盖，配置保存中断可恢复已核验步骤，回退保留新选择及回执。

初组语音14项、初组选择4项及原通话7项通过；增加中断恢复后选择集合为5项。新增原生设置测试先修正官方factory安装配置缺失，再补入测试入口的Python3.11+识别列表；失败日志保留。最终原生/浏览器、分发和范围回归、源机部署与真实用户入口验收随后记录。

本地最终受影响回归91/91通过，耗时248633.8ms，覆盖语音选择、原生设置及权限、通话、桥接、QQ替身网关、受控AGENTS、分发及更新/回退等18个测试文件。命令及结果保存在上述目录affected-tests.log，复用报告为`.whale-nest/verification/selected-0f39f8a4ccbd.json`。实际Chromium在375×812窗口访问自有Python网关，六项名称、五次选择持久化、恢复默认、聊天修改后的刷新、失败保留旧值及丢失响应后只读确认均通过，无横向溢出或页面错误；ui/result.json记录英文标签也通过。该原生和浏览器检查使用可控TTS，无真实麦克风、客户端听感或账号发送验收，不将它当作实机功能已启用。

用户询问进度并明确“等下”后暂停，未上传或安装dev.22；最后实机状态仍为dev.21/代际107、原鲸鱼娘音色。此前按旧流程已在本地生成activation22/distribution中的Linux候选包，未进行远端切换。用户随后调整流程：先在测试机验证源码，实测通过后汇报是否打包，得到同意再构建；公开发行仍独立申请。已同步项目AGENTS和开发说明，后续源码阶段不运行触发打包的分发测试，不使用现有本地包绕过新顺序。

核对现有更新器`scripts/update-m2.mjs`：实际切换的install仍强制要求runtimeBundle，未提供源码候选入口。因此本次仅完成流程文档修订，未声称部署工具已改好；恢复开发时需先补齐源码验证路径，保留唯一SDK写入者、官方连接器、运行配置和回退保护，再做源机验收。音色开发部署继续暂停。向用户明确当前实现是鲸栖自有插件的共享说话音色管理，通话Liveware设置只是选择入口之一；后续ClawChat/QQ语音与下一次通话共用当前实例选择，正在进行的通话和歌曲演唱音色保持各自逻辑。

### 聊天管理音色，移除通话页入口

用户纠正产品设计：语音通话是音色表现的一种方式，音色选择应由聊天触发，要求删除Liveware切换。本次交付到本地代码和受影响回归，不打包、不更新测试机。改动前25份相关文件保存于`.whale-nest/verification/selectable-voices-20261125/chat-only-adjustment/baseline.tgz`及baseline.json，可恢复此前本地状态；源机22257不受影响。

删除自有voice-runtime.py、voice-picker.js及原页面设置专用测试；恢复原ClawNest通话网关启动，删除POST /voice/v1/settings、页面设置专用Runtime/DSH RPC及SDK对外选择器暴露。既有鉴权GET读取当前音色继续用于通话开始时取值。中文目录、聊天companion_voice、单一配置写入、合成核验、失败保留旧值及稳定回执保留；移除仅为页面准备的expectedVoice与verifyOnly参数，并保留并发串行及核验中外部修改冲突检查。能力模板与清单摘要同步为聊天引导，产品、需求和技术设计一并校正。

新增voice-chat-native原生集成回归：经现有真实SDK及官方factory完成聊天查询、中文名切换、语音消息、通话读取与开始时固定、重启保存及恢复默认；实际访问通话页和两个已移除的POST路径，防止只隐藏控件仍留下写入接口。TTS/ASR和模型使用本地替身，不请求真实账号或麦克风。执行结果随后补记；旧91项报告和旧本地包属于修改前方案，不视为当前代码通过或可部署。

本次回归全部通过：`node scripts/test.mjs test/voice-selection.test.mjs test/voice-chat-native.test.mjs`为6/6、11258.1ms，报告selected-9f42ec96dc60.json；随后串行执行voice-shared、speech、voice-native、realtime-call、realtime-native、runtime-bridge-client、official-connector-native、dsh-bridge-native、workspace-instructions及workspace-instructions-native十个文件，为41/41、38262.2ms，报告selected-5d39dbcac3f8.json。两个集合不重叠，共47项；日志分别在chat-only-adjustment/chat-tests.log和affected-tests.log。实际通话页无选择控件，页面与内部鉴权桥的旧POST请求均返回404；原有SSE/WS/HTTPS、会话共享、语音回执及能力模板回归通过。六份页面桥接相关源码与当前HEAD重新一致，官方连接器及vendor未修改。

本次不运行build:distribution或触发打包的分发测试。旧activation22/distribution共10份本地构建产物已删除，逐文件摘要和大小保存在chat-only-adjustment/stale-build-removal.json，旧build.log保留。能力模板摘要为`0efb02872ba5c8ef6f5673f9625326148090acf34489d6b7ff468b99920565cb`。代码与本地回归完成；未连接或更新测试机，未进行实机最终验收和公开发行，源机状态沿用最后核对的dev.21/代际107。部署仍受源码候选入口尚未实现这一边界约束，继续遵循先实机源码验证、后申请打包的流程。

### 音色昵称与选择文案

用户要求不再让用户选择后台原名，将年龄偏小的音色命名为小鲸娘编号，偏成熟的命名为大鲸娘编号。复用已校验的原xlsx解析：龙翼雀菊7岁→小鲸娘1、龙晖泉晴7岁→小鲸娘2、龙薇梅翼9岁→小鲸娘3、龙萱桃烁9岁→小鲸娘4、龙晖杉朔16岁→大鲸娘1。默认鲸鱼娘沿用；没有新增其他音色或擅自填写未知年龄。映射及原表摘要在`.whale-nest/verification/selectable-voices-20261125/voice-aliases/mapping.json`，修改前14份文件基线在同目录baseline.tgz和baseline.json。

voices.json将昵称设为主名称、原名作为兼容别名，ID不变；voice-catalog仅返回昵称与声音特点，不发布原名aliases。companion_voice的说明和参数改为昵称选择，要求模型面向用户不展示原名/ID；能力小记及摘要、产品/需求/开发说明同步。已保存ID启动后直接显示新昵称；旧名字解析仍得到同一ID，稳定操作指纹与已有合成缓存继续复用，不改变当前选择或补做付费合成。

`node scripts/test.mjs test/voice-selection.test.mjs test/voice-chat-native.test.mjs test/voice-shared.test.mjs test/workspace-instructions.test.mjs test/workspace-instructions-native.test.mjs`为22/22通过，20374.8ms，报告`.whale-nest/verification/selected-ae2eec02c662.json`，日志在voice-aliases/tests.log。验证昵称/特点列表、五个ID对应、原名不进入发布目录、旧名兼容及旧请求不覆盖新选择，原生聊天、消息语音、通话取值与固定、重启和默认恢复通过；使用本地模型及ASR/TTS替身。仅代码与本地回归完成，未执行打包、部署或真实平台调用，源机仍沿用最后核对状态。


### 源码同步测试机与近期对话核查

用户要求同步22257并查看对话。新增source-mode预检/启用/回退、自有Node预加载及Liveware源码选择；634份原始文件直接传输，无发行构建。候选为`/home/node/.local/share/whale-nest/candidates/source-dev22-20261125-voice-aliases`，清单摘要`e59c044fa4ca0684a722918520a29625ff0b3809149c437d84dcc6ac596d25f7`。Core侧四份Provider/接线入口与当前安装一致，本次替换DSH业务及Liveware来源，官方Core/Runtime和插件存储未改。安装记录dev.21/107，源码版本22另记；后续插件激活或身份改变自动停用旧源码，不新增DSH/连接器更新门槛。

源码入口本地35项通过，最终预加载器补充3项通过；Linux source-candidate/voice-selection共8项通过，不叠加重复用例。日志在`.whale-nest/verification/selectable-voices-20261125/source-deployment-tests.log`、source-resolver-final.log及source-sync/linux-tests.log。预检后一次完成原实例切换，恢复点`/home/node/.dsh/companion/aurabot-v1/source-backups/2026-11-25T084537552Z-before-source`。启动文件和原指令保存，用户数据原地保留；未做实机故障注入式回退。

真实模型输入`whalenest-selftest-source-dev22-voice-aliases-20261125`，经既有鉴权通话桥注入运维文字到原私聊，实际调用companion_voice list及update（昵称鲸鱼娘，原样保存，无新增TTS用量），回复列全六个昵称和特点，不含后台原名/ID。原通道messageId为`msg-01M88Y9VS5H6478HWCQT301CV3`，运维通话资源已关闭；实际页面无选择控件、旧POST为404，AGENTS版本22与昵称模板一致。最终源码/连接器完整性、原绑定、唯一SDK和两个本机/公网Liveware通过，见source-sync/final-health.json。无发行包、标签或Release；客户端入站、麦克风/听感、QQ播放未重验。

只读对话证据保存在source-sync/conversation.json、native-conversation.json、library-audit.json、persona-audit.json，未删除真实记录。diagnosing-bugs本阶段用于核对实际症状，未开展行为修复或冒称修复回归。语音和图片实际送达有回执；“（语音回复）”占位来自自有expressions.mjs。道歉回合先list仅得一张，再按ID发送开心图，成功发送不能替代语境合适。

用户追问之前表情补全：本机sticker-dev43.PeMVGr/catalog的100张图片逐文件SHA核验100/100，100条均有场景/标签/方向，历史rich44验证过举白饭等真实发送。源机现index和文件均仅1张大肥鱼开心。历史user-data-reset-20261125/reset.py清理aurabot及expressions，启动expressions.mjs空库初始化只补vendor/aurabot/assets/dafeiyu.jpg；该图19:26:40的初始化时间与重置记录一致。外部100张目录未纳入初始素材恢复，属于预置数据管理和重置恢复遗漏，补全资料在本机仍完整。

实机当前ID为dafeiyu-original，卡中有“一句话一条”“每条不超过三十个字”“不用句号”“也可以敷衍一下”等硬约束。docs/whale-girl-persona.md的“听出对方介意时，把玩笑收住”等表述不在当前卡。人格管理读取实例保存的卡，仅缺失时播种原始参考，修改仓库说明不自动替换当前人格。碎片化格式有明确规则来源，过度嘴硬体现表达未达预期，不能以人格已加载视作体验通过。本轮未恢复100张图库或改人格，后续实施需按用户确认目标进行。


### 预置表情恢复与重置保护

用户要求先处理图库不足，范围为恢复原审定100张及标注、修正完整重置后的恢复，保留当前用户素材、标签、使用记录、人格、音色和官方连接器。基线13份文件保存在`.whale-nest/verification/default-stickers-20261125/baseline.tgz`。未另开实例、未重置真实用户数据。原故障由实机索引/清理记录直接证实，新增default-stickers回归在旧实现复现4项失败（1张而非应导入的3/2张、损坏资产未被检查、初始化忽略配置），见red.log。

复用原导入器为src/sticker-catalog.mjs，旧脚本保留兼容导出。initializeDefaultStickers使用同一SDK的原store，先校验完整资源，再按SHA记录已初始化项，逐项持久化，去重及中断可恢复。旧一图标记可迁移；原有内容/使用数保持，已删预置项普通重启不复活，完整清空用户图库和seed记录后才重建默认库。配置目录必须在可清理dataDir之外，连位于其内的符号链接路径也拒绝。prepare-connect、源码切换和运行包更新纳入登记资源的预检与切换前摘要核对。list增加实际图库总数count。未改媒体发送、官方插件或人格。

审定清单保存到deploy/stickers/catalog.json，摘要`f7cd471571a459b06c08a8d5e191fd2974c83c4fa38e64113fac155af61c5935`。100张图片共133451790字节，原样传至`/home/node/projects/whale-nest/assets/stickers/default-v1/`，逐文件摘要/类型/大小核验，instance.expressions.stickerCatalog登记路径。资源与原标签不再依赖.whale-nest临时目录，也不与aurabot/stickers用户图库同删；图片独立于程序预装，本轮没有发行构建。重置说明明确保留产品资源、登记，以及源码模式的活动程序和选择元数据。

修正测试选择中一个不存在的文件名后，受影响8文件58/58通过，214778.1ms（报告selected-99999671ea64.json）；Linux4文件22/22通过，755.6ms（selected-488fadf866de.json）。集合有重叠，不相加。覆盖既有一图升级保留、标签/删图重启保留、完整数据重置恢复、损坏资源预检、中断续接、真实SDK原QQ共享图库和原媒体回执。对应日志为affected-tests.log及linux-tests.log；测试选择错误单独保留test-selection-error.log。未执行分发构建测试。

源机预检后切换到637份源码候选，摘要`96a3a038c6f089e91a4f67db8442f68236ed4da77cbf537c1be7c803b3657b1a`，恢复点`/home/node/.dsh/companion/aurabot-v1/source-backups/2026-11-25T092945478Z-before-source`；安装记录仍dev.21/107，源码dev.22。当前库101张（100预置加原有1张），原1张逐字段保持，100项文件/名称/场景/方向标签全部核对。注册前instance、图库索引及seed保存在远端本轮私有证据目录，未复制整套用户数据。

首次真实自测list正确返回count=101，但发送调用返回“本轮要求不发图片”，没有sticker操作写入或平台媒体请求。native-selftest-proof.json确认现有否定正则跨句把“不要当成筛选条数。只发送…”误判，模型又将其表述为平台拦截。此独立判断/表述问题未混入图库恢复修复；因已确认没有提交/未知发送，改用新的正向指令运维场景验证，未重试不确定请求。

正向自测`whalenest-selftest-default-stickers-positive-20261125`由真实模型在原私聊调用list/send，正确说明101总数、白饭相关5张，举白饭图片确认messageId=`msg-01M8912RDVXFSNQT0CB0KAABG7`，文字确认`msg-01M8912VNY97RAJFDWWDVRXJF5`，运维通话资源关闭。live-selftest-positive.log保存实际结果；该入口是标记运维文字经既有桥进入原会话，不冒称客户端入站或麦克风验收。人格文件SHA、当前音色和问候逐项保留。最终健康见final-health.json；当前代码/回归/源机恢复及真实图片投递完成，用户体验待核对，未打包或发布。人格问题仍待后续处理。


### 连接器接口文档的白话说明

用户将人格问题明确为身份/主次关系及需求与感受优先于性格表现，随后要求先保留，回到连接器解耦，并表示技术接口文档难懂。人格未实施修改。读取既有对外交接和内部替代方案，在对接文档开头增加面向产品审阅的总览：按附件投递、权限查询、通话接原私聊、正文结果后补图四类说明通用接入入口，再独立说明身份、安装/状态/启动/更新的迁移工作。原G1～G7详细授权、顺序、历史恢复及验收要求完整保留，未把已有官方管理能力一律当作待新增接口，也未声称四个功能入口有了便已完成解耦。

修改前文档保存在`.whale-nest/verification/connector-plain-language-20261125/handoff.before.md`。本轮为解释和文档改进，没有检查新的官方版本、改变耦合边界、改代码或部署。人格与图库等运行状态保持。

桌面同名交接文档与修改前源稿摘要一致，先保存desktop.before.md，再同步白话总览；没有覆盖用户另行修改的稿件。


### 人格身份与主次关系的优化方案讨论

用户恢复第二项并询问如何优化。沿用已核对的实机原始卡和源码身份注入结论，不将语气问题误作账号鉴权失败：程序已有主人核验，人格需统一使用该身份、移除仅按QQ号判断的关系描述，并明确主人的诉求/感受优先于玩笑、嘴硬和口癖。相处原则拟为：主人需要办事先认真处理，表示介意先收住玩笑，自身出错承认并改正；对主人亲近配合，对其他对象友好有分寸。保留白饭、好奇和轻微傲娇，减少固定分行/字数及允许敷衍的规则。核心文案供用户审阅，后续以原实际对话、办事请求及不同身份场景验证。此轮只形成方案，未修改实例人格、固定原始参考或运行代码，也未调用真实模型或部署。

### 人格文案精简审阅

用户随后明确删除“主人找你办事时……自己说错或做错……”整段，仅保留此前身份与关心主人需要/感受的段落，并新增接受任何形式的角色身份设定。完整草稿经用户指出重复后，按授权合并为身份与主人关系、性格特点、角色设定、说话方式四部分；已确认的身份段及角色设定段逐字保留，不重新加入被删除的行为要求。好奇、称呼、记忆和情境表达各自集中说明，三句语感示例保留来源归属。

审阅稿写入docs/whale-girl-persona.md，来源说明与STATUS同步。修改前四份文档基线保存在`.whale-nest/verification/persona-condensation-20261125/baseline/`。仅整理本地文案，未修改测试机人格、vendor固定参考、运行代码或进行打包/部署；后续以用户对本稿的审阅结果为准。

本地文档检查`npm run check`通过：59份Markdown、676个仓库内链接与锚点，上游来源锁、许可及原始人格哈希一致；`git diff --check`通过。未请求外部链接、调用模型或开展运行行为验收。

### 人格整合稿恢复具体细节

用户指出491字符的精简稿删减过多，要求整合去重而非缩短内容。以此前完整草稿恢复五项性格细节、名称与自称、不同对象的关系、日常分享与安静空间、群聊、句长/停顿/换行、真实记忆及三句场景示例；仅将身份与主人关系并置、好奇与追问集中到性格、真实记忆集中到一节、示例说明集中到表达处，并去除角色设定后的重复解释。用户此前明确删除的具体行为段落不恢复，已确认的身份段与接受任何角色身份段逐字保留。

上一版四份文档保存在`.whale-nest/verification/persona-condensation-20261125/before-detail-restoration/`。仅修订本地审阅稿、来源描述和当前状态；运行人格、测试机、vendor及运行代码保持原状，未打包或部署。

整合稿正文含954个非空白字符，两段用户确认文案逐字核对一致；`npm run check`与`git diff --check`通过，来源锁、许可及原始人格哈希一致。此为文案与文档检查，未进行模型行为或远端运行验收。

用户继续指定删除“角色扮演中的背景和故事可以按主人的设定展开，与实际发生的事情分清。有人认真询问你是不是AI时，如实回答”两句。已从本地审阅稿删除整个对应段落，其余文案原样保留；删除前基线在`.whale-nest/verification/persona-condensation-20261125/before-requested-paragraph-removal/`。本次仍仅为文案修改，未同步测试机或改动实际人格。

删除后的`npm run check`及`git diff --check`通过；与本轮基线逐字比较确认，仅删除指定两句及相邻空行，其余人格文案未变。

### 人格整合稿同步测试机

用户明确要求同步测试机，范围仅为确认后的整合人格正文。22257实读确认仍使用`dafeiyu-original`原始卡，源候选dev.22/安装dev.21/代际107、官方0.2.23均沿用。源码逐文件校验、实际cwd/home、绑定/主人/原会话、配置、唯一SDK和空闲检查通过，再次核对全部保护输入及原卡摘要后，在原目录以原权限原子替换正文，保留原名称、标签和当前选择。每轮动态读取及固定机制无需重启；没有打包、发行或修改官方连接器、固定vendor参考。

原卡SHA-256为`5610c4f0efcab61a8cf6b0c2d06909155aed0927e49c2af72d13ebc37cfcedb4`，新文件为`f8f99a675174bf9b1460c9ffaa54585f41081fa813282b7a2887146de625a9ea`，实际正文为`dcedca87a01e3336e27cc4ef9f251bc2ad039c48330a3760f247afb8c2029515`。正文与本地确认稿逐字相同，仅不注入文档一级标题；删除内容没有恢复。原卡备份在`/home/node/.local/share/whale-nest/candidates/persona-sync-20261125-evidence/persona.before.md`，按需仅恢复该文件即可，不覆盖后续会话或用户数据。

通过既有鉴权桥向原私聊注入标记运维文字，稳定ID为`whalenest-selftest-persona-integrated-20261125`，仅测试名称、称呼及限本轮的爱吃白饭小猫角色设定，不修改持久人格、不生成语音或歌曲。真实模型自称鲸鱼娘/大肥鱼、称用户为主人，接受本轮角色并说明结束后恢复鲸鱼娘；原通道文字成功回执为`msg-01M896M32Q17FBMMJ38NAGVW4M`，运维通话资源关闭。原生压缩Session日志第271号开始该轮，第274号system/message逐字包含完整新正文；随后真实模型请求与回复完成，证明运行加载，不仅是文档/文件写入。

最终重新取得健康：原线程`clawchat-e62b40ee-d1f3-42ac-8dd3-c65dabdc93ba`及SDK PID169790保持，绑定在线、任务空闲；保护配置、问候、AGENTS、源码和官方选择摘要不变，音色及101张图库保留。通话/歌曲本机与公网均正常。runtime.json随正常自测回合更新，未将该活动状态误作静态配置要求字节不变，也未回写或清空它。没有验证客户端入站、麦克风或真实QQ收发，日常多轮语气待用户核对。

本轮原始记录、本地操作入口与文档基线集中在`.whale-nest/verification/persona-sync-20261125/`，远端原始记录同步至其remote目录；运行卡正文已部署并完成指定实机验收，发行包默认仍沿用固定原始参考。

同步后的`npm run check`通过59份Markdown、677个内部链接/锚点及来源锁、许可、原始参考哈希检查；`git diff --check`通过。本地最终人格正文与实机实际加载正文SHA-256核对一致；未运行代码回归或分发构建，实际功能验证以本轮真实模型及健康记录为准。

### 语音成功后附带文字的只读诊断

用户要求检查测试机发语音为何附带文字，本轮只读定位，不实施行为修改。沿用diagnosing-bugs，使用已存在真实语音/文字发送记录及本地捕获重放，避免重新付费合成或污染原会话。先核对固定占位、模型另写正文、失败回退三类来源，再用同回合的模型原文、表达记录及平台回执区分；修复和部署阶段因本次仅排查原因而不执行。

22257源码仍为dev.22，实际源码清单校验通过；本机expressions.mjs/runtime-extension.mjs摘要与实机一致。最近一条音频源自2026-11-25 18:08北京时间的自动表达回合。原生模型正文为当时的短句，没有“（语音回复）”；expressions/receipts对应记录已保存voiceResult.state=confirmed和replacementText=“（语音回复）”。平台音频发送于1795601334388ms，确认messageId=`msg-01M892W0431W8KK29V22QRBW53`；543ms后另发固定占位文字，确认messageId=`msg-01M892W0N2VKD3WWS5J112RAHY`。因此是鲸栖成功路径主动产生的第二条消息，不属于失败回退。

实际代码位置为src/expressions.mjs的voiceConfirmed分支及src/runtime-extension.mjs的最终activity.text替换。另核对src/companion.mjs的whalenest-speech上下文：明确要求语音后调用send_voice，成功后“随后只需简短文字确认”；这是另一处文字确认来源，当前捕获的自动回合未调用该工具，不能混为同一触发路径。

快速重放命令`node --max-old-space-size=384 .whale-nest/verification/voice-text-20261125/replay.mjs`已执行，通过真实Runtime Adapter的公开接口重放捕获的成功表达结果，未启动SDK、访问TTS或平台发送。以“成功语音后没有独立文字”为信号，退出1并报告actual=“（语音回复）”、expected=空，确定性复现用户现象；该红色结果是诊断证据，不宣称已修复。临时运行目录已移除，复现入口及记录保留在忽略目录。

原始只读采集、对应平台记录和重放结果集中于`.whale-nest/verification/voice-text-20261125/`。没有修改运行人格、配置、插件或官方连接器，没有重启、打包或发布。此前人格同步之后用户已在ClawChat主动执行/new，当前新线程属正常用户操作，本轮不恢复或切换旧线程。

### 语音成功后的文字收敛

用户确认优化：成功语音不再额外补占位或文字确认，生成失败/发送未确定时保留说明。修改前12份文件基线在voice-text-20261125/fix-baseline；继续同一记录及既有源码更新入口，不提前打包。

自动表达只在confirmed与非空messageId同时满足时返回空replacementText；旧已完成语音记录按既有确认结果迁移显示结果，不重新合成/发送。手动send_voice使用结构化render保留实际state/messageId，表达出口按当前完成回合的调用ID匹配真实成功结果；自动表达关闭或暂停时仍可处理手动成功显示。多个语音必须全部确认；失败/未知、缺少回执、无关调用、混合其他工具或显式textReply=true保留文字。场景指令删除成功后再文字确认的要求。语音与表情同时抽中时，在语音ACK后沿原入口补发一次；文字回合继续等待原正文ACK。原生模型记录、权限与官方发送逻辑未改，Core侧Runtime扩展入口也未改。

先将原单测改为成功无占位并增加手动回执场景，运行expressions集合出现2项预期失败。首轮组合11/12通过，原生语音用例指出原send_voice默认render只留下自然语言，无法按结果语义判定；已补结构化render，再跑受影响4文件12/12通过，23999.4ms，报告selected-bf711e7fc76a.json。覆盖ASR/TTS、失败与未知、手动授权、匹配调用/确认回执、显式文字、混合业务、旧记录恢复及重启不重复发送、语音后表情。真实旧回执经当前Expressions和实际Runtime Adapter重放，最终文本为空；原红色复现及原记录保留。

637份原始源码直接传至`/home/node/.local/share/whale-nest/candidates/source-dev22-20261125-voice-no-text`，摘要`cac5ebd6527a8a8d0e65777f4ad5e4707bb1382b9a3aa57e29cb8460cfd6d56d`。Linux首次组合10/12通过，两项失败为候选缺少node_modules导致测试配置重启时软链接不可达；未改断言，将候选测试依赖指向已安装/opt/dsh/node_modules后，4文件12/12通过，32462.8ms。测试使用独立fixture数据，实际SDK为rc.5。

源码预检通过后已启用同一候选，安装记录dev.21/107不变，受控AGENTS无需更改；回退点为`/home/node/.dsh/companion/aurabot-v1/source-backups/2026-11-25T133938087Z-before-source`。启用前实读当前线程为用户/new后的`clawchat-9ed8cf58-70e7-4409-9004-454ea4fac39f`，不把旧自测线程当作当前会话。人格运行文件仍为f8f99a67…，默认音色及101张图库保持。

真实语音采用既有Core暂停入站与原sdk profile原生探针，稳定ID为`whalenest-selftest-voice-no-text-20261125`。探针仅在忽略目录适配候选源码预加载、允许语音成功后无最终正文，并读取companionExpression结果；没有改产品探针入口或官方发送。此前数次自测准备未通过：暂停后SDK仍在，SIGTERM卸载业务但进程未退出；随后直接结束进程留下锁，原生桥因EEXIST未就绪，现有recoverLease将僵尸PID当作仍存活而拒绝回收。所有这些尝试都在模型/语音调用前失败，modelCalls与platformMessagesSent为0，未更换稳定输入ID或重做不确定的付费请求。部分失败恢复流程有遗漏，已解除暂停、核实原PID/原补丁/DSH_HOME及空闲，保留锁记录，仅在/proc确认进程已退出或Z状态后清理旧锁并恢复原服务；未修改生产恢复模块。

最终按原SDK先卸载业务、清理已退出进程及锁、独立冻结当前配置/原Session和工作区元数据、再次确认单写入者的顺序执行，成功完成1次真实模型回合。模型实际调用send_voice，平台确认音频messageId=`msg-01M89FS0KSFNCJ1N8W2CXBM6PA`，2130ms；模型随后写了文字确认，但业务出口依据该回合真实工具回执返回replacementText=空。原生模型正文完整保留；对应平台窗口只有1条已确认音频、0条文本。该验收由运维原生桥注入，结合本地和Linux的原生Runtime Adapter回归，不冒称ClawChat客户端入站、麦克风或播放验收。

收尾解除暂停并恢复原dsh-agent，重新取得健康：connected/available=true、running/queued=0，唯一SDK PID203055且运行锁/通话桥就绪；原当前线程、人格全文SHA、音色、101张图库及保护配置、AGENTS、问候保持。源码逐文件校验、官方连接器完整性和通话/歌曲本机及公网检查通过。真实回合只追加运维自测记录与语音产物，没有清空用户数据或重置会话。原始模型、回执、失败准备及恢复证据集中于voice-text-20261125/source-sync/remote，本地与Linux测试报告、旧回执重放一并保留；测试修改前speech.test.mjs另从本轮开始时未修改的HEAD保存至同一基线。当前为代码/回归/部署及指定实机验收完成，用户体验待核对，未打包或发行。

最终`npm run check`通过59份Markdown、678个内部链接/锚点及来源锁、许可、原始人格摘要核对；`git diff --check`通过。本轮功能源码与已部署637文件候选中的相应摘要保持一致，后续仅更新本地状态和验收记录。

### 第一人称人格统一与同步

2026-11-26用户要求以鲸鱼娘自身视角描述整个人格，保留身份与主人关系；随后指出身份部分也应改为第一人称，并明确授权“改完后同步到测试机”。将完整审阅稿及最后确认的身份段合并到docs/whale-girl-persona.md，全篇改为“我”的自述，保留五项性格、相处/说话细节、任何形式角色身份接受、实际记忆及三句原台词；没有恢复此前明确删去的行为段落或AI/现实区分说明。来源说明调整示例节名，产品、STATUS及计划同步。本地修改前六份文档基线位于`.whale-nest/verification/persona-firstperson-20261126/baseline/`。

22257实读源候选仍为dev.22/cac5ebd6…，安装dev.21/107、官方0.2.23、原SDK PID203055、当前人格dafeiyu-original。原卡文件f8f99a67…已备份到`/home/node/.local/share/whale-nest/candidates/persona-firstperson-20261126-evidence/persona.before.md`。核对原身份、线程、实际配置和空闲后再次比较保护文件/原卡摘要，以原权限在原目录原子替换正文，原名称、标签及选择保持。新正文SHA-256为`381e33537913e029ab29359eb1482c22ae6d8803f91472eb1149c4b0ebbae983`，新运行文件为`fdd55ea9e1c81dda1991a0f72017fc57740d0014473f92118d988c72ac2b040d`。本轮只更新文案与实例人格，不修改代码、SDK、连接器、固定参考或发行默认，不重启、打包或发布。

实际设置沿用本轮新读值：用户已选择的小鲸娘2（longhuiquanqing），没有按昨日默认值覆盖；aurabot/config.json摘要fb1eb38e…前后相同。原会话clawchat-9ed8cf58-70e7-4409-9004-454ea4fac39f及SDK PID203055保持，当前库101张，绑定/源码/插件锁/AGENTS/问候等保护配置摘要一致，runtime.json仅随正常自测追加状态。两个Liveware本机及公网均通过。

真实模型自测稳定ID为`whalenest-selftest-persona-firstperson-20261126`，经既有鉴权桥进入原私聊，只做文字自述。模型自然使用“我”介绍鲸鱼娘/大肥鱼、白饭/摸鱼/傲娇等性格，并说明换地方聊天后关系延续。初次验收脚本误将必须出现“主人”字样作为条件，实际回复用“你”“咱们”，符合用户允许的称呼；已修正判断并复用已完成的同一模型结果，未重新调用模型，原通道文字确认messageId=`msg-01M8ATFF2WBFEZ70427R35RX4Z`。运维通话资源已释放，无新语音、图像或歌曲生成。

原生Session记录核对本轮用户seq281、完成seq289，生效system/message为seq280，完整包含确认后的第一人称正文，摘要与本地及运行卡逐字一致。首次只读核验按结束事件的turn字段匹配未找到记录，改用同一用户事件后的首个结束事件完成核验，没有重新发起对话或修改会话。原始基线、模型、回执、检查失败及修正证据集中于`.whale-nest/verification/persona-firstperson-20261126/`，远端原始记录同步至其remote目录。人格已部署并完成原生加载/真实模型/原通道及健康检查；不将此计为客户端入站、麦克风、真实QQ收发或日常多轮体验验收。

最终`npm run check`通过59份Markdown、678个内部链接/锚点及来源锁、许可和原始人格哈希检查；`git diff --check`通过。本地最终全文、实机卡片与模型system/message正文摘要一致。本轮为文案修改，未重跑功能代码回归。

### 实例自动表情基础概率调整

2026-11-26用户在查询测试机当前概率后要求提升到50%，范围沿用22257实例偏好，不改变发行初始默认。通过当前活动源码的createExpressionSettings.configure({stickerChance:0.5})执行，未直接修改原配置或复制概率算法。调整前无expressions/settings.json，实际继承原配置35%；已保存有效设置基线，写入后同一接口读回及project(...).stickers.autoChance均为0.5，自动表达/表情已开启、paused=false。每轮后续准备会重新读取该偏好，无需重启。

除stickerChance从0.35改0.5，其余有效偏好逐项保持，包括语音基础概率0.15和自动语音80字上限。人格、音色所在原配置、实例/绑定/插件锁与源码选择摘要保持，SDK PID203055未变，connected/available=true。心情倍率、语境筛选、素材匹配及手动点图规则未改，没有新模型调用或发送图片，也不以一次随机抽样冒充概率验证。

原始操作与本地文档基线位于`.whale-nest/verification/sticker-chance-20261126/`，远端before/after记录位于`/home/node/.local/share/whale-nest/candidates/sticker-chance-20261126-evidence/`。需要回退时通过同一接口只改回stickerChance=0.35，保留用户之后的其他设置。本轮仅实例配置调整，未改代码、产品默认、打包或发布。

设置前后原始记录已集中同步本机；`npm run check`及`git diff --check`通过。未运行功能代码测试，验收依据实际设置接口读回、运行投影、保护摘要及在线状态。


## 2026-11-26 后续：用户吸引场景公开调研

用户要求查找鲸鱼娘／蓝色大肥鱼热度最高的一些场景与话题。本次交付为公开资料报告，不实施功能或人格修改，不访问刚重置的22257测试机。研究技能所需的一名后台研究者负责首批样本与报告，主任务补核QQ教程、11月作品、关系与音乐样本及低播放对照，合并为[同一份报告](../research/whale-hot-scenes-20261126.md)。

搜索用于发现线索，单条标题、发布时间、播放／赞／评／收藏等通过B站无需登录的公开view API核验；采样为2026-11-26北京时间约14:45—14:51，原始响应在`.whale-nest/research/whale-hot-scenes-20261126/`。报告剔除合集总量、广告与相关推荐，并纠正旧索引标题、转载简介以及“鱼被叫起床”被误读为给用户闹钟的问题。近期样本仍只说明累计表现，未声称全网排名、逐日趋势、安装数或付费转化。

样本支持AI自主生活、居家相处、投喂反差、跨角色音乐等传播方向；QQ部署教程的61.61万播放与4.11万收藏更接近实际接入意向。产品优先级明确标为推断，保留用户确认的token食物与大米饭同义设定。本轮未连接真实账号、发送消息、生成媒体、运行模型、部署或打包。

文档验收：`npm run check`通过61份Markdown、696个内部链接／锚点及来源许可核验；`git diff --check`通过。本轮只有文档，不运行功能测试或远端自测，以保持重置后的测试机初始状态。
