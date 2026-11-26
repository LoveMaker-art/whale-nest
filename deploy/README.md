# 测试机启动脚本

部署、更新和回退按[开发说明](../docs/DEVELOPMENT.md)执行，实际运行状态见[STATUS](../docs/STATUS.md)。

| 脚本 | 用途 |
| --- | --- |
| [serve-media.mjs](serve-media.mjs) | 启动 Connect Core 与 Liveware 中继 |
| [serve-qq-gateway.py](serve-qq-gateway.py) | 启动和监管 QQ 网关 |
| [qq_login_window.py](qq_login_window.py)、[qq_gateway_memory.py](qq_gateway_memory.py) | QQ 网关使用的登录窗口及内存保护 |

首次问候要求由[运行模板](../src/assets/greeting.md)管理，[已确认文案](clawchat/greeting.md)保留便于查看。鲸栖在准备、Core启动前和人格变更时，把当前完整人格与问候要求写入实例工作目录的`greeting.md`。官方Runtime负责唯一一次生成与发送；已有问候回执保留，鲸栖不补发独立欢迎语，自定义文件冲突时保留原件。[当前状态](../docs/STATUS.md)。
