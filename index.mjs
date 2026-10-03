// V2 owns checkpoint persistence, replay and usage. Adapt its trigger to SIWC's
// supported context_management and return the pre-generation encrypted item.
import { COMPACT_THRESHOLD, compactionBody, checkpointResponse } from "./protocol.mjs";

const PROVIDER = "openai";
const METHOD = "chatgpt-token-sharing";
const PACKAGE = "@opencode/ai/providers/openai";

function isPublicAPI(value) {
  return typeof value === "string" && value.replace(/\/+$/, "") === "https://api.openai.com/v1";
}

export default {
  id: "opencode-siwc-native-compact",
  async setup(ctx) {
    const selected = ctx.options.models ?? [];
    if (!Array.isArray(selected) || selected.some(id => typeof id !== "string" || !id.trim())) {
      throw new Error("siwc-native-compact: models must be an array of model IDs");
    }
    const models = new Set(selected);
    if (models.size === 0) return;

    let credentialID;
    let stopped = false;
    let pending = Promise.resolve();
    const controller = new AbortController();
    const enabled = new Set();
    const adapted = new WeakSet();
    const registrations = [];
    const eligible = event => credentialID && event.kind === "compaction" && enabled.has(event.model.id);

    // Keep only the connection identity; credential refresh remains OpenCode-owned.
    const refresh = () => {
      pending = pending.then(async () => {
        if (stopped) return;
        let next;
        try {
          const connection = await ctx.integration.connection.active(PROVIDER);
          if (connection?.type === "credential") {
            const value = await ctx.integration.connection.resolve(connection);
            if (value?.type === "oauth" && value.methodID === METHOD) next = connection.id;
          }
        } catch {
          // A disconnected or expired account uses the built-in summary policy.
        }
        if (stopped || next === credentialID) return;
        credentialID = next;
        await ctx.model.reload();
      });
      return pending;
    };

    const events = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === "server.connected" ||
            (event.type === "credential.switched" && event.data.integrationID === PROVIDER)) {
          await refresh();
        }
      }
    })().catch(async () => {
      if (stopped) return;
      credentialID = undefined;
      await ctx.model.reload();
    });

    try {
      await refresh();
      registrations.push(await ctx.model.transform(editor => {
        enabled.clear();
        const source = editor.provider.get(PROVIDER);
        if (!credentialID || source?.sourceConnection?.type !== "credential" ||
            source.sourceConnection.id !== credentialID ||
            !isPublicAPI(source.provider.settings?.baseURL)) return;

        for (const model of editor.list(PROVIDER)) {
          if (!models.has(model.id) || model.enabled === false ||
              (model.package ?? source.provider.package) !== PACKAGE ||
              (model.settings?.baseURL !== undefined && !isPublicAPI(model.settings.baseURL))) continue;
          editor.update(PROVIDER, model.id, draft => {
            draft.settings = { ...draft.settings, transport: "http", compaction: { type: "native" } };
          });
          enabled.add(model.id);
        }
      }));
      registrations.push(await ctx.session.hook("compaction", event => {
        if (credentialID && enabled.has(event.model.id)) {
          // Set the semantic option before lowering so GPT-6 effort updates are
          // converted to reasoning settings, rather than configuration_update items.
          event.options.contextManagement = [{ type: "compaction", compactThreshold: COMPACT_THRESHOLD }];
        }
      }, { providerID: PROVIDER }));
      registrations.push(await ctx.session.hook("http.request", async event => {
        if (!eligible(event) || event.request.url !== "https://api.openai.com/v1/responses") return;
        const body = await event.request.clone().json();
        if (body.input?.at(-1)?.type !== "compaction_trigger") return;
        const headers = new Headers(event.request.headers);
        headers.delete("content-length");
        event.request = new Request(event.request, { headers, body: JSON.stringify(compactionBody(body)) });
        adapted.add(event.request);
      }, { providerID: PROVIDER }));
      registrations.push(await ctx.session.hook("http.response", async event => {
        if (!adapted.has(event.request)) return;
        adapted.delete(event.request);
        if (event.response.ok) event.response = await checkpointResponse(event.response, event.request.signal);
      }, { providerID: PROVIDER }));
    } catch (error) {
      stopped = true;
      controller.abort();
      await events;
      for (const registration of registrations.reverse()) await registration.dispose();
      throw error;
    }

    return async () => {
      stopped = true;
      controller.abort();
      await events;
      for (const registration of registrations.reverse()) await registration.dispose();
    };
  },
};
