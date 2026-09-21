// src/parlay-input/types.ts
var PROTOCOL_V = 1;
var ACTION_TTL_MS = 1500;
// src/parlay-input/dom.ts
var LIB_VERSION = "0.2.0";
function readValue(el) {
  if ("value" in el)
    return String(el.value ?? "");
  return el.textContent ?? "";
}
function writeValue(el, text) {
  if ("value" in el)
    el.value = text;
  else
    el.textContent = text;
}
function readCursor(el) {
  const input = el;
  if (typeof input.selectionStart === "number" && typeof input.selectionEnd === "number") {
    return { anchor: input.selectionStart, active: input.selectionEnd };
  }
  return { anchor: 0, active: 0 };
}
function writeCursor(el, pos) {
  const input = el;
  if (typeof input.setSelectionRange === "function")
    input.setSelectionRange(pos, pos);
}
function randomId(prefix) {
  const c = globalThis.crypto;
  if (c?.randomUUID)
    return c.randomUUID();
  return `${prefix}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
function getDeviceId() {
  try {
    const ls = globalThis.localStorage;
    if (ls) {
      let id = ls.getItem("pa-device-id");
      if (!id) {
        id = randomId("dev");
        ls.setItem("pa-device-id", id);
      }
      return id;
    }
  } catch {}
  return randomId("dev");
}
var MUTATING_VERBS = new Set(["setText", "clear", "submitNow", "replaceRange", "stripTrigger"]);
function isMutating(env) {
  return env.actions.some((a) => MUTATING_VERBS.has(a.verb));
}
// src/parlay-input/sse.ts
function pageUrl() {
  try {
    return globalThis.location?.href ?? "";
  } catch {
    return "";
  }
}
function openOwnedSse(cfg) {
  const { base, device, EventSourceImpl, reconnect, onEnvelope, onError } = cfg;
  if (!EventSourceImpl)
    return () => {};
  const initialMs = reconnect?.initialMs ?? 1000;
  const maxMs = reconnect?.maxMs ?? 30000;
  let delay = initialMs;
  let es = null;
  let reconnectTimer = null;
  let stopped = false;
  const connect = () => {
    if (stopped)
      return;
    const url = `${base}/api/chat/events?device=${encodeURIComponent(device)}` + `&url=${encodeURIComponent(pageUrl())}`;
    es = new EventSourceImpl(url);
    es.addEventListener("open", () => {
      delay = initialMs;
    });
    es.addEventListener("input_action", (e) => {
      try {
        onEnvelope(JSON.parse(e.data));
      } catch (err) {
        onError?.(err);
      }
    });
    es.onerror = () => {
      try {
        es?.close();
      } catch {}
      if (stopped)
        return;
      reconnectTimer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, maxMs);
    };
  };
  connect();
  return () => {
    stopped = true;
    if (reconnectTimer)
      clearTimeout(reconnectTimer);
    try {
      es?.close();
    } catch {}
  };
}

// src/parlay-input/core.ts
function parlayInput(element, options) {
  const {
    server,
    event = "input",
    settleMs = 450,
    voiceEnabled = false,
    protocolVersion = PROTOCOL_V,
    paVersion = LIB_VERSION,
    tabs = () => [],
    onAction,
    onSubmit,
    onApply,
    onError,
    subscribe,
    reconnect,
    fetch: fetchImpl = globalThis.fetch,
    EventSource: EventSourceImpl = globalThis.EventSource
  } = options;
  const base = server.replace(/\/+$/, "");
  const device = options.device ?? getDeviceId();
  const streamId = options.streamId ?? `eval-${device}-${randomId("e")}`;
  let version = 0;
  let closed = false;
  let settleTimer = null;
  const expectedSeq = new Map;
  function bumpVersion() {
    return ++version;
  }
  function scheduleEval(immediate, reason) {
    if (closed)
      return;
    const fire = () => {
      postEval(reason);
    };
    if (immediate) {
      fire();
      return;
    }
    if (settleTimer)
      clearTimeout(settleTimer);
    settleTimer = setTimeout(fire, Math.max(0, settleMs));
  }
  async function postEval(reason) {
    if (!fetchImpl)
      return;
    const sentVersion = version;
    try {
      const r = await fetchImpl(`${base}/api/chat/eval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          streamId,
          version: sentVersion,
          text: readValue(element),
          cursor: readCursor(element),
          reason,
          voiceEnabled,
          tabs: tabs(),
          device,
          paVersion
        })
      });
    } catch (err) {
      onError?.(err);
    }
  }
  function resync(reason) {
    bumpVersion();
    scheduleEval(true, reason);
  }
  function submit(text) {
    if (onSubmit) {
      onSubmit(text);
      return;
    }
    if (!fetchImpl)
      return;
    fetchImpl(`${base}/api/chat/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    }).catch((err) => onError?.(err));
  }
  const actionCtx = {
    element,
    readValue: () => readValue(element),
    writeValue: (t) => writeValue(element, t),
    submit,
    device,
    streamId
  };
  function applySubmitNow(a) {
    const requireTail = String(a.args?.requireTail ?? "");
    const val = readValue(element);
    if (requireTail) {
      const idx = val.toLowerCase().lastIndexOf(requireTail.toLowerCase());
      const after = idx === -1 ? "" : val.slice(idx + requireTail.length).trim().replace(/[.!?,;]+/g, "");
      if (idx === -1 || after !== "")
        return "rejected-stale";
      const stripped = val.slice(0, idx).trim();
      if (stripped)
        submit(stripped);
      return "applied";
    }
    const t = String(a.args?.text ?? "").trim();
    if (t)
      submit(t);
    return "applied";
  }
  function applyAction(a) {
    try {
      switch (a.verb) {
        case "noop":
          return "applied";
        case "setText":
          writeValue(element, String(a.args?.text ?? ""));
          return "applied";
        case "clear":
          writeValue(element, "");
          return "applied";
        case "submitNow":
          return applySubmitNow(a);
        case "replaceRange": {
          const val = readValue(element);
          const start = Math.max(0, Math.min(val.length, Number(a.args?.start ?? 0)));
          const end = Math.max(start, Math.min(val.length, Number(a.args?.end ?? start)));
          const text = String(a.args?.text ?? "");
          writeValue(element, val.slice(0, start) + text + val.slice(end));
          writeCursor(element, start + text.length);
          return "applied";
        }
        default:
          onAction?.(a, actionCtx);
          return "applied";
      }
    } catch (err) {
      onError?.(err);
      return "applied";
    }
  }
  function applyEnvelope(env) {
    if (env.v !== protocolVersion) {
      onApply?.("rejected-protocol", env);
      return "rejected-protocol";
    }
    if (env.baseVersion < version && isMutating(env)) {
      onApply?.("rejected-stale", env);
      resync("resync");
      return "rejected-stale";
    }
    const expected = expectedSeq.get(env.streamId);
    if (expected != null && env.seq > expected) {
      onApply?.("resync", env);
      resync("resync");
    }
    expectedSeq.set(env.streamId, env.seq + 1);
    for (const a of env.actions) {
      const r = applyAction(a);
      if (r !== "applied") {
        onApply?.(r, env);
        return r;
      }
    }
    onApply?.("applied", env);
    return "applied";
  }
  function onDomEvent() {
    bumpVersion();
    scheduleEval(false, "input");
  }
  element.addEventListener(event, onDomEvent);
  const unsubscribeSse = subscribe ? subscribe("input_action", (env) => {
    try {
      applyEnvelope(env);
    } catch (err) {
      onError?.(err);
    }
  }) ?? (() => {}) : openOwnedSse({ base, device, EventSourceImpl, reconnect, onEnvelope: applyEnvelope, onError });
  return function unsubscribe() {
    if (closed)
      return;
    closed = true;
    if (settleTimer)
      clearTimeout(settleTimer);
    element.removeEventListener(event, onDomEvent);
    try {
      unsubscribeSse();
    } catch {}
  };
}
export {
  parlayInput,
  getDeviceId,
  PROTOCOL_V,
  ACTION_TTL_MS
};
