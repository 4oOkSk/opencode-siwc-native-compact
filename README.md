# OpenCode SIWC Native Compact

[简体中文](README.zh-CN.md)

Native encrypted context compaction for **OpenCode V2** with the new **Sign in with ChatGPT** connection (`chatgpt-token-sharing`). Uses the public Responses API's `context_management` and OpenCode's own checkpoint persistence and replay.

Tested with **OpenCode 2.0.22** and **`gpt-6-astra-fast`** using a real SIWC account: repeated compaction, continuation with no retained plaintext, and replay after plugin reload. Other models must be opted into and verified separately.

## Install

Add this entry to `plugins` in `~/.config/opencode/opencode.json(c)`, preserving your existing entries:

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

OpenCode installs GitHub packages automatically. For a local checkout, replace `package` with its absolute directory.

Connect **OpenAI → Sign in with ChatGPT** in OpenCode. Select a configured model and use OpenCode's normal automatic or manual compaction. No separate login, API key, database, proxy, or tool is added by this plugin.

`models` contains **OpenCode model IDs**, including aliases such as `gpt-6-astra-fast`. Omitted or empty `models` makes the plugin inactive. It matches only the active SIWC connection, its account-specific model catalog, the OpenAI provider package, and `https://api.openai.com/v1`.

## How it works

OpenCode 2.0.22 forces SIWC models to text summaries. Its native path appends `compaction_trigger`, which the SIWC endpoint currently rejects with `subscription_sharing_unsupported_capability`.

This plugin:

1. Enables OpenCode's native compaction policy for selected SIWC models.
2. Replaces the trigger with `context_management: [{ type: "compaction", compact_threshold: 1000 }]` on compaction requests only. Original instructions and history are preserved; tool calls are disabled for that request.
3. Collects completed output items from SSE events. SIWC can leave `response.completed.output` empty.
4. Selects the last **leading** encrypted checkpoint, before any new generation. Checkpoints emitted after newly generated text or reasoning are excluded.
5. Waits for successful `response.completed`, then adapts the result to the single-checkpoint response OpenCode expects.

OpenCode owns scheduling, retained recent messages, storage, endpoint/model provenance, replay, and usage accounting. The plugin keeps only the active connection identity in memory; OpenCode owns credential refresh.

## Behavior and compatibility

- **V2 only.** Tested against 2.0.22; upstream protocol and hook changes can require an update.
- **1000-token minimum.** The endpoint rejects lower thresholds. If no pre-generation checkpoint is produced, compaction fails and the original conversation stays available.
- **Completed responses only.** Truncated, failed, incomplete, changed, or missing checkpoints are rejected.
- **Extra generation.** A normal Responses request may generate output after the checkpoint. That output is discarded from session state, but still contributes to reported usage.
- **Existing conversations.** OpenCode binds native checkpoints to their provider/model/endpoint. When switching from the old Codex endpoint, V2 re-expands incompatible checkpoints from stored original history. This plugin does not convert old ciphertext or recover missing history.
- **Other login methods.** Old Codex OAuth, API keys, and custom endpoints keep their existing compaction policy. Switching accounts updates the selected policy.
- **Disable.** Remove the package entry, or append `"-opencode-siwc-native-compact"` to `plugins`. SIWC then uses OpenCode's built-in summary policy; existing checkpoint data remains in OpenCode.

## Verify

From a checkout, run the offline suite (no dependencies or network requests):

```sh
npm test
```

An optional live probe uses the active account through the native `opencode api` CLI:

```sh
node scripts/probe.mjs --model gpt-6-astra-fast
# For an explicitly configured server, inherit its normal authentication environment:
node scripts/probe.mjs --model gpt-6-astra-fast --server http://127.0.0.1:4096
```

The live probe sends synthetic context, performs two compaction/replay rounds, and verifies a random token using the encrypted checkpoint. It consumes account quota. Credentials and checkpoint contents remain in memory; results contain status and usage only.

The offline tests cover login/model scoping, account switching, cleanup, alias-to-wire-model mapping, SSE item collection, pre-generation checkpoint selection, terminal failures, and cancellation.

## Related work

- [OpenAI compaction guide](https://developers.openai.com/api/docs/guides/compaction)
- [OpenCode V2 plugin API](https://opencode.ai/v2/docs/build/plugins)
- [OpenCode V2 compaction](https://opencode.ai/v2/docs/compaction)
- [partment/opencode-openai-compact](https://github.com/partment/opencode-openai-compact): a `compaction_trigger` approach; its README records OpenCode 1.18.23 testing.
- [josevelaz/opencode-codex-native-compaction](https://github.com/josevelaz/opencode-codex-native-compaction): a V2-beta plugin for the old Codex subscription backend.

These are related projects, not dependencies. This implementation targets the new SIWC public endpoint and reuses V2's native checkpoint storage.

## License

MIT.
