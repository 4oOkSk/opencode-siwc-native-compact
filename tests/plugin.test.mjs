import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import plugin from "../index.mjs";
import { checkpoint, completedResponse, probe } from "../scripts/probe.mjs";
import { checkpointResponse } from "../protocol.mjs";

function fixture({ method = "chatgpt-token-sharing", options = { models: ["test-model"] } } = {}) {
  const connection = { type: "credential", id: "account-a", method: "oauth" };
  const source = {
    provider: { package: "@opencode/ai/providers/openai", settings: { baseURL: "https://api.openai.com/v1" } },
    sourceConnection: { ...connection },
  };
  const templates = ["test-model", "other-model"].map(id => ({
    id, providerID: "openai", settings: { reasoningEffort: "high", compaction: { type: "summary" } },
  }));
  let transform;
  let wake;
  const queue = [];
  const hooks = new Map();
  const state = { connection, value: { type: "oauth", methodID: method }, reloads: 0, source, templates };
  const ctx = {
    options,
    integration: { connection: {
      active: async () => state.connection,
      resolve: async () => state.value,
    } },
    model: {
      reload: async () => { state.reloads++; },
      transform: async callback => {
        transform = callback;
        return { dispose: async () => { transform = undefined; } };
      },
    },
    session: { hook: async (name, callback, scope) => {
      assert.equal(scope.providerID, "openai");
      hooks.set(name, callback);
      return { dispose: async () => { hooks.delete(name); } };
    } },
    event: { async *subscribe({ signal }) {
      const abort = () => wake?.();
      signal.addEventListener("abort", abort);
      try {
        while (!signal.aborted) {
          if (!queue.length) await new Promise(resolve => { wake = resolve; });
          while (queue.length && !signal.aborted) yield queue.shift();
        }
      } finally { signal.removeEventListener("abort", abort); }
    } },
  };
  return {
    ctx, state, hooks,
    async switched() {
      queue.push({ type: "credential.switched", data: { integrationID: "openai" } });
      wake?.();
      await setImmediate();
    },
    catalog() {
      const items = structuredClone(templates);
      transform?.({
        provider: { get: () => source },
        list: () => items,
        update: (_, id, callback) => callback(items.find(item => item.id === id)),
      });
      return items;
    },
  };
}

test("SIWC opts in selected models while preserving generation settings", async () => {
  const f = fixture();
  const cleanup = await plugin.setup(f.ctx);
  try {
    const [selected, other] = f.catalog();
    assert.deepEqual(selected.settings, { reasoningEffort: "high", transport: "http", compaction: { type: "native" } });
    assert.equal(other.settings.compaction.type, "summary");
  } finally { await cleanup(); }
  assert.equal(f.catalog()[0].settings.compaction.type, "summary");
});

test("Codex, API keys and no account retain the built-in policy", async () => {
  for (const value of [
    { type: "oauth", methodID: "chatgpt-headless" },
    { type: "oauth", methodID: "chatgpt-browser" },
    { type: "key", key: "fixture" },
    undefined,
  ]) {
    const f = fixture();
    f.state.value = value;
    const cleanup = await plugin.setup(f.ctx);
    try { assert.equal(f.catalog()[0].settings.compaction.type, "summary"); }
    finally { await cleanup(); }
  }
});

test("account switching waits for the matching account catalog and disconnect restores summary", async () => {
  const f = fixture();
  const cleanup = await plugin.setup(f.ctx);
  try {
    f.state.connection = { ...f.state.connection, id: "account-b" };
    await f.switched();
    assert.equal(f.catalog()[0].settings.compaction.type, "summary");
    f.state.source.sourceConnection.id = "account-b";
    assert.equal(f.catalog()[0].settings.compaction.type, "native");
    f.state.connection = undefined;
    await f.switched();
    assert.equal(f.catalog()[0].settings.compaction.type, "summary");
  } finally { await cleanup(); }
});

test("disabled models and custom endpoints/packages are excluded", async () => {
  const f = fixture();
  const cleanup = await plugin.setup(f.ctx);
  try {
    for (const changes of [
      { enabled: false },
      { package: "custom-provider" },
      { settings: { baseURL: "https://example.com/v1", compaction: { type: "summary" } } },
    ]) {
      const original = structuredClone(f.state.templates[0]);
      Object.assign(f.state.templates[0], changes);
      assert.equal(f.catalog()[0].settings.compaction.type, "summary");
      f.state.templates[0] = original;
    }
    f.state.source.provider.settings.baseURL = "https://example.com/v1";
    assert.equal(f.catalog()[0].settings.compaction.type, "summary");
  } finally { await cleanup(); }
});

test("no selected models is inert and invalid options are rejected", async () => {
  const f = fixture({ options: {} });
  assert.equal(await plugin.setup(f.ctx), undefined);
  assert.equal(f.state.reloads, 0);
  await assert.rejects(plugin.setup(fixture({ options: { models: "all" } }).ctx), /array of model IDs/);
});

function sse(events) {
  const text = events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join("");
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    // Split at every byte, including the CRLF and multi-byte text boundaries.
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }));
}

