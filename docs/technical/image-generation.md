# 生图与改图开发设计

依据[已确认需求](../requirements/image-generation.md)描述实现与数据归属；实际部署、启用与验收以[STATUS](../STATUS.md)为准。

## 1 复用选择与接口差异

复用原[imagegen模块](../../vendor/aurabot/src/modules/imagegen/index.js)、[createImageGen](../../vendor/aurabot/src/features/imagegen.js)、参考图解析及[paintings作品管理](../../vendor/aurabot/src/features/paintings.js)。QQ工具与CC适配工具调用同一个绘图执行函数，生成器和作品库不按IM复制。

2026-11-15的[平台核验前提](../MIGRATION.md#已确认前提先核实平台能力)表明：参考图编辑使用JSON image数组，和生图共用/images/generations，结果采用URL。原兼容分支则用/images/edits及multipart，并默认请求b64_json；custom分支的字符串参数也不等于所需数组。**不能只填模型名称和Key就启用原分支。** 本文引用历史合同，不将其作为当前权限、余额或成功生成证明。

## 2 接入顺序与最小改动

1. 先复核平台能力、当前实例认证、参数格式、计价、可用额度和限制；向用户说明缺失条件及最小真实调用用量。依赖未确认条件的接线和真实生成保持待办，不擅自换服务。
2. 在原createImageGen增加选定平台后端接缝，最多新增一个HTTP适配文件。复用现有受信任provider的基址与凭据读取方式，不复制Key，不走个人订阅或本地模型。
3. 原参考图解析继续使用当前会话last/quote或获准作品；QQ与CC分别提供实际图片字节。模型不能用任意路径、网址或另一端原始私聊图片冒充参考图。
4. 在原工具执行链中改为“取得生成结果 → 持久保存作品 → 平台投递”。原先先发QQ、成功才savePainting的顺序不足以恢复发送失败，必须调整；两端调用同一修改后的链路。
5. 通过[兼容构建器](../../scripts/build-aurabot-host.mjs)生成上述必要产物，保持vendor校验；[companion.mjs](../../src/companion.mjs)装配唯一imagegen实例及工具。列表、读取沿原listPaintings/paintingPath，不另建作品数据库。

首轮请求固定n=1。尺寸、参考图、返回格式均按复核后的实际合同校验；不请求未经支持的蒙版、透明背景等能力。后端返回URL时先下载并校验保存，下载不携带模型凭据；不把临时URL当永久作品。

## 3 一次生成、一份作品与恢复

沿用现有readState/writeState和媒体目录中的请求记录，保存稳定工具调用身份、参数指纹、生成状态、作品标识及发送回执。提交前写入请求记录，结果未知不自动重提；不依赖未经核实的服务端幂等承诺。无需另建队列或补偿框架。

保存沿用原paintings目录及文件管理；为同秒同提示的文件名补稳定请求后缀，避免覆盖。保留旧作品名及引用，文件和请求记录可在重启后恢复；保存失败如实反馈并保留已取得结果，不重新付费生成。下载失败有有效结果地址时仅恢复下载，发送失败仅复用已有作品。

手动结果固定发起会话，不因全局首选改变目标。QQ保留原Hub媒体发送，CC复用[media-delivery](../../src/media-delivery.mjs)；两端主人能按同一作品标识查询。共同作品与每个会话的临时“刚才那张”引用分开，不能把别处的最近私聊图片当成本轮输入。

原看自己画作的能力按现有视觉支持及开关保留，不新增额外看图模型调用。收为表情仍需明确要求；生图成功不自动加表情、发动态、替换头像或开启后台创作。前台费用按实际图像服务处理，不占5次后台模型额度。

## 4 回归与真实验收

在现有native-qq、媒体和原模块测试入口增加受影响路径，只有缺少对应入口时才加小型imagegen专项测试。通过同一个绘图入口验证原生成逻辑实际调用、参考图隔离、单张限制、保存早于发送、同秒不覆盖、重启、未知请求不重提、发送失败不重画及两端共用作品。

平台条件和用量确认后，真实验收最小为一张文字生图、一张用户提供参考图的修改，分别核对内容、持久文件与ClawChat发送回执。QQ真实投递在账号授权后单独补验；模型成功、保存成功、平台确认和客户端可见分别记录。当前未验证的计价、额度或服务权限不能用模拟测试补成已通过。

## 5 实际接线

[build-aurabot-image](../../scripts/build-aurabot-image.mjs)校验固定来源后生成原createImageGen、原绘图工具与原savePainting的必要兼容产物。只提取savePainting，继续使用vendor中的唯一列表及临时作品映射；不会复制整个paintings模块形成第二份编号状态。

[image-client](../../src/image-client.mjs)是唯一平台HTTP后端；[platform-provider](../../src/platform-provider.mjs)与语音共用原配对认证读取。[image-adapter](../../src/image-adapter.mjs)把原工具接到两端素材及发送入口，登记当前可信用户回合的稳定标识。同回合更换工具调用ID仍复用原请求，不能反复计费；当前参考图需来自本Session已接收、30分钟内且完整性相符的唯一图片，或主人共同作品。

CC名称draw_image、QQ名称qq_draw_image，均调用原绘图执行体；companion_paintings提供list/read/send/status/recover。recover只恢复已知结果的下载和原目录保存；发送作品须明确使用send，未知投递先查原回执，不生成替代图片。结果及状态分别保存在既有media/image-requests、image-operations和媒体receipts；作品仍在aurabot/imagegen。

原更新入口增加--images，保留模型、音色、记忆、额度及平台开关；回退m3.17或更早时关闭旧imagegen写入，保留新增作品和不确定记录。真实验收按单独确认的有界用量执行；历史计数见任务归档，不将测试次数硬编码为产品终身额度。
