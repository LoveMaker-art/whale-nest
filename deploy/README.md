# 测试机启动脚本

部署、更新和回退按[开发说明](../docs/DEVELOPMENT.md)执行，实际运行状态见[STATUS](../docs/STATUS.md)。

| 脚本 | 用途 |
| --- | --- |
| [serve-media.mjs](serve-media.mjs) | 启动 Connect Core 与 Liveware 中继 |
| [serve-qq-gateway.py](serve-qq-gateway.py) | 启动和监管 QQ 网关 |
| [qq_login_window.py](qq_login_window.py)、[qq_gateway_memory.py](qq_gateway_memory.py) | QQ 网关使用的登录窗口及内存保护 |
