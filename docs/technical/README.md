# 功能需求与技术设计索引

需求文档定义用户行为及验收条件，技术文档定义实现和数据归属，部署与启用事实统一见[STATUS](../STATUS.md)。两端共用陪伴核心，各通道通过适配入口处理平台差异。

本目录中的实现步骤、接线顺序及回归条件描述现有功能契约，不自动成为新任务。后续只按[当前开发队列](../MIGRATION.md#首版收尾的开发安排)及对应已确认范围实施；已完成能力沿现有实现维护。

## 基础能力

| 功能 | 需求 | 技术设计 |
| --- | --- | --- |
| 人格库及当前人格 | [人格管理](../requirements/persona-management.md) | [原卡片与对话入口](persona-management.md) |
| 长期记忆及自动整理 | [记忆](../requirements/long-term-memory.md) | [原SQLite、聊天读取及整理入口](long-term-memory.md) |
| 心情及表达 | [心情](../requirements/mood.md) | [原mood、概率及同音色表达](mood.md) |

## 六项功能适配设计

先读[共同投递需求](../requirements/proactive-delivery.md)和[目标与状态接线](proactive-delivery.md)：手动结果回来源，自动通知继承一份首选，业务归属共享、Session和投递回执保留来源。

| 功能 | 需求 | 技术设计 |
| --- | --- | --- |
| 主动联系 | [规则与对话操作](../requirements/active-contact.md) | [原speakup及共同计时](active-contact.md) |
| B站 | [账号、经历与操作](../requirements/bili.md) | [原读取主体与补充适配](bili.md) |
| 私人日记 | [取材、归档与发布](../requirements/diary.md) | [原compose及共同档案](diary.md) |
| 语音 | [识别、回复与音色](../requirements/voice.md) | [原voice与平台ASR/TTS](voice.md) |
| 表情 | [收录、管理及发送](../requirements/stickers.md) | [原store与两端操作](stickers.md) |
| 生图、改图 | [明确请求与作品](../requirements/image-generation.md) | [原imagegen与平台后端](image-generation.md) |

## 平台扩展与专属能力

| 范围 | 入口 |
| --- | --- |
| 平台唱歌 | [需求](../requirements/singing.md)、[单一任务与作品设计](singing.md) |
| QQ专属模块 | [上游固定能力](../AURABOT-CAPABILITIES.md)、[实现归属](../IMPLEMENTATION-INVENTORY.md)、[真实联调任务](../tasks/M4-qq-dual-platform.md) |
| QQ接入与主人关联/解除 | [管理接线及M4验收](../tasks/M4-qq-dual-platform.md#接入范围与真实验收条件) |
| 自有插件云端更新 | [已确认的聊天更新流程](../tasks/plugin-updates.md#已确认的云端聊天更新流程)、[发行与实例配置](../tasks/plugin-updates.md#发行与实例配置) |
| Liveware实时通话 | [通话与原私聊接续](../tasks/realtime-call.md)、[架构边界](../ARCHITECTURE.md#clawchat-独有实时通话扩展) |

后续开发顺序、管理入口候选及是否纳入首版统一见[首版收尾安排](../MIGRATION.md#首版收尾的开发安排)，未确认候选不修改既有功能规格。

## 实施与验证

[回复与通知的开发设计](reply-delivery.md)覆盖两端回复、后台通知及兜底。

沿[AGENTS](../../AGENTS.md)核对需求和阶段，使用[现有更新及测试方法](../DEVELOPMENT.md)。各功能复用原模块、已有原子写入、会话读取和发送回执，只补实际缺口；替换路径同步停用，避免双启生成器或定时器。

回归覆盖原函数实际被调用、状态归属、权限、目标、重启、去重及未知结果；真实平台和客户端证据分别记录。模型能力接入遵守[平台核验前提](../MIGRATION.md#已确认前提先核实平台能力)。

功能实测和待验边界见[当前状态](../STATUS.md)。
