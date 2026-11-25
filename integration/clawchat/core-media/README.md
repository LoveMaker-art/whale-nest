# ClawChat Core 扩展

当前源机 22257 已部署鲸栖 `1.0.0-beta.4.dev.19`，基于官方 ClawChat Connect 集成包 `0.2.23`、固定源码 `adfec616c51f61ee6cccf8ce08dd99b80c825c50`。鲸栖构建标识为 `0.1.0-beta.9-whalenest.0.2.23.2`；程序的 `CONNECT_VERSION`、`--version` 和 Skills 清单保持官方 `0.1.0-beta.9`，自有构建标识单独保存在来源与安装记录中。版本、源码及构建摘要见[来源清单](SOURCE.json)，原始 [MIT 许可](LICENSE) 随扩展保留。

[当前扩展](core-extension.patch)保留四类必要接口：有类型的媒体发送与回执、当前账号权限读取、主人私聊共享会话，以及正文确认后的 Runtime 回调。连接协议、凭据续期、回放确认与普通消息发送沿用官方流程；鲸栖负责业务策略、人格、记忆、通话内容和表情选择。[连接器与业务接口](../../../docs/technical/clawchat-integration.md)

Core 的 `tool status` 修改已删除，精确请求回执查询集中到鲸栖只读适配，仍有官方 SQLite 字段依赖。Core 自启 Liveware 中继也已删除，改由原样官方 Exposure 托管；不再复制并覆盖其 companion 路径。鲸栖自有 Runtime Provider 通过公开 factory、`createBridge` 和 Runtime 接口消费原样官方 provider，自有 DSH Bridge 负责业务与协议适配；构建时对官方 provider/bridge 的文字替换已删除，官方 `runtime/lib.mjs` 保持原始字节。[本轮适配与验证](../../../docs/tasks/connector-convergence-023.md)

## 重建 Linux x64

在 [上游 Git 仓库](https://github.com/x-metheus/clawchat-plugin-connect)的干净检出中使用 Bun 1.4.4。把 `WHALE_CORE_SOURCE` 指向本目录的绝对路径，把 `WHALE_CORE_OUTPUT` 指向构建输出目录。

```sh
git checkout adfec616c51f61ee6cccf8ce08dd99b80c825c50
git apply "$WHALE_CORE_SOURCE/core-extension.patch"
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun scripts/generate-tool-reference.ts
bun scripts/generate-skills-manifest.ts
mkdir -p "$WHALE_CORE_OUTPUT"
NODE_ENV=production bun build ./src/bin.ts --compile --minify \
  --target=bun-linux-x64-baseline --outfile="$WHALE_CORE_OUTPUT/clawchat-connect"
cp -R skills "$WHALE_CORE_OUTPUT/skills"
cp "$WHALE_CORE_SOURCE/SOURCE.json" "$WHALE_CORE_OUTPUT/manifest.json"
```

核对程序及 Skills 摘要后，使用现有更新入口的 `--media-core --core-build <目录>`，并传入配套鲸栖运行包。Beta.3 及更早的固定补丁和来源清单仍可从[发行标签](https://github.com/LoveMaker-art/whale-nest/tree/v1.0.0-beta.3/integration/clawchat/core-media)查看。[现有实例更新](../../../docs/DEVELOPMENT.md#现有实例的直接更新)

`0.2.23` 必须同时交付已验证的完整官方 Runtime、匹配的鲸栖运行包及安装、启动文件，不能仅替换 Core。定制启动仍用于加载四类必要扩展；官方宿主文件及平台专用指令沿用原实现。源机已完成真实模型文字、图片及通话文本回执检查，官方 Exposure 的中继路径、稳定通话与托管通话及歌曲三条路由、两个可见入口均已检查；新托管入口名称为“鲸栖通话 · dsh”，原聊天卡 URL 保留。实际运行与验收边界见[当前状态](../../../docs/STATUS.md)和[本轮任务](../../../docs/tasks/connector-convergence-023.md)；此前 `0.2.22` 的切换记录保留在[历史任务](../../../docs/tasks/clawchat-022-custom-upgrade.md)。尚未发布新发行版本。
