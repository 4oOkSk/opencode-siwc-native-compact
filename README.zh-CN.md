# OpenCode SIWC 原生压缩

[English](README.md)

**项目已于 2026-11-14 正式退役归档，停止维护。** 源码、标签和提交历史保留供查阅。

新部署请使用 [OpenCode 官方文档](https://opencode.ai/docs/compaction)中的上下文压缩方案。已有使用者可从 OpenCode 配置的 `plugins` 中移除此包，让压缩策略由 OpenCode 自身管理；保留会话数据库和历史记录。

<details>
<summary>已退役 v0.2.1 版本的历史文档</summary>

以下安装步骤和兼容性说明仅描述已退役版本，作为历史资料保留。

为 **OpenCode V2＋新版 Sign in with ChatGPT**（`chatgpt-token-sharing`）提供加密原生上下文压缩。使用公开 Responses API 的 `context_management`，由 OpenCode 保存和重放 checkpoint。

## 安装

在 `~/.config/opencode/opencode.json(c)` 的 `plugins` 中加入以下项目，保留原有配置：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:4oOkSk/opencode-siwc-native-compact#v0.2.1",
      "options": { "models": ["gpt-6-astra-fast"] }
    }
  ]
}
```

OpenCode 会自动安装 GitHub 包。本地开发可把 `package` 改成仓库的绝对路径。

在 OpenCode 的 OpenAI 连接中选择 **Sign in with ChatGPT**。使用配置中的模型，按平常方式手动压缩或等待自动压缩即可。插件复用该连接与 OpenCode 原生存储。

`models` 是 OpenCode 界面的模型 ID，可以使用 `gpt-6-astra-fast` 这类别名；填入模型后启用，空列表或省略时保持停用。仅匹配当前 SIWC 账号、对应模型目录和官方 `api.openai.com/v1` 路由。

## 原理

OpenCode 2.0.22 的内置 SIWC 策略是文本摘要；原生路径使用的 `compaction_trigger` 会被 SIWC 拒绝。本插件把压缩请求转换为 `context_management`，阈值为服务端允许的最低值 1000，保留原始 instructions 和历史，并禁用本次请求中的工具调用。

SIWC 的完成事件允许 output 为空，因此从 `response.output_item.done` 收集已完成的项目。只选择**新生成开始前**的最后一个加密 checkpoint，等待 `response.completed` 后交给 V2。调度、近期消息保留、持久化、端点绑定、重放和用量统计仍由 OpenCode 完成。

## 行为与范围

- 兼容基线为 **OpenCode 2.0.22、新版 SIWC 连接、`gpt-6-astra-fast`**。其它模型需要显式启用并验证；上游协议或插件接口变化可能需要更新插件。
- 阈值至少为 1000 token；成功压缩要求流正常完成并提供生成前 checkpoint。校验失败时保留原对话。
- 完成事件与已收到的 checkpoint 冲突时拒绝结果；成功完成后立即取消上游读取。
- 普通 Responses 请求可能在 checkpoint 后继续生成；这部分仅计入用量，会话状态只接受 checkpoint。
- 旧 Codex checkpoint 绑定旧端点。切换到 SIWC 时，V2 使用保存在存储中的原始历史重新续接；续接要求这些原始历史仍然可用。
- 旧 Codex OAuth、API key、自定义端点保持各自原有策略；切换账号会更新匹配状态。
- 停用时移除配置项，或在 `plugins` 末尾加 `"-opencode-siwc-native-compact"`。SIWC 恢复内置摘要策略，已有 checkpoint 数据仍由 OpenCode 保存。

## 验证

仓库内执行 `npm test`，使用自包含的离线测试套件。

可选真实探针：

```sh
node scripts/probe.mjs --model gpt-6-astra-fast
```

探针通过原生 `opencode api` 使用当前账号，发送合成上下文，两轮压缩后验证随机串是否恢复。会消耗账号额度，输出只含脱敏状态和用量；凭据与密文仅保存在内存中。使用指定后台时可添加 `--server <URL>`，沿用该后台的正常认证环境。

调整兼容基线时，另验关闭明文保留区后的续聊，以及插件重载后的 checkpoint 重放。型号、OpenCode 版本及结果保存在验收记录中。

相近项目、完整实现说明见 [英文文档](README.md#related-work)。许可证：MIT。

</details>
