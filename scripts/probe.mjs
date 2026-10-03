#!/usr/bin/env node
// Synthetic SIWC capability probe. Credentials and encrypted checkpoints stay in memory.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { compactionBody, completedResponse, checkpoint } from "../protocol.mjs";
export { completedResponse, checkpoint } from "../protocol.mjs";

const execute = promisify(execFile);
const API = "https://api.openai.com/v1";

export async function probe(access, model, send = fetch) {
  const { id, modelID = id, body = {} } = typeof model === "string" ? { id: model } : model;
  const nonce = `siwc-${randomUUID()}`;
  const instructions = "Remember the verification token from the conversation. When asked, output only that token.";
  const call = async (stage, input, compact = false) => {
    try {
      const request = { ...body, model: modelID, instructions, input, stream: true, store: false,
        include: ["reasoning.encrypted_content"] };
      return await completedResponse(await send(`${API}/responses`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(120_000),
        headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
        body: JSON.stringify(compact ? compactionBody(request) : request),
      }));
    } catch (error) {
      const message = String(error.message).replaceAll(access, "[REDACTED]")
        .replace(/\b[A-Za-z0-9_-]{80,}(?:\.[A-Za-z0-9_-]+)*\b/g, "[REDACTED]").slice(0, 1000);
      throw new Error(`${stage}: ${message}`);
    }
  };
  const initial = [{ role: "user", content: `Remember this verification token: ${nonce}.` }];
  const first = await call("initial", initial);
  let history = [...initial, ...first.output];
  const rounds = [];
  const padding = { role: "user", content: Array.from({ length: 100 }, (_, i) =>
    `Synthetic record ${i}: the sample color is blue and the sample count is seven.`).join("\n") };
  for (let round = 1; round <= 2; round++) {
    const compacted = await call(`compact-${round}`, [...history, padding, { type: "compaction_trigger" }], true);
    const item = checkpoint(compacted);
    const question = { role: "user", content: "What was the verification token? Output only the token." };
    const continued = await call(`replay-${round}`, [item, question]);
    const text = (continued.output ?? []).flatMap(output => output.content ?? [])
      .filter(part => part.type === "output_text").map(part => part.text).join("").trim();
    if (text !== nonce) throw new Error(`Checkpoint replay did not preserve the verification token (round ${round})`);
    rounds.push({ round, checkpoints: compacted.output.filter(item => item.type === "compaction").length,
      checkpoint: true, replay: true, usage: compacted.usage });
    history = [item, question, ...continued.output];
  }
  return { status: "passed", mechanism: "context_management", model: id, wireModel: modelID,
    serviceTier: body.service_tier, route: `${API}/responses`, rounds };
}

async function main() {
  const index = process.argv.indexOf("--model");
  const model = index >= 0 ? process.argv[index + 1] : undefined;
  const serverIndex = process.argv.indexOf("--server");
  const server = serverIndex >= 0 ? process.argv[serverIndex + 1] : undefined;
  if (!model || model.startsWith("--") || (serverIndex >= 0 && (!server || server.startsWith("--")))) {
    throw new Error("Usage: node scripts/probe.mjs --model <model-id> [--server <OpenCode server URL>]");
  }
  const local = async path => {
    const { stdout } = await execute("opencode", [
      "api", ...(server ? ["--server", server] : []), "get", path,
    ], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout).data;
  };
  const entries = await local("/api/credential");
  const value = entries.find(entry => entry.integrationID === "openai" && entry.active)?.value;
  if (value?.type !== "oauth" || value.methodID !== "chatgpt-token-sharing") {
    console.log(JSON.stringify({ status: "blocked", reason: "Sign in with ChatGPT is required", activeMethod: value?.methodID ?? value?.type }));
    process.exitCode = 2;
    return;
  }
  if (value.expires < Date.now() + 300_000) throw new Error("Refresh the SIWC connection in OpenCode, then rerun the probe");
  const models = await local("/api/model");
  const selected = models.find(entry => entry.providerID === "openai" && entry.id === model && entry.enabled !== false);
  if (!selected) throw new Error(`OpenAI model is unavailable: ${model}`);
  console.log(JSON.stringify(await probe(value.access, selected), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // Child-process failures can contain stdout (including credentials); only local messages are reported.
    const message = error.cmd ? "Local OpenCode API query failed" : error.message;
    console.error(JSON.stringify({ status: "failed", message }));
    process.exitCode = 1;
  });
}
