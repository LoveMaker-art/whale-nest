# 当前实现来源与复用边界

核对基线：2026-11-18 M4候选源码。本文回答“哪些复用原插件、哪些为本项目补充”；实际部署、开关和验收统一见[STATUS](STATUS.md)。完整固定上游能力见[Aurabot清单](AURABOT-CAPABILITIES.md)。

## 实际组合

DSH执行模型、工具及会话；原Aurabot宿主、QQ Hub及模块管理器保留，ClawChat接同一模块实例。唯一装载器配置memory、mood、bili、stickers、speakup、diary、voice、imagegen、平台song、qq-tools、qq-api、profile、contacts、qzone-social及companion-management。

模块装配、通道连接和自动行为分别控制。代码包保留完整上游，不代表所有模块已运行或已通过真实账号验收。

## 模块归属

| 功能 | 复用主体 | 本项目补充 |
| --- | --- | --- |
| 模型、工具及会话 | DSH、原平台接线 | SDK宿主桥、可信来源、Session映射及生命周期兼容 |
| 人格 | Aurabot personas.js卡片CRUD；默认正文独立来自指定dafeiyu-config-pack | 主人对话工具、默认卡导入、唯一选择、每轮正文读取 |
| 长期记忆 | 原memory、SQLite、提炼、检索及注入 | 获准DSH聊天Adapter、身份/来源过滤、共同预算、对话纠正/删除 |
| 心情 | 原createMood、关键词变化、衰减、存储和effects | 排除系统/自测输入、隐私过滤、两端表达接线及同音色标签映射 |
| 表情与表达选择 | 原stickers/store和从原Hub提取的选择函数 | 会话取材、显式管理、共同偏好、发送回执；普通图库操作不附带QQ收藏 |
| B站公开读取/浏览 | 原createBili的lookAt/watch及原run | 搜索HTTP、筛选、统一工具注册和平台投递 |
| B站账号动作 | 原评论/回复和既有登录、私信、动态等补充代码 | 本项目bili-account/http/tools接共同vault、原comment、限额和回执 |
| B站截图/资料/弹幕 | 原shots、danmaku及相应业务 | 实际会话素材与投递接缝；后端/开关按各能力核验 |
| B站消息监控 | 本项目bili-inbox/http/rules | 基线、账号分区、名单、游标、通知去重和共同节奏 |
| 经历 | 本项目activities共同档案 | 接原读取结果与history投影，保存真实来源和原编号 |
| 普通主动联系 | 原speakup tick/fire | speakup-adapter接共同计时/预算、原QQ Hub及CC Session/outbox；旧普通share触发退出 |
| 自动浏览/分享 | 原run | 共同策略调度、逐次模型预算和首选渠道单次通知；旧browse提示/独立tick退出 |
| 日记生成与档案 | 原compose负责正文 | diary及adapter负责共同档案、来源、版本、请求、查询/删除和通知；旧平行生成入口退出 |
| 日记平台发布 | QQ沿原Qzone post/remove；CC沿平台动作 | diary-publisher记录各平台预览、受众和回执，私人归档与公开发布分开 |
| 录音识别/语音 | 原voice.speak、原QQ get_record及Hub收发 | voice-adapter注入speech平台ASR/TTS；共用音色与表达，CC使用原media入口 |
| 图片理解 | 原DSH及平台模型 | 附件接线及宿主input声明修正，不实现新的视觉模型 |
| 生图/改图与作品 | 原imagegen/createImageGen、paintings和工具语义 | 平台JSON后端、会话参考图、稳定请求、下载恢复、先存盘再投递及同回合防重发 |
| 平台唱歌 | 原模块管理、权限及完成事件/记忆/心情联动 | song-client/adapter执行同一平台任务、存取和发送，复用 SongSmith 原版作品页 |
| QQ专属模块 | 原qq-tools、qq-api、profile、contacts、qzone-social | 当前SDK装配和权限兼容、QQ主人对话入口；原自动run/定时器接共同预算 |
| QQ接入与账号关联 | 原OneBot客户端、登录核号及QQ Hub | 网关管理HTTP、ClawChat登录入口、双端主人验证、受管重载及停止写入后的身份迁移/恢复；实际网关独立预置 |
| ClawChat媒体 | 原Core账号、认证、连接及上传发送 | Runtime输入Adapter、缓存/校验、受控媒体工具及Core media.3扩展 |
| 实时通话 | ClawNest Voice 原版页面、网关和平台 ASR/TTS | 复用原主人私聊 DSH 会话，标记通话历史，按实际播放保存回执，沿用普通语音音色。[架构](ARCHITECTURE.md#clawchat-独有实时通话扩展) |
| 安装与恢复 | 平台插件安装器及原会话/数据 | 构建、版本/摘要校验、原机更新、迁移及保留前向数据的回退 |

主要装配见[companion](../src/companion.mjs)，各功能代码入口见[技术索引](technical/README.md)。原文件固定不改，兼容生成由[build-aurabot-host](../scripts/build-aurabot-host.mjs)及相关构建器完成；来源、许可和基线分别见[UPSTREAM](UPSTREAM.md)。

## 单一业务与保留边界

原模块与本项目Adapter、档案、回执可以同时存在，但同一普通联系、浏览、日记、语音或图像只运行一条业务链。两端不各启一套生成器、心情或定时器；原始Session、凭据和平台回执分别保存。

purpose、本地RVC和生视频未启用；旧独立插件、原QQ聊天取材直发和独立空间日记tick不进入当前运行。各平台专属动作保留原语义，共同能力不自动授予群聊或未关联账号。

功能实测与待验边界见[当前状态](STATUS.md)。
