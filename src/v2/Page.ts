/** The native clients own audio capture. This page is another view of the same conversation. */
const client = String.raw`
(() => {
  const byId = (id) => document.getElementById(id);
  const auth = byId("auth"), tokenInput = byId("token"), connectButton = byId("connect");
  const status = byId("status"), notice = byId("notice"), retry = byId("retry"), disconnect = byId("disconnect");
  const transcript = byId("transcript"), empty = byId("empty"), composer = byId("composer");
  const draft = byId("draft"), send = byId("send"), stop = byId("stop"), announcement = byId("announcement");
  let token = "", epoch = 0, active, retryTimer, ready = false, submitting = false, pending;
  let messages = new Map(), following = true, currentResponse;
  const limit = 2 * 1024 * 1024;
  const text = (value) => typeof value === "string" ? value : "";
  const controls = () => {
    draft.disabled = !ready || submitting;
    send.disabled = !ready || submitting || !draft.value.trim();
    stop.disabled = !ready;
    connectButton.disabled = !!active;
  };
  const state = (value, kind = "idle") => { status.textContent = value; status.dataset.state = kind; };
  const inform = (value, error = true) => { notice.textContent = value; notice.hidden = !value; notice.dataset.kind = error ? "error" : "information"; };
  const scroll = () => { if (following) transcript.scrollTop = transcript.scrollHeight; };
  const reset = () => {
    messages = new Map(); currentResponse = undefined; following = true;
    transcript.replaceChildren(); empty.hidden = false;
  };
  function message(key, role, value, phase = "") {
    let entry = messages.get(key);
    if (!entry) {
      const row = document.createElement("article"), label = document.createElement("p");
      const body = document.createElement("div"), progress = document.createElement("p");
      row.className = "message"; row.dataset.role = role;
      label.className = "speaker"; label.textContent = role === "user" ? "You" : "yapd";
      body.className = "words"; progress.className = "message-state";
      row.append(label, body, progress); transcript.append(row);
      entry = { body, progress, done: false }; messages.set(key, entry);
    }
    entry.body.textContent = value;
    entry.progress.textContent = phase;
    entry.progress.hidden = !phase;
    empty.hidden = true; scroll();
    return entry;
  }
  function receive(event, connection) {
    if (connection.epoch !== epoch || active !== connection) return;
    if (!event || typeof event !== "object") throw new Error("The conversation stream sent an invalid event.");
    if (event.type === "snapshot") {
      if (!Array.isArray(event.items) || !text(event.conversationId)) throw new Error("The conversation history could not be read.");
      reset();
      for (const item of event.items) {
        if (item.type !== "message" || !["user", "assistant"].includes(item.role) || !text(item.turnId)) continue;
        const key = item.role === "user" ? "user:" + item.turnId : "assistant:" + (item.responseId || item.turnId);
        const entry = message(key, item.role, text(item.text)); entry.done = item.role === "assistant";
        if (pending && item.role === "user" && item.turnId === pending.turnId) {
          if (draft.value.trim() === pending.text) draft.value = "";
          pending = undefined;
        }
      }
      for (const response of Array.isArray(event.responses) ? event.responses : []) {
        if (!text(response.responseId)) continue;
        const phase = text(response.error) || (response.phase === "interrupted" ? "Interrupted" : response.phase === "paused" ? "Paused" : response.done ? "" : "Working…");
        const entry = message("assistant:" + response.responseId, "assistant", text(response.text), phase);
        entry.done = !!response.done;
        if (!entry.done) currentResponse = response.responseId;
      }
      connection.snapshot = true; ready = true; auth.hidden = true; disconnect.hidden = false;
      retry.hidden = true; inform(""); state("Connected", "connected"); controls();
      return;
    }
    if (!connection.snapshot) throw new Error("The conversation stream did not begin with its history.");
    switch (event.type) {
      case "turn_committed":
        if (text(event.turnId)) message("user:" + event.turnId, "user", text(event.text));
        break;
      case "response_started": {
        if (!text(event.responseId)) break;
        const key = "assistant:" + event.responseId, previous = messages.get(key);
        if (previous && previous.done) break;
        currentResponse = event.responseId;
        message(key, "assistant", previous ? previous.body.textContent : "", previous && previous.body.textContent ? "" : "Working…");
        break;
      }
      case "text_delta": {
        if (!text(event.responseId) || typeof event.delta !== "string") break;
        const key = "assistant:" + event.responseId, previous = messages.get(key);
        if (previous && previous.done) break;
        message(key, "assistant", (previous ? previous.body.textContent : "") + event.delta);
        break;
      }
      case "response_done": {
        if (!text(event.responseId)) break;
        message("assistant:" + event.responseId, "assistant", text(event.text)).done = true;
        if (currentResponse === event.responseId) currentResponse = undefined;
        announcement.textContent = "yapd replied.";
        break;
      }
      case "output_cancelled": {
        const entry = messages.get("assistant:" + text(event.responseId));
        if (!entry) break;
        entry.progress.textContent = event.reason === "onset" ? "Paused" : "Stopped";
        entry.progress.hidden = false;
        if (event.reason !== "onset") entry.done = true;
        break;
      }
      case "output_resumed": {
        const key = "assistant:" + text(event.responseId), entry = messages.get(key);
        if (entry && text(event.responseId)) message(key, "assistant", text(event.text));
        break;
      }
      case "error":
      case "runtime_error":
        if (text(event.responseId)) {
          const key = "assistant:" + event.responseId, before = messages.get(key);
          const entry = message(key, "assistant", before ? before.body.textContent : "", text(event.message) || "This response could not finish.");
          entry.done = true;
          if (currentResponse === event.responseId) currentResponse = undefined;
        }
        inform(text(event.message) || "The assistant could not finish this request.");
        break;
      // Tools, recognition previews and private context are not conversation messages.
    }
  }
  function halt() {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    const previous = active; active = undefined; ready = false;
    if (previous) { previous.controller.abort(); if (previous.reader) void previous.reader.cancel().catch(() => {}); }
  }
  async function attempt(version, count) {
    if (version !== epoch) return;
    const connection = { epoch: version, controller: new AbortController(), snapshot: false };
    active = connection; state(count ? "Reconnecting…" : "Connecting…"); controls();
    try {
      const response = await fetch("/conversation/stream", { headers: { Authorization: "Bearer " + token, Accept: "text/event-stream" }, signal: connection.controller.signal, cache: "no-store" });
      if (version !== epoch || active !== connection) { if (response.body) await response.body.cancel(); return; }
      if (!response.ok) {
        const error = new Error(response.status === 401 || response.status === 403 ? "Connection token rejected. Enter it again." : "Connection failed (HTTP " + response.status + ").");
        error.authorization = response.status === 401 || response.status === 403;
        throw error;
      }
      if (!response.body || !(response.headers.get("content-type") || "").includes("text/event-stream")) throw new Error("The server did not open a conversation stream.");
      const reader = response.body.getReader(); connection.reader = reader;
      const decoder = new TextDecoder(); let buffered = "", data = [], size = 0;
      const line = (value) => {
        if (!value) {
          if (data.length) { const event = JSON.parse(data.join("\n")); data = []; size = 0; receive(event, connection); }
          return;
        }
        if (value.startsWith("data:")) {
          const field = value.slice(5).replace(/^ /, ""); size += field.length;
          if (size > limit) throw new Error("The conversation event exceeded its size limit.");
          data.push(field);
        }
      };
      while (version === epoch && active === connection) {
        const part = await reader.read();
        if (version !== epoch || active !== connection) return;
        if (part.done) throw new Error("The conversation connection closed.");
        buffered += decoder.decode(part.value, { stream: true });
        if (buffered.length > limit) throw new Error("The conversation stream exceeded its size limit.");
        while (true) {
          const boundary = buffered.search(/[\r\n]/);
          if (boundary < 0 || buffered[boundary] === "\r" && boundary === buffered.length - 1) break;
          const length = buffered[boundary] === "\r" && buffered[boundary + 1] === "\n" ? 2 : 1;
          const value = buffered.slice(0, boundary); buffered = buffered.slice(boundary + length); line(value);
        }
      }
    } catch (error) {
      if (version !== epoch || active !== connection || connection.controller.signal.aborted) return;
      active = undefined; ready = false; submitting = false; connection.controller.abort();
      if (connection.reader) void connection.reader.cancel().catch(() => {});
      const reason = error instanceof Error ? error.message : "The conversation connection failed.";
      if (error && error.authorization) {
        token = ""; auth.hidden = false; disconnect.hidden = true; retry.hidden = true;
        state("Disconnected"); inform(reason); tokenInput.focus();
      } else if (count === 0) {
        state("Connection interrupted"); inform(reason + " Reconnecting once…");
        retryTimer = setTimeout(() => { retryTimer = undefined; void attempt(version, count + 1); }, Math.min(2000, 500 * 2 ** count));
      } else {
        state("Disconnected"); inform(reason + " Retry to reconnect."); retry.hidden = false;
      }
      controls();
    }
  }
  function begin() {
    halt(); epoch += 1; submitting = false; reset();
    retry.hidden = true; inform(""); void attempt(epoch, 0);
  }
  auth.addEventListener("submit", (event) => {
    event.preventDefault(); const value = tokenInput.value.trim(); if (!value) return;
    token = value; tokenInput.value = ""; begin();
  });
  retry.addEventListener("click", () => { if (token) begin(); });
  disconnect.addEventListener("click", () => {
    halt(); epoch += 1; token = ""; pending = undefined; submitting = false; draft.value = ""; reset();
    auth.hidden = false; disconnect.hidden = true; retry.hidden = true;
    state("Disconnected"); inform(""); controls(); tokenInput.focus();
  });
  draft.addEventListener("input", controls);
  draft.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!send.disabled) composer.requestSubmit(); }
  });
  transcript.addEventListener("scroll", () => { following = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100; });
  composer.addEventListener("submit", async (event) => {
    event.preventDefault(); const value = draft.value.trim(); if (!ready || submitting || !value) return;
    if (!pending || pending.text !== value) pending = { text: value, turnId: crypto.randomUUID() };
    const request = pending, connection = active, version = epoch;
    submitting = true; controls(); inform("");
    try {
      const response = await fetch("/conversation/turns", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ text: request.text, turnId: request.turnId }), signal: connection.controller.signal });
      if (version !== epoch || active !== connection) return;
      if (response.status !== 202) throw new Error("Message was not accepted (HTTP " + response.status + ").");
      const receipt = await response.json();
      if (version !== epoch || active !== connection) return;
      if (receipt.turnId !== request.turnId || !text(receipt.responseId) || !Number.isSafeInteger(receipt.revision)) throw new Error("The server returned an invalid message receipt.");
      if (draft.value.trim() === request.text) draft.value = "";
      pending = undefined; draft.focus();
    } catch (error) {
      if (version === epoch && active === connection) inform((error instanceof Error ? error.message : "Message delivery is unconfirmed.") + " Send again to retry the same message.");
    } finally { if (version === epoch && active === connection) { submitting = false; controls(); } }
  });
  stop.addEventListener("click", async () => {
    if (!ready) return;
    const connection = active, version = epoch;
    try {
      const response = await fetch("/conversation/stop", { method: "POST", headers: { Authorization: "Bearer " + token }, signal: connection.controller.signal });
      if (version !== epoch || active !== connection) return;
      if (response.status !== 204) throw new Error("Stop was not accepted (HTTP " + response.status + ").");
      inform("Stop requested.", false);
    } catch (error) {
      if (version === epoch && active === connection) inform(error instanceof Error ? error.message : "Could not request Stop.");
    }
  });
  controls();
})();
`

