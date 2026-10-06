# OpenCode SIWC 原生压缩

[English](README.md)

为 **OpenCode V2＋新版 Sign in with ChatGPT**（`chatgpt-token-sharing`）提供加密原生上下文压缩。使用公开 Responses API 的 `context_management`，由 OpenCode 保存和重放 checkpoint。

已在 **OpenCode 2.0.22、`gpt-6-astra-fast`、真实 SIWC 账号**上验证多轮压缩、关闭明文保留区后的续聊，以及插件重载后的重放。其它模型需要单独选择和验证。

## 安装

在 `~/.config/opencode/opencode.json(c)` 的 `plugins` 中加入以下项目，保留原有配置：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:4oOkSk/opencode-siwc-native-compact#v0.2.0",
      "options": { "models": ["gpt-6-astra-fast"] }
    }
  ]
}
```

OpenCode 会自动安装 GitHub 包。本地开发可把 `package` 改成仓库的绝对路径。

在 OpenCode 的 OpenAI 连接中选择 **Sign in with ChatGPT**。使用配置中的模型，按平常方式手动压缩或等待自动压缩即可。插件不添加登录流程、数据库、代理或工具。

`models` 是 OpenCode 界面的模型 ID，可以使用 `gpt-6-astra-fast` 这类别名；空列表或不配置时不启用。仅匹配当前 SIWC 账号、对应模型目录和官方 `api.openai.com/v1` 路由。

## 原理

OpenCode 2.0.22 的内置 SIWC 策略是文本摘要；原生路径使用的 `compaction_trigger` 会被 SIWC 拒绝。本插件把压缩请求转换为 `context_management`，阈值为服务端允许的最低值 1000，保留原始 instructions 和历史，并禁用本次请求中的工具调用。

SIWC 的完成事件可能不含 output，因此从 `response.output_item.done` 收集已完成的项目。只选择**新生成开始前**的最后一个加密 checkpoint，等待 `response.completed` 后交给 V2。调度、近期消息保留、持久化、端点绑定、重放和用量统计仍由 OpenCode 完成。

## 行为与范围

- 面向 V2，已验证版本为 2.0.22；上游接口变化可能需要更新插件。
- 不足 1000 token、没有生成前 checkpoint、流中断或失败时不接受压缩结果，原对话保留。
- 普通 Responses 请求可能在 checkpoint 后继续生成；这部分不会进入会话状态，但计入用量。
- 旧 Codex checkpoint 绑定旧端点。切换到 SIWC 时，V2 使用保存的原始历史重新续接；本插件不转换旧密文，也不恢复缺失的历史。
- 旧 Codex OAuth、API key、自定义端点保持各自原有策略；切换账号会更新匹配状态。
- 停用时移除配置项，或在 `plugins` 末尾加 `"-opencode-siwc-native-compact"`。SIWC 恢复内置摘要策略，已有 checkpoint 数据仍由 OpenCode 保存。

## 验证

仓库内执行 `npm test`，离线测试无需依赖或联网。

可选真实探针：

```sh
node scripts/probe.mjs --model gpt-6-astra-fast
```

探针通过原生 `opencode api` 使用当前账号，发送合成上下文，两轮压缩后验证随机串是否恢复。会消耗账号额度，输出只含脱敏状态和用量；凭据与密文不落盘。使用指定后台时可添加 `--server <URL>`，沿用该后台的正常认证环境。

相近项目、完整实现说明见 [英文文档](README.md#related-work)。许可证：MIT。
