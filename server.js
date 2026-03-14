const http = require("http");
const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const host      = "0.0.0.0";
const port      = process.env.PORT || 10000;
const publicDir = path.join(__dirname, "public");
const activeRequests = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

// ── Logger ────────────────────────────────────────────────────────────────────
// Every line shows timestamp + heap/rss — watch heapUsedMB for leaks in Render.

function log(level, label, msg, extra) {
  const ts     = new Date().toISOString();
  const mem    = process.memoryUsage();
  const memStr = `heap=${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB rss=${(mem.rss / 1024 / 1024).toFixed(1)}MB`;
  const ext    = extra !== undefined ? " | " + JSON.stringify(extra) : "";
  const line   = `[${ts}] [${level}] [${label}] ${msg}${ext} | ${memStr}`;
  if (level === "ERROR") console.error(line);
  else                   console.log(line);
}

// Periodic memory report every 60s
setInterval(() => {
  const m = process.memoryUsage();
  log("INFO", "MEMORY", "Periodic check", {
    heapUsedMB:  (m.heapUsed  / 1024 / 1024).toFixed(1),
    heapTotalMB: (m.heapTotal / 1024 / 1024).toFixed(1),
    rssMB:       (m.rss       / 1024 / 1024).toFixed(1),
    activeReqs:  activeRequests.size,
  });
}, 60_000).unref();

// ── Helpers ───────────────────────────────────────────────────────────────────

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendNoContent(res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  });
  res.end();
}

function serveFile(filePath, res) {
  const ext         = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || "application/octet-stream";
  fs.readFile(filePath, (err, data) => {
    if (err) {
      log("ERROR", "STATIC", `Not found: ${filePath}`);
      sendJson(res, 404, { error: "File not found" });
      return;
    }
    log("INFO", "STATIC", `Served: ${filePath}`);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        log("ERROR", "BODY", "Request too large — destroying");
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end",   () => resolve(body));
    req.on("error", (err) => { log("ERROR", "BODY", err.message); reject(err); });
  });
}

function sseWrite(res, data) {
  res.write("data: " + JSON.stringify(data) + "\n\n");
}

// ── ThinkParser ───────────────────────────────────────────────────────────────

