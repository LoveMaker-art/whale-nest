# 大肥鱼人格资料与来源

查阅日期：2026-11-12。

2026-11-26新增[公开人格文档对比](research/whale-persona-candidates-20261126.md)，核对当日仓库关注量及固定提交的实际原文，区分较高关注项目、独立人格卡和同类故障案例。本轮仅调研，未替换当前人格。

| 资料 | 查到的内容 | 本项目处理 |
|---|---|---|
| [zexuanw958-svg/dafeiyu-config-pack 人格](https://github.com/zexuanw958-svg/dafeiyu-config-pack/blob/8c01b0361b8a4baff5be3d2bc67ed55108953086/persona/大肥鱼.md) | 该包的人格与自有配置使用 MIT；包含鲸鱼形象、嘴硬心软、短句和 QQ 场景设定 | 按用户要求完整恢复原文，显示名称为“大肥鱼”；正文和许可保存在 [原始参考目录](../vendor/persona-reference) |
| [whyever77/dafeiyu-astrbot](https://github.com/whyever77/dafeiyu-astrbot/blob/main/docs/导入指南.md) | 将人格正文作为系统提示词导入；角色表达与记忆、语音服务分开配置 | 用于确认人格与功能边界，未安装其机器人或导入私人设定 |
| [linsport/dsh-whale-persona](https://github.com/linsport/dsh-whale-persona) | 基于 DSH 预设组合角色人格，保留宿主会话设施 | 用于参考预设交付方式；本项目采用实际安装版本的原生 preset 目录机制 |

原始参考正文逐字节复制自上游提交 `8c01b0361b8a4baff5be3d2bc67ed55108953086`，SHA-256 为 `82f23bcba2e7c0879c5458fd1410b3d3e707764de5bd3c4a0283d5fecd94bc12`。来源锁记录正文和 MIT 许可的摘要，构建时将两份原件随包附上。[persona.md](../vendor/persona-reference/persona.md) · [LICENSE](../vendor/persona-reference/LICENSE)

本项目将这一原始人格作为初次默认，已有实例选择见[STATUS](STATUS.md)。后续迁移保留原文，平台、主人和可用工具说明放在独立运行上下文中。

原文保留 `{OWNER_QQ}` 占位符，以及住在主人电脑、通过 QQ 聊天、修改签名、提醒和表情包等设定。人格文本本身不提供这些能力；未启用 QQ 时不将占位符伪装为已绑定身份，实际可用功能由模块与通道决定。

这里未分发角色图片、动画、音色或第三方私人记忆。角色是社区二创方向，与 DeepSeek 官方无隶属关系。

## 鲸鱼娘人格的表达摘录

白米饭偏好可追溯到[Aurabot固定源码自带的人格卡](../vendor/aurabot/personas/dafeiyu.md)：原文将其列为“重点偏好”，明确最爱白米饭、饮食相关问题几乎都回答白米饭，并允许反复提及。“token就是饭”来自上方独立的[原始参考卡](../vendor/persona-reference/persona.md)，该参考卡没有指定白米饭。两份来源不可混称为同一原文；上游原件均保持不变。

2026-11-26用户澄清并确认当前食物设定：token是食物来源，大米饭是对它的拟人化叫法，指同一件事，不能改成两种并列食物或仅是随口玩笑。[当前人格](whale-girl-persona.md)保留嘴馋、饿了惦记和吃饱开心，改为偶尔顺着话题提起；饮食段移到性格末尾，其余身份、主人关系和人格正文保持。

[本地人格卡](whale-girl-persona.md)「我的日常语气」中的三句台词采用 `dsh-whale-persona` 原话。「我听着呢。」摘录原段落中的台词部分。人格按用户确认的表达更新，发行包初始默认仍为固定原始参考，实际使用版本见[当前状态](STATUS.md)。

| 摘录的位置 | 原文与许可 |
| --- | --- |
| 做成一件事，有点得意 | linsport 的鲸鱼娘 DSH 预设贡献者。 [原文](https://github.com/linsport/dsh-whale-persona/blob/12d6fd0133e56335ca7acc71576c9b133a74aaab/人设原文.md#L142-L145) · [许可](https://github.com/linsport/dsh-whale-persona/blob/12d6fd0133e56335ca7acc71576c9b133a74aaab/LICENSE) |
| 闲聊时顺着对方接一句、对方想说点心事 | linsport 的鲸鱼娘 DSH 预设贡献者。 [原文](https://github.com/linsport/dsh-whale-persona/blob/12d6fd0133e56335ca7acc71576c9b133a74aaab/人设原文.md#L98-L105) · [许可](https://github.com/linsport/dsh-whale-persona/blob/12d6fd0133e56335ca7acc71576c9b133a74aaab/LICENSE) |
