// SIWC accepts context_management but rejects compaction_trigger input items.
export const COMPACT_THRESHOLD = 1000;

export function compactionBody(body) {
  if (body.input?.at(-1)?.type !== "compaction_trigger") throw new Error("Missing native compaction trigger");
  return {
    ...body,
    input: body.input.slice(0, -1),
    context_management: [{ type: "compaction", compact_threshold: COMPACT_THRESHOLD }],
    tool_choice: "none", stream: true, store: false,
  };
}

export async function completedResponse(response, { signal } = {}) {
  if (!response.ok) {
    let payload;
    try { payload = await response.json(); } catch {}
    const error = payload?.error;
    const detail = error?.message ?? payload?.detail;
    throw new Error(`HTTP ${response.status}; code=${error?.code ?? "unknown"}; param=${error?.param ?? "unknown"}` +
      (typeof detail === "string" ? `; ${detail}` : ""));
  }
  let buffer = "";
  let completed;
  let responseID;
  const output = new Map();
  const remember = (index, item) => {
    if (!Number.isInteger(index) || index < 0 || !item) throw new Error("Invalid output item index");
    if (item.type === "compaction") {
      if (!item.id || typeof item.encrypted_content !== "string" || !item.encrypted_content) {
        throw new Error("Invalid encrypted compaction item");
      }
      const previous = output.get(index);
      if (previous && (previous.id !== item.id || previous.encrypted_content !== item.encrypted_content)) {
        throw new Error("Compaction item changed after completion");
      }
    }
    output.set(index, item);
  };
  const consume = frame => {
    const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data);
    if (event.response?.id) {
      if (responseID && responseID !== event.response.id) throw new Error("Response ID changed during stream");
      responseID = event.response.id;
    }
    if (["error", "response.failed", "response.incomplete"].includes(event.type)) {
      throw new Error(`${event.type}; code=${event.error?.code ?? event.response?.error?.code ?? event.code ?? "unknown"}`);
    }
    if (event.type === "response.output_item.done") remember(event.output_index, event.item);
    if (event.type === "response.completed") {
      if (completed || event.response?.status !== "completed") throw new Error("Invalid terminal response status");
      completed = event.response;
      for (const [index, item] of (completed.output ?? []).entries()) remember(index, item);
    }
  };
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      buffer = (buffer + value).replace(/\r\n/g, "\n");
      let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        consume(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
      }
    }
    if (buffer.trim()) consume(buffer);
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
  }
  if (!completed) throw new Error("Stream ended without response.completed");
  for (let index = 0; index < output.size; index++) {
    if (!output.has(index)) throw new Error("Response is missing a completed output item");
  }
  // SIWC sends output in item.done events and can leave completed.output empty.
  return { ...completed, output: [...output].sort(([a], [b]) => a - b).map(([, item]) => item) };
}

export function checkpoint(response) {
  let item;
  for (const output of response.output ?? []) {
    if (output.type !== "compaction") break;
    item = output;
  }
  if (item?.type !== "compaction" || !item.id || typeof item.encrypted_content !== "string" || !item.encrypted_content) {
    throw new Error("No pre-generation encrypted checkpoint; context may be below the 1000-token minimum");
  }
  return { type: "compaction", id: item.id, encrypted_content: item.encrypted_content };
}

export async function checkpointResponse(response, signal) {
  const completed = await completedResponse(response, { signal });
  const item = checkpoint(completed);
  if (!completed.id) throw new Error("Compaction response is missing its response ID");
  // Only leading checkpoints precede new generation. Later checkpoints can
  // include generated text that is not part of the real session.
  const events = [
    { type: "response.created", response: { id: completed.id, status: "in_progress", output: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { ...completed, output: [item] } },
  ];
  const headers = new Headers(response.headers);
  for (const key of ["content-length", "content-encoding", "transfer-encoding"]) headers.delete(key);
  headers.set("content-type", "text/event-stream");
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: response.status, headers });
}
