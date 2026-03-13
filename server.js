const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");

const host = "0.0.0.0";
const port = process.env.PORT || 10000;
const publicDir = path.join(__dirname, "public");
const bridgeScriptPath = path.join(__dirname, "scripts", "codex-bridge.ps1");
const activeRequests = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

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
    if (err) { sendJson(response, 404, { error: "File not found" }); return; }
    response.writeHead(200, { "Content-Type": contentType });
    response.end(contents);
  });
}

function collectBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) { reject(new Error("Request body too large")); request.destroy(); }
    });
    request.on("end",   () => resolve(body));
    request.on("error", reject);
  });
}

function sseWrite(response, data) {
  response.write("data: " + JSON.stringify(data) + "\n\n");
}

// ── Server-side think parser ──────────────────────────────────────────────────
// Splits opencode text output into <think>...</think> (thinking) vs reply chunks.
// Handles multiple <think> blocks and partial tag boundaries across chunks.
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
          // No <think> tag — check if tail could be a partial opening tag
          const partial = OPEN.split("").some((_, i) => this.buf.endsWith(OPEN.slice(0, i + 1)));
          if (partial) break; // wait for more data
          this.onReply(this.buf);
          this.buf = "";
        } else if (openIdx > 0) {
          // Text before <think> is reply content
          this.onReply(this.buf.slice(0, openIdx));
          this.buf = this.buf.slice(openIdx);
        } else {
          // buf starts with <think>
          this.inThink = true;
          this.buf = this.buf.slice(OPEN.length);
        }
      } else {
        const closeIdx = this.buf.indexOf(CLOSE);
        if (closeIdx !== -1) {
          if (closeIdx > 0) this.onThinking(this.buf.slice(0, closeIdx));
          this.buf = this.buf.slice(closeIdx + CLOSE.length).trimStart();
          this.inThink = false;
          // Loop continues — handles multiple <think> blocks in one pass
        } else {
          // Safe to emit everything except the last (CLOSE.length - 1) chars
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
}

// ── Opencode path ─────────────────────────────────────────────────────────────

const opencodeBin = path.join(
  os.homedir(), "AppData", "Roaming", "npm",
  "node_modules", "opencode-ai", "bin", "opencode"
);

// ── Opencode path ─────────────────────────────────────────────────────────────

function spawnOpencode(args) {
  const apiKey = process.env.OPENCODE_API_KEY;
  
  const isWindows = process.platform === "win32";
  const opencodeCmd = isWindows ? "opencode.cmd" : "opencode";

  console.log("🔍 Spawning OpenCode with args:", args);
  console.log("🔑 API Key present:", !!apiKey);
  
  return spawn(opencodeCmd, args, {
    cwd: __dirname, // <--- CHANGED THIS from os.homedir()
    env: { 
      ...process.env, 
      NO_COLOR: "1",
      OPENCODE_API_KEY: apiKey,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}
// ── Streaming: opencode ───────────────────────────────────────────────────────

function streamOpencode({ message, threadId, requestId, response }) {
  return new Promise((resolve) => {
    const args = ["run", "--format", "json", "--thinking"];
    if (threadId) { args.push("--session", threadId); }
    args.push(message);

    const child = spawnOpencode(args);
    activeRequests.set(requestId, child);

    let sessionId = "";
    let lineBuf   = "";
    let doneSent  = false;

    const parser = new ServerThinkParser(
      (chunk) => sseWrite(response, { type: "thinking", text: chunk }),
      (chunk) => sseWrite(response, { type: "reply",    text: chunk }),
    );

    function processLine(line) {
      const trimmed = line.trim();
      if (!trimmed) return;
      let ev;
      try { ev = JSON.parse(trimmed); } catch { return; }

      if (!sessionId && ev.sessionID) sessionId = String(ev.sessionID);

      if (ev.type === "text" && ev.part && ev.part.text) {
        parser.push(String(ev.part.text));
      }

      if (ev.type === "reasoning" && ev.part && ev.part.text) {
        sseWrite(response, { type: "thinking", text: ev.part.text });
      }

      if (ev.type === "step_finish" && !doneSent) {
        parser.flush();
        doneSent = true;
        sseWrite(response, {
          type:     "done",
          threadId: sessionId,
          usage:    (ev.part && ev.part.tokens) ? ev.part.tokens : null,
        });
      }

      if (ev.type === "error") {
        console.error("❌ Opencode JSON Error:", ev);
        // This grabs the REAL error reason instead of a generic fallback
        const realError = ev.message || (ev.error && ev.error.message) || JSON.stringify(ev);
        sseWrite(response, { type: "error", message: realError });
      }
    }

    child.stdout.on("data", (chunk) => {
      lineBuf += chunk.toString();
      const lines = lineBuf.split(/\r?\n/);
      lineBuf = lines.pop(); // keep incomplete tail
      for (const line of lines) processLine(line);
    });

// Log stderr for debugging
child.stderr.on("data", (data) => {
  console.error("❌ OpenCode stderr:", data.toString());
});
    child.on("error", (err) => {
      activeRequests.delete(requestId);
      sseWrite(response, { type: "error", message: "Failed to spawn opencode: " + err.message });
      resolve();
    });

    child.on("close", () => {
      activeRequests.delete(requestId);
      // Flush any partial line left in buffer
      if (lineBuf.trim()) processLine(lineBuf);
      // Flush parser in case step_finish never arrived
      parser.flush();
      // Send done if step_finish event never came
      if (!doneSent) {
        doneSent = true;
        sseWrite(response, { type: "done", threadId: sessionId, usage: null });
      }
      resolve();
    });
  });
}

// ── Streaming: codex ──────────────────────────────────────────────────────────

function streamCodex({ message, threadId, requestId, response }) {
  return new Promise((resolve) => {
    const requestFile = path.join(
      os.tmpdir(),
      `atlasforge-codex-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
    );

    fs.writeFile(requestFile, JSON.stringify({ message, threadId }), "utf8", (writeErr) => {
      if (writeErr) {
        sseWrite(response, { type: "error", message: writeErr.message });
        resolve();
        return;
      }

      const child = execFile(
        "powershell.exe",
        ["-NoLogo", "-NonInteractive", "-NoProfile", "-ExecutionPolicy", "Bypass",
         "-File", bridgeScriptPath, "-RequestFile", requestFile],
        {
          cwd: os.homedir(),
          env: { ...process.env, NO_COLOR: "1" },
          windowsHide: true,
          timeout: 10 * 60 * 1000,
          maxBuffer: 8 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          activeRequests.delete(requestId);
          fs.unlink(requestFile, () => {});

          if (error) {
            const msg = error.killed
              ? "Request cancelled."
              : (stderr.trim() || stdout.trim() || error.message);
            sseWrite(response, { type: "error", message: msg });
            resolve();
            return;
          }

          try {
            const result = JSON.parse(stdout.trim());
            sseWrite(response, { type: "reply", text: result.reply });
            sseWrite(response, { type: "done",  threadId: result.threadId, usage: result.usage });
          } catch (e) {
            sseWrite(response, { type: "error", message: "Invalid bridge response: " + stdout.slice(0, 300) });
          }
          resolve();
        }
      );

      activeRequests.set(requestId, child);
    });
  });
}

// ── Streaming endpoint: POST /api/chat/stream ─────────────────────────────────

async function handleChatStream(request, response) {
  let rawBody;
  try { rawBody = await collectBody(request); }
  catch (e) { sendJson(response, 400, { error: e.message }); return; }

  let payload;
  try { payload = JSON.parse(rawBody || "{}"); }
  catch (e) { sendJson(response, 400, { error: "Invalid JSON body" }); return; }

  const message   = String(payload.message   || "").trim();
  const threadId  = String(payload.threadId  || "").trim();
  const model     = String(payload.model     || "codex").trim();
  const requestId = String(payload.requestId || "").trim() || crypto.randomUUID();

  if (!message) { sendJson(response, 400, { error: "Message is required." }); return; }

  response.writeHead(200, {
    "Content-Type":                "text/event-stream; charset=utf-8",
    "Cache-Control":               "no-cache",
    "Connection":                  "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering":           "no",
  });

  // Kill child process if client disconnects mid-stream
  request.on("close", () => {
    const proc = activeRequests.get(requestId);
    if (proc) { try { proc.kill(); } catch {} activeRequests.delete(requestId); }
  });

  try {
    if (model === "opencode") {
      await streamOpencode({ message, threadId, requestId, response });
    } else {
      await streamCodex({ message, threadId, requestId, response });
    }
  } catch (error) {
    sseWrite(response, { type: "error", message: error.message });
  }

  response.end();
}

// ── Non-streaming endpoint: POST /api/chat (legacy fallback) ──────────────────

async function handleChat(request, response) {
  try {
    const rawBody = await collectBody(request);
    const payload = JSON.parse(rawBody || "{}");
    const message   = String(payload.message   || "").trim();
    const threadId  = String(payload.threadId  || "").trim();
    const model     = String(payload.model     || "codex").trim();
    const requestId = String(payload.requestId || "").trim() || crypto.randomUUID();

    if (!message) { sendJson(response, 400, { error: "Message is required." }); return; }

    const result = model === "opencode"
      ? await runOpencodeChat({ message, threadId, requestId })
      : await runCodexChat({ message, threadId, requestId });

    sendJson(response, 200, { ...result, requestId });
  } catch (error) {
    const statusCode = error.code === "REQUEST_CANCELLED" ? 499 : 500;
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
    const args = ["run", "--format", "json", "--thinking"];
    if (threadId) { args.push("--session", threadId); }
    args.push(message);

    const child = spawnOpencode(args);
    activeRequests.set(requestId, child);
    let stdoutBuf = "";

    child.stdout.on("data", (chunk) => { stdoutBuf += chunk.toString(); });
child.stderr.on("data", (data) => {
  console.error("❌ OpenCode stderr:", data.toString());
});
    child.on("error", (err) => {
      activeRequests.delete(requestId);
      reject(new Error("Failed to spawn opencode: " + err.message));
    });

    child.on("close", () => {
      activeRequests.delete(requestId);
      const result = parseOpencodeEvents(stdoutBuf);
      if (result) resolve(result);
      else reject(new Error("Opencode returned no parseable reply. stdout: " + stdoutBuf.slice(0, 500)));
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
    if (!sessionId && ev.sessionID) sessionId = String(ev.sessionID);
    if (ev.type === "text"        && ev.part && ev.part.text)   reply += String(ev.part.text);
    if (ev.type === "reasoning"   && ev.part && ev.part.text)   thinking += String(ev.part.text);
    if (ev.type === "step_finish" && ev.part && ev.part.tokens) usage = ev.part.tokens;
    if (ev.type === "step_finish") return { threadId: sessionId, reply, usage, thinking };
    if (ev.type === "error") throw new Error(ev.message || "Opencode error event");
  }
  if (reply.trim()) return { threadId: sessionId, reply: reply.trim(), usage: null };
  return null;
}

// ── Non-streaming: codex ──────────────────────────────────────────────────────

function runCodexChat({ message, threadId, requestId }) {
  return new Promise((resolve, reject) => {
    const requestFile = path.join(
      os.tmpdir(),
      `atlasforge-codex-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
    );

    fs.writeFile(requestFile, JSON.stringify({ message, threadId }), "utf8", (writeErr) => {
      if (writeErr) { reject(writeErr); return; }

      const child = execFile(
        "powershell.exe",
        ["-NoLogo", "-NonInteractive", "-NoProfile", "-ExecutionPolicy", "Bypass",
         "-File", bridgeScriptPath, "-RequestFile", requestFile],
        {
          cwd: os.homedir(),
          env: { ...process.env, NO_COLOR: "1" },
          windowsHide: true,
          timeout: 10 * 60 * 1000,
          maxBuffer: 8 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          activeRequests.delete(requestId);
          fs.unlink(requestFile, () => {});

          if (error) {
            if (error.killed) {
              const c = new Error("Request cancelled.");
              c.code = "REQUEST_CANCELLED";
              reject(c);
              return;
            }
            reject(new Error(stderr.trim() || stdout.trim() || error.message));
            return;
          }

          try { resolve(JSON.parse(stdout.trim())); }
          catch (e) { reject(new Error("Invalid bridge response: " + (stdout || stderr || e.message))); }
        }
      );

      activeRequests.set(requestId, child);
    });
  });
}

// ── Cancel endpoint: POST /api/chat/cancel ────────────────────────────────────

function handleCancel(request, response) {
  collectBody(request).then((rawBody) => {
    const payload   = JSON.parse(rawBody || "{}");
    const requestId = String(payload.requestId || "").trim();
    if (!requestId) { sendJson(response, 400, { error: "requestId is required." }); return; }

    const proc = activeRequests.get(requestId);
    if (!proc)  { sendJson(response, 404, { error: "Active request not found." }); return; }

    try { proc.kill(); } catch {}
    activeRequests.delete(requestId);
    sendJson(response, 200, { ok: true, requestId });
  }).catch((e) => sendJson(response, 500, { error: e.message }));
}

// ── Reset endpoint: DELETE /api/chat ─────────────────────────────────────────

function handleReset(response) {
  sendJson(response, 200, { ok: true });
}

// ── Router ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "OPTIONS") { sendNoContent(response); return; }

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

  if (request.method !== "GET") { sendJson(response, 405, { error: "Method not allowed" }); return; }

  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const safePath = path.normalize(path.join(publicDir, pathname));
  if (!safePath.startsWith(publicDir)) { sendJson(response, 403, { error: "Forbidden" }); return; }

  serveFile(safePath, response);
});

server.listen(port, host, () => {
  console.log(`AtlasForge chat portal running at http://${host}:${port}`);
});
