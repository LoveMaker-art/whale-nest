# 共用消息目标与状态接线

依据[已确认需求](../requirements/proactive-delivery.md)描述实现与数据归属；实际部署、启用与验收以[STATUS](../STATUS.md)为准。

## 1 共同接线

[companion-policy](../../src/companion-policy.mjs)及共同档案按实例主人归属，原route只保留在Session、任务和回执中。以下接线复用现有文件：

| 位置 | 改动 |
| --- | --- |
| [routing.mjs](../../src/routing.mjs) | 一个目标选择函数：明确指定 → 手动请求来源 → 自动消息首选。只返回经宿主核实的route及选择依据，或不可用原因。平台发布不走这个私聊目标选择。 |
| [companion-policy.mjs](../../src/companion-policy.mjs) | 同一settings增加proactivePlatform，初始clawchat；保留一次QQ引导记录。继续管理共同计时、每日次数、任务和模型预算。 |
| [companion-service.mjs](../../src/companion-service.mjs) | 扩展已有companion_settings查询与修改首选；QQ、ClawChat均挂接这一工具，不另做设置入口。 |
| [companion.mjs](../../src/companion.mjs) | 复用已关联主人和原Session映射，将功能实例与当前调用route分开；同一功能只装配一次。QQ真实互动接同一计时，首次关联后只引导一次。 |
| [connect-bridge.mjs](../../src/connect-bridge.mjs)、[QQ Hub](../../vendor/aurabot/src/chat/hub.js) | 沿用各自发送路径，将真实回执反馈给同一个任务；为QQ后台回合补可信任务来源，接入现有预算门禁。 |

全局首选不改变功能开关。选择QQ须已有授权关联及可用通道；后来断线保留选择，不自动换发ClawChat。首次引导未回答保留原值，重连不再询问。本项不实现登录或账号绑定。

## 2 目标、用量与回执

创建任务时保存实际route及目标依据。长任务仍属原手动请求，不因稍后完成变成自动通知。切换首选只撤销依赖旧首选、尚未开始发送的自动投递，保留生成结果；明确目标、手动任务、发送中及未知回执不改道。

同一次操作只保留一个业务任务。QQ由原Hub发送，ClawChat由既有outbox发送；不能两者各发一次。保留稳定任务及分段回执，未知结果沿用现有held/uncertain处理，不换编号重发，也不因投递失败重新生成。

自动问候、活动分享、日记通知及B站提醒共用现有每日2次联系名额、4小时冷却及空闲条件。每日5次后台模型请求含记忆整理、生成续步和重试；本地轮询不耗模型请求，真正发通知仍占联系名额。日记保存与是否允许通知分开判断；前台明确语音、绘图等按实际平台用量处理。硬额度不由对话工具提高。

## 3 状态归属与迁移

沿用当前文件和readState/writeState。共用业务scope采用实例及已关联主人的稳定内部身份，不含IM route；原route仍保存于Session、任务和回执中。身份核验沿用现有ownersFingerprint和sharedMemoryOwnerId规则，不能用昵称、QQ数字或一个新空目录代替数据迁移。

每项功能迁移自己的旧scope及引用，先验证旧记录确属该主人，再保留原任务ID、经历ID、日期版本、删除标记、用量及未知回执。迁移可重复执行，不重复导入或清零。多份既有记录冲突时停止该项切换并列明差异，不静默覆盖或合并；未迁移项继续以原状态记为缺口。原始快照只作备份，不与新路径双写。

普通联系的contactEnabled独立于活动automatic；全局paused仍约束后台。记忆整理按原开关运行，不被关闭主动搭话连带关闭。自动浏览、日记和监控沿用各自需求及现有开关，本轮设计不将它们默认开启。

## 4 验收与实施约束

复用[原更新入口](../DEVELOPMENT.md#现有实例的直接更新)，不新增调度框架、消息总线、数据库、管理页或权限流程。原文件保持来源校验；必要改动通过[兼容构建器](../../scripts/build-aurabot-host.mjs)生成并校验产物，不能只改装配而遗漏被原模块导入的依赖。

在现有native-qq、companion-policy、companion-service-native和媒体回归中覆盖：首选与原会话的区别、首次引导、离线不改道、两端共同计数、QQ后台来源、切换取消及未知回执。再验证迁移重复执行、重启和保留新增数据的回退。ClawChat沿原对话自行实测；真实QQ登录另需用户授权，模拟回执不能作为账号实测。
