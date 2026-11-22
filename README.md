# 鲸栖 · Whale Nest

鲸栖是基于 DSH 的云端陪伴插件。通过 ClawChat 配对后，可以和「鲸鱼娘」聊天。按需关联 QQ 后，两边都能找到同一个伙伴。她也叫「大肥鱼」。

**当前版本 `1.0.0-beta.2`** · [测试版说明](docs/releases/1.0.0-beta.2.md) · [安装与接入](docs/DEVELOPMENT.md#首次开通)

## 功能

- **相处和记忆**。用文字、图片或语音聊天，在对话里管理人格和记忆。ClawChat 和 QQ 共用获准记忆、心情和表情库。
- **浏览和分享**。搜索 B 站、读视频资料、保存浏览经历，按需开启主动联系。私人日记可查看、修订和删除。
- **语音和创作**。在聊天中收发语音、生成图片和歌曲。在 ClawChat 打开「鲸栖通话」或「鲸栖歌曲」，听语音、接着聊或回看作品。
- **双端接入**。ClawChat 为开通入口，QQ 通过宿主的 OneBot 网关连接。手动任务回发起会话，主动通知发往用户选定的位置。

## 安装和使用

测试版面向预装鲸栖的 **Linux x64 ClawChat 云实例**。取得配对码后，在 ClawChat 完成绑定。想关联 QQ 时，在该私聊中说「连接 QQ」并按提示操作。模型、语音、图像和歌曲由实例使用的 ClawChat 平台服务提供。

自维护实例及宿主兼容要求见[开发与安装](docs/DEVELOPMENT.md)。安装资产为 `.connect-plugin` 和同版本的 `distribution.json`。

## 开发

需要 Node.js 24 和 Python 3.11 或更新版。详见[本地检查](docs/DEVELOPMENT.md#本地检查与回归)。

```sh
npm ci
npm run check
npm run check:vendor
npm test
npm run build:distribution
```

| 路径 | 内容 |
| --- | --- |
| `src/` | 陪伴能力、渠道适配、数据归属和更新 |
| `integration/clawchat/` | ClawChat Connect 桥、媒体与会话扩展 |
| `deploy/`、`scripts/` | 宿主接线、构建和验证 |
| `test/` | 原生 DSH、媒体、网关和持久化回归 |
| `vendor/`、`licenses/` | 固定源码、素材及第三方许可 |
| `docs/` | 产品设计、架构、功能规格和验收 |

鲸栖自有代码采用 [MIT 许可证](LICENSE)。第三方组件的许可见[来源与许可](docs/UPSTREAM.md)。

[产品设计](docs/PRODUCT.md) · [架构](docs/ARCHITECTURE.md) · [功能验收](docs/STATUS.md)
