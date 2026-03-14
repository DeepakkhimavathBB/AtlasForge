const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const host = "0.0.0.0";
const port = process.env.PORT || 10000;
const publicDir = path.join(__dirname, "public");
const activeRequests = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

// ── Logger ────────────────────────────────────────────────────────────────────
// Every log line includes timestamp + live memory stats.
// Watch heapUsedMB in Render logs — if it keeps climbing, that is the leak.

function log(level, label, msg, extra) {
  const ts  = new Date().toISOString();
  const mem = process.memoryUsage();
  const memStr = `heap=${(mem.heapUsed  / 1024 / 1024).toFixed(1)}MB` +
                 ` rss=${(mem.rss       / 1024 / 1024).toFixed(1)}MB`;
  const extraStr = extra !== undefined ? " | " + JSON.stringify(extra) : "";
  const line = `[${ts}] [${level}] [${label}] ${msg}${extraStr} | ${memStr}`;
  if (level === "ERROR") console.error(line);
  else                   console.log(line);
}

// Periodic memory report every 60s — lets you spot leaks over time in Render logs
setInterval(() => {
  const mem = process.memoryUsage();
  log("INFO", "MEMORY", "Periodic check", {
    heapUsedMB:  (mem.heapUsed  / 1024 / 1024).toFixed(1),
    heapTotalMB: (mem.heapTotal / 1024 / 1024).toFixed(1),
    rssMB:       (mem.rss       / 1024 / 1024).toFixed(1),
    activeReqs:  activeRequests.size,
  });
}, 60_000).unref(); // .unref() so this timer never blocks process exit

// ── Helpers ───────────────────────────────────────────────────────────────────

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendNoContent(response) {
  response.writeHead(204, {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  });
  response.end();
}

function serveFile(filePath, response) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || "application/octet-stream";
  fs.readFile(filePath, (err, contents) => {
    if (err) {
      log("ERROR", "STATIC", `File not found: ${filePath}`);
      sendJson(response, 404, { error: "File not found" });
      return;
    }
    log("INFO", "STATIC", `Served: ${filePath}`);
    response.writeHead(200, { "Content-Type": contentType });
    response.end(contents);
  });
}

function collectBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        log("ERROR", "BODY", "Request body too large — destroying connection");
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });
    request.on("end",   () => resolve(body));
    request.on("error", (err) => {
      log("ERROR", "BODY", "Body read error: " + err.message);
      reject(err);
    });
  });
}

function sseWrite(response, data) {
  response.write("data: " + JSON.stringify(data) + "\n\n");
}

// ── Server-side think parser ──────────────────────────────────────────────────

class ServerThinkParser {
  constructor(onThinking, onReply) {
    this.onThinking = onThinking;
    this.onReply    = onReply;
    this.buf        = "";
    this.inThink    = false;
  }

  push(chunk) {
    this.buf += chunk;
    this._flush();
  }

  _flush() {
    const OPEN = "<think>", CLOSE = "</think>";
    while (this.buf.length > 0) {
      if (!this.inThink) {
        const openIdx = this.buf.indexOf(OPEN);
        if (openIdx === -1) {
          const partial = OPEN.split("").some((_, i) => this.buf.endsWith(OPEN.slice(0, i + 1)));
          if (partial) break;
          this.onReply(this.buf);
          this.buf = "";
        } else if (openIdx > 0) {
          this.onReply(this.buf.slice(0, openIdx));
          this.buf = this.buf.slice(openIdx);
        } else {
          this.inThink = true;
          this.buf = this.buf.slice(OPEN.length);
        }
      } else {
        const closeIdx = this.buf.indexOf(CLOSE);
        if (closeIdx !== -1) {
          if (closeIdx > 0) this.onThinking(this.buf.slice(0, closeIdx));
          this.buf = this.buf.slice(closeIdx + CLOSE.length).trimStart();
          this.inThink = false;
        } else {
          const safe = Math.max(0, this.buf.length - (CLOSE.length - 1));
          if (safe > 0) { this.onThinking(this.buf.slice(0, safe)); this.buf = this.buf.slice(safe); }
          break;
        }
      }
    }
  }

