# 语音与共同表达接线设计

依据[已确认需求](../requirements/voice.md)描述实现与数据归属；实际部署、启用与验收以[STATUS](../STATUS.md)为准。

## 1 实现选择与接线

[speech.mjs](../../src/speech.mjs)提供平台ASR/TTS客户端及合成回执；原[voice模块](../../vendor/aurabot/src/modules/voice/index.js)的speak现通过兼容构建注入该客户端。原[QQ Hub](../../vendor/aurabot/src/chat/hub.js)选定平台后经get_record解码，只调用同一ASR，不再走QQ转写或本地模型。ClawChat的[voice.mjs](../../src/voice.mjs)及自动表达也调用同一原voice；入站继续经[media.mjs](../../src/media.mjs)准备。

沿用原voice与Hub的收发业务，只注入当前平台识别/合成；不在云机下载本地ASR/TTS模型，不把旧桌面后端当作默认兜底。原可选后端保留，平台后端失败本轮如实回文字，不静默切换声音或服务。

## 2 改动位置与一份设置

| 位置 | 最小改动 |
| --- | --- |
| 原voice.speak及兼容构建 | 增加平台后端接缝，调用同一个speech.synthesize，返回原Hub所需文件与实际格式；稳定调用ID随执行入口传入，不靠文本或时间猜身份。 |
| 原Hub语音入站 | 保留get_record获取/解码能力，接同一个speech.transcribe；选定平台后不再同时调用QQ转写与本地模型。CC继续走现有prepareRuntimeInput。 |
| speech.mjs | 保留认证、接口、PCM封装和生成缓存；接运行时音色读取。ASR沿已有输入记录去重，QQ补相同语义的入站识别记录，避免回放重新转写。 |
| 原配置及现有管理工具 | 原aurabot/config.json的voice.platformVoice作为当前平台音色唯一可写值；兼容配置校验和保存。首次取现有实例speech.voice，不替换声音；旧值只作迁移输入，两端管理均改同一值。 |
| voice.mjs、原Hub与[expressions.mjs](../../src/expressions.mjs) | 各自获取可信Session/调用身份后，调用同一voice能力；只在平台格式和实际投递上不同。未获发送确认保留可读文字。 |

音色在请求开始时固定。改音色只影响后续新请求，既有音频与未知回执保留原音色，不能因设置变化自动重新合成。音色只接受当前后端实际支持的选择；不可用时说明，不伪报保存成功。

## 3 与表情共用原表达选择

expressions/settings.json是共同表达设置的权威来源，两端管理更新同一份设置，原Hub读取对应投影。

兼容构建从原Hub提取唯一短语音/表情选择函数，两端调用；沿用原心情倍率和标签处理，CC现有expressions保留原生回合识别、媒体回执及显示标记，移除重复概率决策。QQ仍由Hub实际发送，CC沿既有媒体发送；每轮只选择一次，发送层不再二次随机。

基础语音15%、表情35%，自动语音最多80字。手动已发媒体不再自动补发，明确文字偏好优先；关闭随机语音不阻止后续明确语音请求。此接缝同时服务[表情设计](stickers.md)，不建立通用表达计划引擎或第二套心情。

companion_voice在两端主人私聊提供status/list/update。实机模型目录没有返回音色枚举，list只列本实例已验证音色；update对新音色做一次固定短语的真实合成检查，成功后才持久化，检查属于前台TTS用量。默认仍为longanfengyue。

兼容构建从原Hub提取aurabot-expression.generated.mjs，QQ与CC均调用这一个选择函数；expressions/settings.json保持唯一表达偏好。QQ输入识别、随机选择及语音发送按原消息/回合身份保存，未知不自动换ID重试。旧版回退保留文件与回执，将当前音色投影给旧CC客户端并关闭尚无平台接缝的旧QQ voice，避免启动桌面TTS；重新升级恢复原模块。

## 4 收发、计费与回归

入站识别文本仅进入当前Session，按既有记忆规则处理，不进入日记自动素材。出站一次合成得到音频，再由QQ record/网关转码或CC媒体通道发送；格式转换不再次调用模型。QQ网关文件可达性、格式和转换能力须实查，不把云端文件路径当成QQ能读到。

保留合成请求和发送回执，未知结果不自动重合成或换ID发送。前台模型用量不占5次后台额度；本项不启用后台语音、变声或实时通话。平台权限、支持音色、费用及QQ格式在接线前核对，沿用既有语音证据但不替代QQ验收。

在speech、voice-native、media-inbound/native、expressions/native、native-qq回归中覆盖：同一后端与音色、修改后下次生效、两端各自收发、入站回放去重、失败保留文字、原倍率和手动防重复、表达设置迁移及重启。验证原voice.speak真实调用，不能仅断言新增工具返回成功。

ClawChat由Agent自测识别和合成并核对媒体回执，已有播放证据按版本保留；QQ先真实SDK与模拟网关，真实播放须授权绑定后独立验收。客户端播放与平台确认分别记录，不把前者缺失伪记完成。
