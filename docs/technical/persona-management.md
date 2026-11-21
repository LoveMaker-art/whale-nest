# 人格管理开发技术设计

依据[已确认需求](../requirements/persona-management.md)描述实现与数据归属；实际部署、启用与验收以[STATUS](../STATUS.md)为准。

## 1 首轮目标

主人在 ClawChat 和 QQ 的现有聊天中共用同一套人格管理，可查看、新建、编辑、删除和切换卡片。切换从下一轮生效，重启保留选择，记忆和心情继续沿用。正式自称和表达以[鲸鱼娘人格卡](../whale-girl-persona.md)为准。

## 2 直接复用及改动

| 位置 | 改动 |
| --- | --- |
| [原personas.js](../../vendor/aurabot/src/persona/personas.js) | 复用列表、读取、解析、保存、删除；不另造人格存储 |
| [persona-management.mjs](../../src/persona-management.mjs) | 封装原函数、当前选择及对话工具，避免逻辑散落 |
| [companion.mjs](../../src/companion.mjs) | 初始化默认卡，挂载工具，将固定人格正文改为读取当前选择 |
| [state.mjs](../../src/state.mjs) | 复用现有原子写入，保存当前人格ID |

新增文件通过现有分发入口打包。connect-bridge等文件仅在实际接线需要时修改，不预先扩大范围。

## 3 最小实现

1. **初始化**。当前构建包首次导入并选中[原始参考卡](../../vendor/persona-reference/persona.md)，ID 为 `dafeiyu-original`，显示名为「大肥鱼」。后续启动和升级保留已有选择和运行卡。测试机的修订稿见[当前状态](../STATUS.md#实例设置)。
2. **对话入口**：注册一个companion_persona工具，action为list/get/create/update/delete/use；身份来自可信主人会话，模型不能指定主人身份或文件路径。
3. **执行**：调用原函数并检查实际结果。切换前验证卡片存在且可读，重复创建同ID返回已存在，不自动生成另一张卡；沿用原版“当前卡不能删除”。
4. **保存选择**：卡片仍在实例Aurabot的personas目录。原宿主接回后以aurabot/config.json的persona.current为唯一当前选择；初次导入旧persona-state.json，后者仅保留旧版本回退投影。保存或切换失败返回错误，不声称成功。
5. **生效**：ClawChat的systemPrompt.section与原QQ preset的作用域aurabot_persona变量使用同一个读取方法。在每个turn首次组装时把正文固定在内存，本轮后续步骤不变，下一轮再读当前选择。QQ变量保留原模块persona过滤和提示词泄漏清洗记录；ClawChat平台说明独立注入，保留interpolate=false。

本地DSH 0.2.2-rc.1支持动态section，且提示词组装早于agent/pre-step，因此不能仅在pre-step更新变量。用实际模型请求检查生效，不通过清空会话或重复追加人格解决。

原始参考副本及其摘要始终保留，编辑只作用于运行卡。首轮默认运行卡沿用原版编辑/删除规则，不增加额外只读锁和恢复向导。当前卡失效时明确报错并保留数据，不静默改选另一角色。

## 4 必要验收

| 对应需求 | 通过条件 |
| --- | --- |
| P-01～P-04、P-13 | 默认导入正确原文，可以按原文重新创建/选用；重复启动不覆盖已有选择 |
| P-05、P-07～P-12 | 主人通过真实工具完成CRUD，操作结果与文件/选择一致；非主人不能管理，当前卡不能删 |
| P-11 | 当轮不混用正文，下一轮实际模型请求使用新卡；普通重启后选择仍在 |
| 数据约束 | 原Session、记忆、心情及原ClawChat对话/媒体功能保留 |

沿用test/sdk.test.mjs、test/connect.test.mjs及现有升级回归，按修改补针对性用例。验证成功后使用原更新入口部署；保留人格文件、选择和用户新增数据的备份。

## 5 不作为首轮前置

P-14～P-16的润色、导入导出和用户版本管理暂不做。删除此前拟定的操作补偿日志、修订冲突协议、持久回合快照及专门恢复系统。基础操作不承诺任意断电窗口的完整事务恢复；需要增强时依据实际失败补充，不把这些机制作为接入原功能的先决条件。