test("probe rejects truncated, failed, incomplete and malformed checkpoint responses", async () => {
  await assert.rejects(completedResponse(sse([{ type: "response.created" }])), /without response.completed/);
  for (const type of ["response.failed", "response.incomplete", "error"]) {
    await assert.rejects(completedResponse(sse([{ type }])), new RegExp(type));
  }
  for (const output of [[], [{ type: "compaction", id: "one", encrypted_content: "" }],
    [{ type: "compaction", encrypted_content: "missing-id" }]]) {
    assert.throws(() => checkpoint({ output }), /No pre-generation encrypted checkpoint/);
  }
});

test("probe uses only public Responses and exercises two checkpoint/replay rounds", async () => {
  let calls = 0;
  let token;
  const result = await probe("synthetic-fixture-token", { id: "test-model-fast", modelID: "test-model", body: { service_tier: "priority" } }, async (url, request) => {
    calls++;
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(request.redirect, "error");
    const body = JSON.parse(request.body);
    assert.equal(body.model, "test-model");
    assert.equal(body.service_tier, "priority");
    assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    if (calls === 1) token = body.input[0].content.match(/siwc-[a-f0-9-]+/)[0];
    assert(!body.input.some(item => item.type === "compaction_trigger"));
    const compact = body.context_management?.[0]?.type === "compaction";
    if (compact) {
      assert.equal(body.context_management[0].compact_threshold, 1000);
      assert.equal(body.tool_choice, "none");
    }
    if (calls === 3 || calls === 5) {
      assert.equal(body.input[0].type, "compaction");
      assert(!JSON.stringify(body.input).includes(token));
    }
    const output = compact
      ? [{ type: "compaction", id: `checkpoint-${calls}`, encrypted_content: "fixture-encrypted" }]
      : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: token }] }];
    return sse([
      ...output.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
      { type: "response.completed", response: { status: "completed", output: [] } },
    ]);
  });
  assert.equal(calls, 5);
  assert.equal(result.status, "passed");
  assert.equal(result.rounds.length, 2);
});

test("probe identifies the failed stage and redacts credentials in API detail errors", async () => {
  await assert.rejects(probe("synthetic-fixture-token", "test-model", async () =>
    Response.json({ detail: "Unsupported model; synthetic-fixture-token" }, { status: 400 })),
  error => error.message.includes("initial: HTTP 400") && error.message.includes("Unsupported model") &&
    !error.message.includes("synthetic-fixture-token"));
});

const compactItem = (id, encrypted = id) => ({ type: "compaction", id, encrypted_content: encrypted });
const done = (item, output_index) => ({ type: "response.output_item.done", output_index, item });
const terminal = { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [], usage: { input_tokens: 1234 } } };

test("native hook keeps original instructions and the pre-generation checkpoint with usage", async () => {
  const f = fixture();
  const cleanup = await plugin.setup(f.ctx);
  try {
    f.catalog();
    const scope = { model: { providerID: "openai", id: "test-model" }, kind: "compaction" };
    const options = { ...scope, options: {} };
    await f.hooks.get("compaction")(options);
    assert.equal(options.options.contextManagement[0].compactThreshold, 1000);
    const original = { instructions: "Original task.", input: [{ role: "user", content: "Original context." }, { type: "compaction_trigger" }] };
    const request = () => new Request("https://api.openai.com/v1/responses", { method: "POST", body: JSON.stringify(original) });
    const untouched = { ...scope, kind: "primary", request: request() };
    await f.hooks.get("http.request")(untouched);
    assert.deepEqual(await untouched.request.json(), original);
    const event = { ...scope, request: request() };
    await f.hooks.get("http.request")(event);
    const body = await event.request.clone().json();
    assert.deepEqual(body.input, original.input.slice(0, -1));
    assert.equal(body.instructions, original.instructions);
    assert.equal(body.tool_choice, "none");
    assert.equal(body.context_management[0].compact_threshold, 1000);
    const last = compactItem("latest");
    event.response = sse([done(compactItem("earlier"), 0), done({ type: "message", id: "ignored", content: [] }, 1), done(last, 2), terminal]);
    await f.hooks.get("http.response")(event);
    const result = await completedResponse(event.response);
    assert.deepEqual(result.output, [compactItem("earlier")]);
    assert.equal(result.usage.input_tokens, 1234);
    assert.deepEqual(checkpoint({ output: [compactItem("first"), compactItem("second"),
      { type: "message" }, last] }), compactItem("second"));
  } finally { await cleanup(); }
  assert.equal(f.hooks.size, 0);
});

test("checkpoint is never accepted before successful terminal completion", async () => {
  for (const end of [[], [{ type: "response.failed" }], [{ type: "response.incomplete" }]]) {
    await assert.rejects(checkpointResponse(sse([done(compactItem("partial"), 0), ...end])));
  }
  await assert.rejects(checkpointResponse(sse([terminal])), /No pre-generation encrypted checkpoint/);
  await assert.rejects(checkpointResponse(sse([
    done({ type: "message", id: "new-generation", content: [] }, 0), done(compactItem("too-late"), 1), terminal,
  ])), /No pre-generation encrypted checkpoint/);
  await assert.rejects(checkpointResponse(sse([
    done(compactItem("changed", "before"), 0), done(compactItem("changed", "after"), 0), terminal,
  ])), /changed after completion/);
});

test("cancelling a compaction cancels its pending upstream reader", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const pending = checkpointResponse(response, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await setImmediate();
  assert(cancelled);
});