export const html = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light"><title>yapd conversation</title>
<style>
:root{font-family:"Avenir Next","Trebuchet MS",sans-serif;color:#202e42;background:#f6f8fb;font-synthesis:none;--muted:#596b80;--line:#d7dfea;--blue:#3659b8}
*{box-sizing:border-box}body{margin:0}button,input,textarea{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.48}button,input,textarea{border:1px solid var(--line);border-radius:8px}button{padding:10px 16px;background:white;color:inherit;min-height:44px}button:hover:enabled{border-color:var(--blue)}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid #a5b9f0;outline-offset:3px}[hidden]{display:none!important}
.app{max-width:860px;margin:auto;height:100dvh;min-height:420px;display:flex;flex-direction:column;padding:0 28px}header{display:flex;align-items:center;gap:16px;padding:24px 0 18px}h1{font-size:25px;font-weight:650;letter-spacing:-1px;margin:0 auto 0 0}.status{font-size:13px;color:var(--muted);display:flex;align-items:center;gap:7px}.status:before{content:"";width:6px;height:6px;border-radius:50%;background:#9ba9bb}.status[data-state=connected]:before{background:var(--blue)}.quiet{background:transparent;border-color:transparent;padding:8px;font-size:13px}
.auth{padding:30px 0 24px;border-top:1px solid var(--line)}.auth label{display:block;font-weight:600;margin-bottom:10px}.auth-row{display:flex;gap:8px;max-width:520px}.auth input{min-width:0;flex:1;padding:12px;background:#fff}.hint{font-size:12px;color:var(--muted);margin:8px 0 0;line-height:1.5}.conversation{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}.transcript{overflow:auto;flex:1;padding:14px 4px 30px;scrollbar-gutter:stable}.empty{position:absolute;inset:18% 0 auto;pointer-events:none;font-size:clamp(24px,4vw,34px);font-weight:500;letter-spacing:-.9px;color:#657890;line-height:1.25;max-width:390px}.message{margin:0 0 30px;max-width:72ch}.speaker{font-size:12px;color:var(--muted);margin:0 0 8px;font-weight:600}.words{white-space:pre-wrap;overflow-wrap:anywhere;font-size:16px;line-height:1.65}.message[data-role=user]{padding-left:16px;border-left:2px solid #b9c9ed}.message[data-role=user] .words{color:#365078}.message-state{font-size:12px;color:var(--muted);margin:9px 0 0}
footer{border-top:1px solid var(--line);padding:14px 0 max(18px,env(safe-area-inset-bottom))}.notice{font-size:13px;color:#a23838;line-height:1.5;margin:0 0 10px;overflow-wrap:anywhere}.notice[data-kind=information]{color:var(--muted)}.composer{display:flex;gap:10px;align-items:flex-end}.composer textarea{resize:vertical;flex:1;min-width:0;min-height:72px;max-height:220px;padding:13px 15px;background:#fff;line-height:1.5}.actions{display:flex;flex-direction:column;gap:6px}.send{color:white;background:var(--blue);border-color:var(--blue)}.stop{font-size:13px;min-height:36px;padding:6px 16px}.retry{margin:0 0 12px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:520px){.app{padding:0 18px}header{padding-top:18px;gap:8px}.status{font-size:12px}h1{font-size:23px}.empty{inset:14% 0 auto;max-width:270px}.words{font-size:15px}.auth-row{flex-wrap:wrap}.auth input{flex-basis:100%}.auth button{width:100%}.composer{gap:8px}.composer textarea{padding:11px;min-height:96px}.actions button{padding-left:12px;padding-right:12px}.hint{font-size:11px}}
</style></head><body><div class="app">
<header><h1>yapd</h1><span id="status" class="status" role="status">Disconnected</span><button id="disconnect" class="quiet" type="button" hidden>Disconnect</button></header>
<form id="auth" class="auth" method="post"><label for="token">Connect to your conversation</label><div class="auth-row"><input id="token" type="password" placeholder="Connection token" autocomplete="off" spellcheck="false" aria-label="Connection token" required><button id="connect" type="submit" disabled>Connect</button></div><p class="hint">The token stays in this tab until you disconnect.</p></form>
<main class="conversation" aria-label="Conversation"><p id="empty" class="empty">What are we working on?</p><div id="transcript" class="transcript" tabindex="0" aria-label="Conversation messages"></div></main>
<footer><p id="notice" class="notice" role="alert" hidden></p><button id="retry" class="retry" type="button" hidden>Retry connection</button><form id="composer" class="composer"><label class="sr-only" for="draft">Message yapd</label><textarea id="draft" name="message" rows="2" placeholder="Ask, correct, or pick up where we left off." aria-describedby="keyboard" disabled></textarea><div class="actions"><button id="send" class="send" type="submit" disabled>Send</button><button id="stop" class="stop" type="button" disabled>Stop</button></div></form><p id="keyboard" class="hint">Enter to send. Shift + Enter for a new line.</p><p id="announcement" class="sr-only" aria-live="polite"></p></footer>
</div><script>${client}</script></body></html>`
