# 心情及表达联动技术设计

依据[已确认需求](../requirements/mood.md)描述实现与数据归属；实际部署、启用与验收以[STATUS](../STATUS.md)为准。

## 1 单一心情与可信输入

直接调用原[createMood/moodEffects](../../vendor/aurabot/src/features/companion.js)和[mood模块](../../vendor/aurabot/src/modules/mood/index.js)，保留同一mood.json、关键词算法、衰减与历史。[companion](../../src/companion.mjs)映射可信来源，排除重复、系统和运维自测；提供当前状态/语气，过滤其他Session原话和非主人原因。

切换人格或释放Session不清空心情；QQ与ClawChat不各建状态。原judge未启用，不增加额外情绪判断请求。

## 2 共用选择与平台执行

兼容构建从[原QQ Hub](../../vendor/aurabot/src/chat/hub.js)提取表达选择，两端调用同一函数；expressions/settings.json是偏好的唯一权威，QQ读取投影。[expressions](../../src/expressions.mjs)负责CC可信回合、素材及回执，不重复实现概率。

| 表达 | 接线 |
| --- | --- |
| 语音/表情 | 基础15%/35%乘原effects.voice/sticker，自动语音最多80字；主人文字偏好、手动媒体和暂停优先 |
| QQ消息间隔 | 原bubbleDelay乘effects.delay |
| QQ群参与 | 原判断读取effects.chatty；权限和群触发规则保留 |
| ClawChat回复 | Runtime确认语音送达后改显示短标记；失败保留文字，单条回复不人为分气泡 |

图库继续原stickers/store，普通操作不导入QQ收藏。真实QQ效果另按[M4](../tasks/M4-qq-dual-platform.md)验收。

## 3 同音色情绪表达

[voice-adapter](../../src/voice-adapter.mjs)在原voice.speak共用入口读取唯一mood.label，[speech](../../src/speech.mjs)仅为已验证的Flash/longanfengyue组合添加前缀：

| 原心情 | TTS表达 |
| --- | --- |
| 超开心、心情不错 | excited |
| 平平常常 | 普通输入 |
| 有点低落、不太开心 | sad |

关闭心情、其他型号/音色、未知标签或前缀导致超长时使用普通输入。音色、聊天正文及发语音概率不变，不额外合成；五档共映射三种表达。

回执以原始正文和稳定请求身份识别，生成指纹包含实际输入/表达；同ID先恢复原音频或未知状态，不因心情变化重新计费。试听及自动映射的真实触发分别核对。[心情与表达验收](../STATUS.md#功能交付)

## 4 原回复链路与恢复

DSH持久化完成回合后，[Runtime](../../src/runtime-extension.mjs)经原Bridge请求companionExpression，宿主校验输入ID、完成原因和实际最后回复。系统任务、错误回合、已发媒体或暂停不自动补发，调用方不能指定收件人或伪造朗读文本。

选择与回执保存于expressions；生成与发送复用原稳定ID，未知保留，取消可中止合成/发送。自动表达总时限45秒；短回复确认前暂存显示，长回复继续原文字流。自动TTS按当前前台媒体用量处理，不占后台整理请求额度。

[bridge-history](../../src/bridge-history.mjs)分页读取原长会话，不删除历史或提高单帧上限。相关回复、媒体、工具与升级回归覆盖E-01～E-05及去重、取消、失败恢复；平台发送回执、客户端试听和自然触发各自记录。[心情与表达验收](../STATUS.md#功能交付)