  flush() {
    if (!this.buf) return;
    if (this.inThink) this.onThinking(this.buf);
    else              this.onReply(this.buf);
    this.buf = "";
  }

  // Free internal buffer — call after flush() when done
  destroy() {
    this.buf = "";
  }
}

// ── Opencode spawn ────────────────────────────────────────────────────────────

function spawnOpencode(args) {
  // opencode.cmd on Windows, opencode on Linux/Render
  const cmd = process.platform === "win32" ? "opencode.cmd" : "opencode";
  log("INFO", "SPAWN", `cmd=${cmd} args=${args.join(" ")}`);

  return spawn(cmd, args, {
    cwd: __dirname,
    env: {
      ...process.env,
      NO_COLOR:             "1",
      CI:                   "true",  // prevents interactive prompts
      OPENCODE_INTERACTIVE: "false", // fully non-interactive
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

// ── Streaming: opencode/big-pickle ────────────────────────────────────────────
// Both "opencode" and "codex" model selections route here.
// opencode/big-pickle = free, no auth needed, reasoning support.

function streamOpencode({ message, threadId, requestId, response }) {
  return new Promise((resolve) => {
    const args = ["run", "--format", "json", "--thinking", "--model", "opencode/big-pickle"];
    if (threadId) { args.push("--session", threadId); }
    args.push(message);

    log("INFO", "STREAM", "Starting", { requestId, threadId: threadId || "new" });

    const child = spawnOpencode(args);
    activeRequests.set(requestId, child);
    log("INFO", "STREAM", `Process spawned. Active requests: ${activeRequests.size}`, { requestId });

    let sessionId   = "";
    let lineBuf     = "";
    let doneSent    = false;
    let replyCount  = 0;
    let thinkCount  = 0;

    const parser = new ServerThinkParser(
      (chunk) => { thinkCount++; sseWrite(response, { type: "thinking", text: chunk }); },
      (chunk) => { replyCount++;  sseWrite(response, { type: "reply",    text: chunk }); },
    );

    function processLine(line) {
      const trimmed = line.trim();
      if (!trimmed) return;
      let ev;
      try { ev = JSON.parse(trimmed); } catch { return; }

      if (!sessionId && ev.sessionID) {
        sessionId = String(ev.sessionID);
        log("INFO", "STREAM", `Session assigned: ${sessionId}`, { requestId });
      }

      if (ev.type === "text" && ev.part && ev.part.text) {
        parser.push(String(ev.part.text));
      }

      if (ev.type === "reasoning" && ev.part && ev.part.text) {
        thinkCount++;
        sseWrite(response, { type: "thinking", text: ev.part.text });
      }

      if (ev.type === "step_finish" && !doneSent) {
        parser.flush();
        doneSent = true;
        const usage = (ev.part && ev.part.tokens) ? ev.part.tokens : null;
        log("INFO", "STREAM", "Step finished", { requestId, sessionId, replyCount, thinkCount, usage });
        sseWrite(response, { type: "done", threadId: sessionId, usage });
      }

      if (ev.type === "error") {
        const realError = ev.message || (ev.error && ev.error.message) || JSON.stringify(ev);
        log("ERROR", "STREAM", `Opencode error event: ${realError}`, { requestId });
        sseWrite(response, { type: "error", message: realError });
      }
    }

    child.stdout.on("data", (chunk) => {
      lineBuf += chunk.toString();
      const lines = lineBuf.split(/\r?\n/);
      lineBuf = lines.pop(); // keep only incomplete tail — rest is processed immediately
      for (const line of lines) processLine(line);
    });

    child.stderr.on("data", (chunk) => {
      // Truncate stderr to 300 chars max to avoid log flooding
      log("ERROR", "STREAM", `stderr: ${chunk.toString().slice(0, 300)}`, { requestId });
    });

    child.on("error", (err) => {
      log("ERROR", "STREAM", `Spawn failed: ${err.message}`, { requestId });
      activeRequests.delete(requestId);
      log("INFO", "STREAM", `Active requests: ${activeRequests.size}`);
      lineBuf = "";       // free line buffer
      parser.destroy();   // free parser buffer
      sseWrite(response, { type: "error", message: "Failed to spawn opencode: " + err.message });
      resolve();
    });

    child.on("close", (code) => {
      log("INFO", "STREAM", `Process closed (exit ${code})`, { requestId, sessionId });
      activeRequests.delete(requestId);
      log("INFO", "STREAM", `Active requests: ${activeRequests.size}`);

      if (lineBuf.trim()) processLine(lineBuf);
      lineBuf = "";     // free line buffer
      parser.flush();
      parser.destroy(); // free parser buffer

      if (!doneSent) {
        doneSent = true;
        log("INFO", "STREAM", "No step_finish received — sending done anyway", { requestId });
        sseWrite(response, { type: "done", threadId: sessionId, usage: null });
      }
      resolve();
    });
  });
}

// "codex" kept for backwards compatibility — routes to opencode/big-pickle
function streamCodex({ message, threadId, requestId, response }) {
  log("INFO", "ROUTE", "codex → streamOpencode (opencode/big-pickle)", { requestId });
  return streamOpencode({ message, threadId, requestId, response });
}

// ── Streaming endpoint: POST /api/chat/stream ─────────────────────────────────

async function handleChatStream(request, response) {
  log("INFO", "HIT", "POST /api/chat/stream");

  let rawBody;
  try { rawBody = await collectBody(request); }
  catch (e) {
    log("ERROR", "CHAT_STREAM", `collectBody failed: ${e.message}`);
    sendJson(response, 400, { error: e.message });
    return;
  }

  let payload;
  try { payload = JSON.parse(rawBody || "{}"); }
  catch (e) {
    log("ERROR", "CHAT_STREAM", "Invalid JSON body");
    sendJson(response, 400, { error: "Invalid JSON body" });
    return;
  }

  const message   = String(payload.message   || "").trim();
  const threadId  = String(payload.threadId  || "").trim();
  const model     = String(payload.model     || "codex").trim();
  const requestId = String(payload.requestId || "").trim() || crypto.randomUUID();

  log("INFO", "CHAT_STREAM", "Payload parsed", { requestId, model, threadId: threadId || "new", msgLen: message.length });

  if (!message) {
    log("ERROR", "CHAT_STREAM", "Empty message — rejected", { requestId });
    sendJson(response, 400, { error: "Message is required." });
    return;
  }

  response.writeHead(200, {
    "Content-Type":                "text/event-stream; charset=utf-8",
    "Cache-Control":               "no-cache",
    "Connection":                  "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering":           "no",
  });

  // Kill child if client disconnects — prevents zombie processes leaking memory
  request.on("close", () => {
    const proc = activeRequests.get(requestId);
    if (proc) {
      log("INFO", "CHAT_STREAM", "Client disconnected — killing child process", { requestId });
      try { proc.kill(); } catch {}
      activeRequests.delete(requestId);
      log("INFO", "CHAT_STREAM", `Active requests: ${activeRequests.size}`);
    }
  });

  try {
    if (model === "opencode") {
      log("INFO", "ROUTE", "→ streamOpencode", { requestId });
      await streamOpencode({ message, threadId, requestId, response });
    } else {
      log("INFO", "ROUTE", "→ streamCodex (opencode/big-pickle)", { requestId });
      await streamCodex({ message, threadId, requestId, response });
    }
  } catch (error) {
    log("ERROR", "CHAT_STREAM", `Unhandled: ${error.message}`, { requestId });
    sseWrite(response, { type: "error", message: error.message });
  }

  log("INFO", "CHAT_STREAM", "Stream ended, closing response", { requestId });
  response.end();
}

// ── Non-streaming endpoint: POST /api/chat (legacy fallback) ──────────────────

async function handleChat(request, response) {
  log("INFO", "HIT", "POST /api/chat (non-streaming)");
  try {
    const rawBody = await collectBody(request);
    const payload = JSON.parse(rawBody || "{}");
    const message   = String(payload.message   || "").trim();
    const threadId  = String(payload.threadId  || "").trim();
    const model     = String(payload.model     || "codex").trim();
    const requestId = String(payload.requestId || "").trim() || crypto.randomUUID();

    log("INFO", "CHAT", "Payload parsed", { requestId, model, threadId: threadId || "new", msgLen: message.length });

    if (!message) {
      log("ERROR", "CHAT", "Empty message — rejected", { requestId });
      sendJson(response, 400, { error: "Message is required." });
      return;
    }

    const result = model === "opencode"
      ? await runOpencodeChat({ message, threadId, requestId })
      : await runCodexChat({ message, threadId, requestId });

    log("INFO", "CHAT", "Response ready", { requestId });
    sendJson(response, 200, { ...result, requestId });
  } catch (error) {
    const statusCode = error.code === "REQUEST_CANCELLED" ? 499 : 500;
    log("ERROR", "CHAT", `Error: ${error.message}`);
    sendJson(response, statusCode, {
      error:   "Unable to process the message.",
      details: error.message,
      code:    error.code || "REQUEST_FAILED",
    });
  }
}

// ── Non-streaming: opencode ───────────────────────────────────────────────────

function runOpencodeChat({ message, threadId, requestId }) {
  return new Promise((resolve, reject) => {
    const args = ["run", "--format", "json", "--thinking", "--model", "opencode/big-pickle"];
    if (threadId) { args.push("--session", threadId); }
    args.push(message);

    log("INFO", "RUN", "Starting", { requestId, model: "opencode/big-pickle" });

    const child = spawnOpencode(args);
    activeRequests.set(requestId, child);
    log("INFO", "RUN", `Active requests: ${activeRequests.size}`, { requestId });

    // Collect stdout as Buffer chunks — join once at end, avoids repeated string concat
    const stdoutChunks = [];

    child.stdout.on("data", (chunk) => { stdoutChunks.push(chunk); });

    child.stderr.on("data", (chunk) => {
      log("ERROR", "RUN", `stderr: ${chunk.toString().slice(0, 300)}`, { requestId });
    });

    child.on("error", (err) => {
      log("ERROR", "RUN", `Spawn failed: ${err.message}`, { requestId });
      activeRequests.delete(requestId);
      log("INFO", "RUN", `Active requests: ${activeRequests.size}`);
      stdoutChunks.length = 0; // free memory
      reject(new Error("Failed to spawn opencode: " + err.message));
    });

    child.on("close", (code) => {
      log("INFO", "RUN", `Process closed (exit ${code})`, { requestId });
      activeRequests.delete(requestId);
      log("INFO", "RUN", `Active requests: ${activeRequests.size}`);

      const stdoutBuf = Buffer.concat(stdoutChunks).toString(); // join once
      stdoutChunks.length = 0; // free chunk array immediately

      try {
        const result = parseOpencodeEvents(stdoutBuf);
        if (result) {
          log("INFO", "RUN", "Parse success", { requestId, sessionId: result.threadId });
          resolve(result);
        } else {
          log("ERROR", "RUN", "No parseable reply", { requestId, preview: stdoutBuf.slice(0, 200) });
          reject(new Error("Opencode returned no parseable reply. stdout: " + stdoutBuf.slice(0, 500)));
        }
      } catch (e) {
        log("ERROR", "RUN", `Parse error: ${e.message}`, { requestId });
        reject(e);
      }
    });
  });
}

function parseOpencodeEvents(raw) {
  let reply = "", sessionId = "", usage = null, thinking = "";
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev;
    try { ev = JSON.parse(trimmed); } catch { continue; }
    if (!sessionId && ev.sessionID)                               sessionId = String(ev.sessionID);
    if (ev.type === "text"        && ev.part && ev.part.text)     reply    += String(ev.part.text);
    if (ev.type === "reasoning"   && ev.part && ev.part.text)     thinking += String(ev.part.text);
    if (ev.type === "step_finish" && ev.part && ev.part.tokens)   usage     = ev.part.tokens;
    if (ev.type === "step_finish") return { threadId: sessionId, reply, usage, thinking };
    if (ev.type === "error") throw new Error(ev.message || "Opencode error event");
  }
  if (reply.trim()) return { threadId: sessionId, reply: reply.trim(), usage: null };
  return null;
}

// "codex" kept for backwards compatibility — routes to opencode/big-pickle
function runCodexChat({ message, threadId, requestId }) {
  log("INFO", "ROUTE", "codex → runOpencodeChat (opencode/big-pickle)", { requestId });
  return runOpencodeChat({ message, threadId, requestId });
}

// ── Cancel endpoint: POST /api/chat/cancel ────────────────────────────────────

function handleCancel(request, response) {
  log("INFO", "HIT", "POST /api/chat/cancel");
  collectBody(request).then((rawBody) => {
    const payload   = JSON.parse(rawBody || "{}");
    const requestId = String(payload.requestId || "").trim();

    if (!requestId) {
      log("ERROR", "CANCEL", "Missing requestId");
      sendJson(response, 400, { error: "requestId is required." });
      return;
    }

    const proc = activeRequests.get(requestId);
    if (!proc) {
      log("INFO", "CANCEL", "Request not found (already done?)", { requestId });
      sendJson(response, 404, { error: "Active request not found." });
      return;
    }

    try { proc.kill(); } catch {}
    activeRequests.delete(requestId);
    log("INFO", "CANCEL", "Cancelled OK", { requestId, activeRequestsNow: activeRequests.size });
    sendJson(response, 200, { ok: true, requestId });
  }).catch((e) => {
    log("ERROR", "CANCEL", `Error: ${e.message}`);
    sendJson(response, 500, { error: e.message });
  });
}

// ── Reset endpoint: DELETE /api/chat ─────────────────────────────────────────

function handleReset(response) {
  log("INFO", "HIT", "DELETE /api/chat (reset)");
  sendJson(response, 200, { ok: true });
}

// ── Router ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "OPTIONS") {
    log("INFO", "ROUTER", `OPTIONS preflight: ${requestUrl.pathname}`);
    sendNoContent(response);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/chat/stream") {
    await handleChatStream(request, response); return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/chat") {
    await handleChat(request, response); return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/chat/cancel") {
    handleCancel(request, response); return;
  }

  if (request.method === "DELETE" && requestUrl.pathname === "/api/chat") {
    handleReset(response); return;
  }

  if (request.method !== "GET") {
    log("INFO", "ROUTER", `405 Method Not Allowed: ${request.method} ${requestUrl.pathname}`);
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  // Static file serving
  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const safePath = path.normalize(path.join(publicDir, pathname));
  if (!safePath.startsWith(publicDir)) {
    log("ERROR", "STATIC", `Path traversal blocked: ${requestUrl.pathname}`);
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  serveFile(safePath, response);
});

// Catch unexpected server-level errors
server.on("error", (err) => {
  log("ERROR", "SERVER", `Server error: ${err.message}`);
});

server.listen(port, host, () => {
  log("INFO", "SERVER", `AtlasForge running at http://${host}:${port}`);
  log("INFO", "SERVER", `Platform: ${process.platform} | Node: ${process.version}`);
  log("INFO", "SERVER", `Public dir: ${publicDir}`);
});