class ServerThinkParser {
  constructor(onThinking, onReply) {
    this.onThinking = onThinking;
    this.onReply    = onReply;
    this.buf        = "";
    this.inThink    = false;
  }
  push(chunk) { this.buf += chunk; this._flush(); }
  _flush() {
    const OPEN = "<think>", CLOSE = "</think>";
    while (this.buf.length > 0) {
      if (!this.inThink) {
        const oi = this.buf.indexOf(OPEN);
        if (oi === -1) {
          const partial = OPEN.split("").some((_, i) => this.buf.endsWith(OPEN.slice(0, i + 1)));
          if (partial) break;
          this.onReply(this.buf); this.buf = "";
        } else if (oi > 0) {
          this.onReply(this.buf.slice(0, oi)); this.buf = this.buf.slice(oi);
        } else {
          this.inThink = true; this.buf = this.buf.slice(OPEN.length);
        }
      } else {
        const ci = this.buf.indexOf(CLOSE);
        if (ci !== -1) {
          if (ci > 0) this.onThinking(this.buf.slice(0, ci));
          this.buf = this.buf.slice(ci + CLOSE.length).trimStart();
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
  destroy() { this.buf = ""; }
}

// ── Opencode spawn ────────────────────────────────────────────────────────────

function spawnOpencode(args) {
  const cmd = process.platform === "win32" ? "opencode.cmd" : "opencode";
  log("INFO", "SPAWN", `${cmd} ${args.join(" ")}`);
  return spawn(cmd, args, {
    cwd: __dirname,
    env: {
      ...process.env,
      NO_COLOR:             "1",
      CI:                   "true",   // no interactive prompts
      OPENCODE_INTERACTIVE: "false",  // fully headless
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

// ── Streaming: opencode/big-pickle ────────────────────────────────────────────
// Both "opencode" and "codex" selections route here.
// opencode/big-pickle = free, no auth, reasoning support.

function streamOpencode({ message, threadId, requestId, response }) {
  return new Promise((resolve) => {
    const args = ["run", "--format", "json", "--thinking", "--model", "opencode/big-pickle"];
    if (threadId) { args.push("--session", threadId); }
    args.push(message);

    log("INFO", "STREAM", "Starting", { requestId, threadId: threadId || "new" });

    const child = spawnOpencode(args);
    activeRequests.set(requestId, child);
    log("INFO", "STREAM", `Spawned. Active: ${activeRequests.size}`, { requestId });

    // ✅ Kill after 90s if opencode hangs — prevents Render 502s
    const killer = setTimeout(() => {
      log("ERROR", "STREAM", "Timed out (120s) — killing process", { requestId });
      try { child.kill("SIGKILL"); } catch {}
    }, 120_000); // 2 min — free tier needs extra time on cold start

    let sessionId  = "";
    let lineBuf    = "";
    let doneSent   = false;
    let replyCount = 0;
    let thinkCount = 0;

    const parser = new ServerThinkParser(
      (chunk) => { thinkCount++; sseWrite(response, { type: "thinking", text: chunk }); },
      (chunk) => { replyCount++;  sseWrite(response, { type: "reply",    text: chunk }); },
    );

    function processLine(line) {
      const t = line.trim();
      if (!t) return;
      let ev;
      try { ev = JSON.parse(t); } catch { return; }

      if (!sessionId && ev.sessionID) {
        sessionId = String(ev.sessionID);
        log("INFO", "STREAM", `Session: ${sessionId}`, { requestId });
      }
      if (ev.type === "text"      && ev.part?.text) parser.push(String(ev.part.text));
      if (ev.type === "reasoning" && ev.part?.text) { thinkCount++; sseWrite(response, { type: "thinking", text: ev.part.text }); }
      if (ev.type === "step_finish" && !doneSent) {
        parser.flush();
        doneSent = true;
        const usage = ev.part?.tokens ?? null;
        log("INFO", "STREAM", "Done", { requestId, sessionId, replyCount, thinkCount, usage });
        sseWrite(response, { type: "done", threadId: sessionId, usage });
      }
      if (ev.type === "error") {
        const msg = ev.message || ev.error?.message || JSON.stringify(ev);
        log("ERROR", "STREAM", `Opencode error: ${msg}`, { requestId });
        sseWrite(response, { type: "error", message: msg });
      }
    }

    child.stdout.on("data", (chunk) => {
      lineBuf += chunk.toString();
      const lines = lineBuf.split(/\r?\n/);
      lineBuf = lines.pop(); // keep incomplete tail only
      for (const line of lines) processLine(line);
    });

    child.stderr.on("data", (chunk) => {
      log("ERROR", "STREAM", `stderr: ${chunk.toString().slice(0, 300)}`, { requestId });
    });

    child.on("error", (err) => {
      clearTimeout(killer);
      log("ERROR", "STREAM", `Spawn error: ${err.message}`, { requestId });
      activeRequests.delete(requestId);
      log("INFO", "STREAM", `Active: ${activeRequests.size}`);
      lineBuf = ""; parser.destroy();
      sseWrite(response, { type: "error", message: "Failed to spawn opencode: " + err.message });
      resolve();
    });

    child.on("close", (code) => {
      clearTimeout(killer); // ✅ always clear timeout
      log("INFO", "STREAM", `Closed (exit ${code})`, { requestId, sessionId });
      activeRequests.delete(requestId);
      log("INFO", "STREAM", `Active: ${activeRequests.size}`);
      if (lineBuf.trim()) processLine(lineBuf);
      lineBuf = "";
      parser.flush();
      parser.destroy();
      if (!doneSent) {
        doneSent = true;
        log("INFO", "STREAM", "No step_finish — sending done anyway", { requestId });
        sseWrite(response, { type: "done", threadId: sessionId, usage: null });
      }
      resolve();
    });
  });
}

// "codex" → opencode/big-pickle (backwards compat)
function streamCodex(opts) {
  log("INFO", "ROUTE", "codex → streamOpencode", { requestId: opts.requestId });
  return streamOpencode(opts);
}

// ── Streaming endpoint ────────────────────────────────────────────────────────

async function handleChatStream(req, res) {
  log("INFO", "HIT", "POST /api/chat/stream");

  let rawBody;
  try { rawBody = await collectBody(req); }
  catch (e) { log("ERROR", "CHAT_STREAM", e.message); sendJson(res, 400, { error: e.message }); return; }

  let payload;
  try { payload = JSON.parse(rawBody || "{}"); }
  catch (e) { log("ERROR", "CHAT_STREAM", "Bad JSON"); sendJson(res, 400, { error: "Invalid JSON body" }); return; }

  const message   = String(payload.message   || "").trim();
  const threadId  = String(payload.threadId  || "").trim();
  const model     = String(payload.model     || "codex").trim();
  const requestId = String(payload.requestId || "").trim() || crypto.randomUUID();

  log("INFO", "CHAT_STREAM", "Parsed", { requestId, model, threadId: threadId || "new", msgLen: message.length });

  if (!message) {
    log("ERROR", "CHAT_STREAM", "Empty message", { requestId });
    sendJson(res, 400, { error: "Message is required." });
    return;
  }

  res.writeHead(200, {
    "Content-Type":                "text/event-stream; charset=utf-8",
    "Cache-Control":               "no-cache",
    "Connection":                  "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering":           "no",
  });

  // ✅ Kill child if client disconnects — no zombie processes
  req.on("close", () => {
    const proc = activeRequests.get(requestId);
    if (proc) {
      log("INFO", "CHAT_STREAM", "Client disconnected — killing child", { requestId });
      try { proc.kill(); } catch {}
      activeRequests.delete(requestId);
      log("INFO", "CHAT_STREAM", `Active: ${activeRequests.size}`);
    }
  });

  try {
    if (model === "opencode") {
      log("INFO", "ROUTE", "→ streamOpencode", { requestId });
      await streamOpencode({ message, threadId, requestId, response: res });
    } else {
      log("INFO", "ROUTE", "→ streamCodex (opencode/big-pickle)", { requestId });
      await streamCodex({ message, threadId, requestId, response: res });
    }
  } catch (err) {
    log("ERROR", "CHAT_STREAM", `Unhandled: ${err.message}`, { requestId });
    sseWrite(res, { type: "error", message: err.message });
  }

  log("INFO", "CHAT_STREAM", "Stream ended", { requestId });
  res.end();
}

// ── Non-streaming endpoint (legacy) ──────────────────────────────────────────

async function handleChat(req, res) {
  log("INFO", "HIT", "POST /api/chat (non-streaming)");
  try {
    const rawBody   = await collectBody(req);
    const payload   = JSON.parse(rawBody || "{}");
    const message   = String(payload.message   || "").trim();
    const threadId  = String(payload.threadId  || "").trim();
    const model     = String(payload.model     || "codex").trim();
    const requestId = String(payload.requestId || "").trim() || crypto.randomUUID();

    log("INFO", "CHAT", "Parsed", { requestId, model, msgLen: message.length });

    if (!message) { sendJson(res, 400, { error: "Message is required." }); return; }

    const result = model === "opencode"
      ? await runOpencodeChat({ message, threadId, requestId })
      : await runCodexChat({ message, threadId, requestId });

    log("INFO", "CHAT", "Done", { requestId });
    sendJson(res, 200, { ...result, requestId });
  } catch (err) {
    const status = err.code === "REQUEST_CANCELLED" ? 499 : 500;
    log("ERROR", "CHAT", err.message);
    sendJson(res, status, { error: "Unable to process the message.", details: err.message, code: err.code || "REQUEST_FAILED" });
  }
}

// ── Non-streaming: opencode ───────────────────────────────────────────────────

function runOpencodeChat({ message, threadId, requestId }) {
  return new Promise((resolve, reject) => {
    const args = ["run", "--format", "json", "--thinking", "--model", "opencode/big-pickle"];
    if (threadId) { args.push("--session", threadId); }
    args.push(message);

    log("INFO", "RUN", "Starting", { requestId });

    const child = spawnOpencode(args);
    activeRequests.set(requestId, child);
    log("INFO", "RUN", `Active: ${activeRequests.size}`, { requestId });

    // ✅ Kill after 90s if hanging
    const killer = setTimeout(() => {
      log("ERROR", "RUN", "Timed out (120s) — killing", { requestId });
      try { child.kill("SIGKILL"); } catch {}
    }, 120_000); // 2 min — free tier needs extra time on cold start

    const chunks = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => log("ERROR", "RUN", `stderr: ${c.toString().slice(0, 300)}`, { requestId }));

    child.on("error", (err) => {
      clearTimeout(killer);
      activeRequests.delete(requestId);
      log("ERROR", "RUN", `Spawn error: ${err.message}`, { requestId });
      chunks.length = 0;
      reject(new Error("Failed to spawn opencode: " + err.message));
    });

    child.on("close", (code) => {
      clearTimeout(killer);
      activeRequests.delete(requestId);
      log("INFO", "RUN", `Closed (exit ${code})`, { requestId });

      const raw = Buffer.concat(chunks).toString();
      chunks.length = 0;

      try {
        const result = parseOpencodeEvents(raw);
        if (result) { log("INFO", "RUN", "Parse OK", { requestId }); resolve(result); }
        else { log("ERROR", "RUN", "No parseable reply", { requestId }); reject(new Error("Opencode returned no reply. stdout: " + raw.slice(0, 500))); }
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
    const t = line.trim();
    if (!t) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; }
    if (!sessionId && ev.sessionID)                             sessionId = String(ev.sessionID);
    if (ev.type === "text"        && ev.part?.text)             reply    += String(ev.part.text);
    if (ev.type === "reasoning"   && ev.part?.text)             thinking += String(ev.part.text);
    if (ev.type === "step_finish" && ev.part?.tokens)           usage     = ev.part.tokens;
    if (ev.type === "step_finish") return { threadId: sessionId, reply, usage, thinking };
    if (ev.type === "error") throw new Error(ev.message || "Opencode error event");
  }
  if (reply.trim()) return { threadId: sessionId, reply: reply.trim(), usage: null };
  return null;
}

// "codex" → opencode/big-pickle (backwards compat)
function runCodexChat({ message, threadId, requestId }) {
  log("INFO", "ROUTE", "codex → runOpencodeChat", { requestId });
  return runOpencodeChat({ message, threadId, requestId });
}

// ── Cancel endpoint ───────────────────────────────────────────────────────────

function handleCancel(req, res) {
  log("INFO", "HIT", "POST /api/chat/cancel");
  collectBody(req).then((raw) => {
    const { requestId } = JSON.parse(raw || "{}");
    if (!requestId) { sendJson(res, 400, { error: "requestId is required." }); return; }
    const proc = activeRequests.get(requestId);
    if (!proc)  { log("INFO", "CANCEL", "Not found", { requestId }); sendJson(res, 404, { error: "Not found." }); return; }
    try { proc.kill(); } catch {}
    activeRequests.delete(requestId);
    log("INFO", "CANCEL", "Cancelled", { requestId, active: activeRequests.size });
    sendJson(res, 200, { ok: true, requestId });
  }).catch((e) => { log("ERROR", "CANCEL", e.message); sendJson(res, 500, { error: e.message }); });
}

// ── Reset endpoint ────────────────────────────────────────────────────────────

function handleReset(res) {
  log("INFO", "HIT", "DELETE /api/chat (reset)");
  sendJson(res, 200, { ok: true });
}

// ── Router ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") { sendNoContent(res); return; }

  if (req.method === "POST"   && url.pathname === "/api/chat/stream")  { await handleChatStream(req, res); return; }
  if (req.method === "POST"   && url.pathname === "/api/chat")         { await handleChat(req, res);       return; }
  if (req.method === "POST"   && url.pathname === "/api/chat/cancel")  { handleCancel(req, res);           return; }
  if (req.method === "DELETE" && url.pathname === "/api/chat")         { handleReset(res);                 return; }

  if (req.method !== "GET") {
    log("INFO", "ROUTER", `405: ${req.method} ${url.pathname}`);
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = path.normalize(path.join(publicDir, pathname));
  if (!safePath.startsWith(publicDir)) {
    log("ERROR", "STATIC", `Path traversal blocked: ${url.pathname}`);
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  serveFile(safePath, res);
});

server.on("error", (err) => log("ERROR", "SERVER", err.message));

server.listen(port, host, () => {
  log("INFO", "SERVER", `AtlasForge running at http://${host}:${port}`);
  log("INFO", "SERVER", `Platform: ${process.platform} | Node: ${process.version}`);
  log("INFO", "SERVER", `Public dir: ${publicDir}`);
});
