const form = document.getElementById("composer");
const input = document.getElementById("prompt");
const messages = document.getElementById("messages");
const statusText = document.getElementById("status");
const submitButton = document.getElementById("submit");
const resetButton = document.getElementById("reset");
const historyToggle = document.getElementById("historyToggle");
const historyClose = document.getElementById("historyClose");
const sidebar = document.getElementById("sidebar");
const appShell = document.querySelector(".app-shell");
const conversationList = document.getElementById("conversationList");
const conversationHeading = document.getElementById("conversationHeading");
const sidebarBackdrop = document.getElementById("sidebarBackdrop");
const modelSelect = document.getElementById("modelSelect");

const conversationStorageKey = "atlasforge-conversations";
const currentConversationStorageKey = "atlasforge-current-conversation";
const calloutTitles = ["note", "tip", "warning", "important", "result", "summary"];

let activeRequest = null;
let conversations = loadConversations();
let currentConversationId =
  localStorage.getItem(currentConversationStorageKey) || conversations[0]?.id || "";

normalizeConversations();
if (!currentConversationId || !findConversation(currentConversationId)) {
  currentConversationId = createConversation().id;
}

setSidebarOpen(window.innerWidth > 1120);
renderSidebar();
renderCurrentConversation();
autoResizeInput();

function loadConversations() {
  try {
    const stored = JSON.parse(localStorage.getItem(conversationStorageKey) || "[]");
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

function normalizeConversations() {
  conversations = conversations.map((conversation) => ({
    id: conversation.id || crypto.randomUUID(),
    title: conversation.title || "New conversation",
    manualTitle: Boolean(conversation.manualTitle),
    threadId: conversation.threadId || "",
    updatedAt: conversation.updatedAt || Date.now(),
    messages: Array.isArray(conversation.messages)
      ? conversation.messages.map((message) => ({
          id: message.id || crypto.randomUUID(),
          role: message.role || "assistant",
          text: message.status === "pending" ? "Request interrupted." : message.text || "",
          thinking: message.thinking || "",
          thinkingTime: message.thinkingTime || 0,
          status: message.status === "pending" ? "done" : message.status || "done",
          createdAt: message.createdAt || Date.now(),
        }))
      : [],
  }));
}

function persistConversations() {
  localStorage.setItem(conversationStorageKey, JSON.stringify(conversations));
  localStorage.setItem(currentConversationStorageKey, currentConversationId);
}

function createConversation() {
  const conversation = {
    id: crypto.randomUUID(),
    title: "New conversation",
    manualTitle: false,
    threadId: "",
    updatedAt: Date.now(),
    messages: [
      {
        id: crypto.randomUUID(),
        role: "assistant",
        text: "## Welcome\n\nAsk anything and AtlasForge will keep this thread in history.\n\nTip: use clear prompts if you want more structured output.",
        thinking: "",
        thinkingTime: 0,
        status: "done",
        createdAt: Date.now(),
      },
    ],
  };

  conversations.unshift(conversation);
  currentConversationId = conversation.id;
  persistConversations();
  return conversation;
}

function findConversation(conversationId) {
  return conversations.find((conversation) => conversation.id === conversationId) || null;
}

function getCurrentConversation() {
  return findConversation(currentConversationId);
}

function updateConversationTitle(conversation) {
  if (conversation.manualTitle) return;

  const candidate = conversation.messages.find(
    (message) => message.role === "user" && message.text.trim()
  ) || conversation.messages.find((message) => message.text.trim());

  if (!candidate) { conversation.title = "New conversation"; return; }

  const firstLine = candidate.text
    .replace(/^#+\s*/, "")
    .split(/\r?\n/)
    .find((line) => line.trim()) || "New conversation";

  conversation.title =
    firstLine.length > 54 ? `${firstLine.slice(0, 54).trim()}...` : firstLine.trim();
}

function touchConversation(conversation) {
  conversation.updatedAt = Date.now();
  updateConversationTitle(conversation);
  conversations = [conversation, ...conversations.filter((item) => item.id !== conversation.id)];
  currentConversationId = conversation.id;
  persistConversations();
}

function setSidebarOpen(isOpen) {
  const shouldOpen = Boolean(isOpen);
  if (appShell) appShell.dataset.sidebarOpen = shouldOpen ? "true" : "false";
  sidebar.dataset.open = shouldOpen ? "true" : "false";
  if (sidebarBackdrop) {
    if (window.innerWidth > 1120) {
      sidebarBackdrop.hidden = true;
    } else {
      sidebarBackdrop.hidden = !shouldOpen;
    }
  }
}

function renderSidebar() {
  conversationList.innerHTML = "";

  for (const conversation of conversations) {
    const item = document.createElement("article");
    item.className = "conversation-item";
    item.dataset.active = conversation.id === currentConversationId ? "true" : "false";

    const selectButton = document.createElement("button");
    selectButton.type = "button";
    selectButton.className = "conversation-select";
    selectButton.disabled = Boolean(activeRequest);

    const title = document.createElement("span");
    title.className = "conversation-title";
    title.textContent = conversation.title;

    const meta = document.createElement("span");
    meta.className = "conversation-meta";
    meta.textContent = formatTimestamp(conversation.updatedAt);

    selectButton.append(title, meta);
    selectButton.addEventListener("click", () => {
      if (activeRequest) return;
      currentConversationId = conversation.id;
      persistConversations();
      renderSidebar();
      renderCurrentConversation();
      if (window.innerWidth <= 1120) setSidebarOpen(false);
    });

    const actionRow = document.createElement("div");
    actionRow.className = "conversation-actions";

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "mini-action ghost";
    editButton.textContent = "Rename";
    editButton.disabled = Boolean(activeRequest);
    editButton.addEventListener("click", () => {
      if (activeRequest) return;
      const nextTitle = window.prompt("Edit conversation title", conversation.title);
      if (!nextTitle) return;
      conversation.title = nextTitle.trim() || conversation.title;
      conversation.manualTitle = true;
      touchConversation(conversation);
      renderSidebar();
      renderCurrentConversation();
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "mini-action danger";
    deleteButton.textContent = "Delete";
    deleteButton.disabled = Boolean(activeRequest);
    deleteButton.addEventListener("click", () => {
      if (activeRequest) return;
      const confirmed = window.confirm(`Delete this conversation?\n\n"${conversation.title}"`);
      if (!confirmed) return;

      conversations = conversations.filter((item) => item.id !== conversation.id);
      if (!conversations.length) {
        createConversation();
      } else if (currentConversationId === conversation.id) {
        currentConversationId = conversations[0].id;
      }
      persistConversations();
      renderSidebar();
      renderCurrentConversation();
    });

    actionRow.append(editButton, deleteButton);
    item.append(selectButton, actionRow);
    conversationList.appendChild(item);
  }
}

function renderCurrentConversation() {
  const conversation = getCurrentConversation();
  messages.innerHTML = "";

  if (!conversation) return;

  conversationHeading.textContent = conversation.title;
  for (const message of conversation.messages) {
    messages.appendChild(createMessageElement(message));
  }
  messages.scrollTop = messages.scrollHeight;

  statusText.textContent = conversation.threadId
    ? `Connected to thread ${conversation.threadId.slice(0, 8)}...`
    : "Ready";
}

// ── Message element factory ───────────────────────────────────────────────────
function createMessageElement(message) {
  const article = document.createElement("article");
  article.className = `message ${message.role}`;
  article.dataset.messageId = message.id;

  const frame  = document.createElement("div"); frame.className  = "message__frame";
  const header = document.createElement("div"); header.className = "message__header";
  const badge  = document.createElement("span"); badge.className  = "message__badge"; badge.textContent = message.role === "user" ? "" : "AtlasForge";
  const stamp  = document.createElement("span"); stamp.className  = "message__stamp"; stamp.textContent = formatMessageTime(message.createdAt);
  const body   = document.createElement("div"); body.className   = "message__body";

  header.append(badge, stamp);
  frame.append(header, body);
  article.appendChild(frame);

  if (message.role === "assistant" && message.status === "pending") {
    body.appendChild(createThinkingIndicator(message.id));
    body.appendChild(createLoader());
    
    const streamingReply = document.createElement("div");
    streamingReply.className = "streaming-reply";
    body.appendChild(streamingReply);
    return article;
  }

  if (message.role === "assistant") {
    // ALWAYS show thinking block — even when thinking is empty
    // (shows "no reasoning" label instead of disappearing)
    body.appendChild(createStaticThinkBlock(message.thinking, message.thinkingTime));
    body.appendChild(renderAssistantContent(message.text));
    return article;
  }

  const content = document.createElement("p");
  content.className = "content";
  content.textContent = message.text;
  body.appendChild(content);
  return article;
}

// ── Live thinking indicator (shown while pending) ─────────────────────────────
function createThinkingIndicator(messageId) {
  const container = document.createElement("div");
  container.className = "thinking-indicator";
  container.style.display = "block";
  container.dataset.messageId = messageId;

  const header = document.createElement("button");
  header.type = "button";
  header.className = "thinking-header";
  header.innerHTML = `
    <span class="thinking-icon">🤔</span>
    <span class="thinking-label">Thinking...</span>
    <span class="thinking-dots">
      <span></span><span></span><span></span>
    </span>
    <span class="thinking-elapsed">(0s)</span>
    <span class="thinking-toggle">▼</span>
  `;

  const content = document.createElement("div");
  content.className = "thinking-content";
  content.dataset.expanded = "true";

  const timerEl = header.querySelector(".thinking-elapsed");
  const startTime = Date.now();
  const timerId = setInterval(() => {
    timerEl.textContent = `(${Math.floor((Date.now() - startTime) / 1000)}s)`;
  }, 1000);
  container.dataset.timerId = timerId;
  container.dataset.startTime = startTime;

  header.addEventListener("click", () => {
    const isExpanded = content.dataset.expanded === "true";
    content.dataset.expanded = (!isExpanded).toString();
    header.querySelector(".thinking-toggle").textContent = isExpanded ? "▼" : "▲";
  });

  container.appendChild(header);
  container.appendChild(content);
  return container;
}

// ── Static think block (shown after response is saved) ────────────────────────
function createStaticThinkBlock(thinkText, thinkingTime) {
  const container = document.createElement("div");
  container.className = "thinking-indicator";
  container.style.display = "block"; // inline style — cannot be overridden by CSS cascade

  const header = document.createElement("button");
  header.type = "button";
  header.className = "thinking-header";

  const hasContent = Boolean(thinkText && thinkText.trim());

  let labelText;
  if (hasContent) {
    labelText = `Thinking (${thinkText.length} chars) — click to expand`;
  } else if (thinkingTime && thinkingTime > 0) {
    labelText = `Thought for ${thinkingTime}s — no reasoning output`;
  } else {
    labelText = "No reasoning output";
  }

  header.innerHTML = `
    <span class="thinking-icon">🤔</span>
    <span class="thinking-label">${labelText}</span>
    ${hasContent ? '<span class="thinking-toggle">▼</span>' : ''}
  `;

  const content = document.createElement("div");
  content.className = "thinking-content";
  content.dataset.expanded = "false";

  if (hasContent) {
    const pre = document.createElement("pre");
    pre.textContent = thinkText;
    content.appendChild(pre);

    header.addEventListener("click", () => {
      const isExpanded = content.dataset.expanded === "true";
      content.dataset.expanded = (!isExpanded).toString();
      const toggle = header.querySelector(".thinking-toggle");
      if (toggle) toggle.textContent = isExpanded ? "▼" : "▲";
    });
  }

  container.appendChild(header);
  container.appendChild(content);
  return container;
}

// ── Append live thinking text during streaming ────────────────────────────────
function appendThinkingContent(messageId, text) {
  const article = messages.querySelector(`article[data-message-id="${messageId}"]`);
  if (!article) return;

  const indicator = article.querySelector(".thinking-indicator");
  if (!indicator) return;

  const thinkContent = indicator.querySelector(".thinking-content");
  if (!thinkContent) return;

  indicator.style.display = "block";

  let pre = thinkContent.querySelector("pre");
  if (!pre) {
    pre = document.createElement("pre");
    thinkContent.appendChild(pre);
  }
  pre.textContent += text;
  thinkContent.dataset.hasContent = "true";
  thinkContent.scrollTop = thinkContent.scrollHeight;
  messages.scrollTop = messages.scrollHeight;
}

// ── Append live reply text during streaming ──────────────────────────────────
function appendReplyContent(messageId, text) {
  const article = messages.querySelector(`article[data-message-id="${messageId}"]`);
  if (!article) return;

  const streamingReply = article.querySelector(".streaming-reply");
  if (!streamingReply) return;

  // Hide loader on first chunk
  const loader = article.querySelector(".loading-card");
  if (loader) loader.style.display = "none";

  const currentText = streamingReply.dataset.rawText || "";
  const nextText = currentText + text;
  streamingReply.dataset.rawText = nextText;

  streamingReply.innerHTML = "";
  streamingReply.appendChild(renderAssistantContent(nextText));

  messages.scrollTop = messages.scrollHeight;
}

// ── Finalize thinking block when streaming completes ─────────────────────────
function finalizeThinkingIndicator(messageId, thinkText) {
  const article = messages.querySelector(`article[data-message-id="${messageId}"]`);
  if (!article) return;

  const indicator = article.querySelector(".thinking-indicator");
  if (!indicator) return;

  clearInterval(Number(indicator.dataset.timerId));

  // Capture elapsed time (handle (5s) format)
  const elapsedEl = indicator.querySelector(".thinking-elapsed");
  const elapsedText = elapsedEl ? elapsedEl.textContent : "0";
  const elapsedSec = parseInt(elapsedText.replace(/[^0-9]/g, "")) || 0;

  const thinkContent = indicator.querySelector(".thinking-content");
  const label        = indicator.querySelector(".thinking-label");
  const dots         = indicator.querySelector(".thinking-dots");
  const toggle       = indicator.querySelector(".thinking-toggle");

  if (dots)    dots.remove();
  if (elapsedEl) elapsedEl.remove();
  if (toggle)  toggle.textContent = "▼";

  const hasContent = Boolean(thinkText && thinkText.trim());

  if (hasContent) {
    if (label) label.textContent = `Thinking (${thinkText.length} chars) — click to expand`;
    if (thinkContent) {
      let pre = thinkContent.querySelector("pre");
      if (!pre) { pre = document.createElement("pre"); thinkContent.appendChild(pre); }
      pre.textContent = thinkText;
      thinkContent.dataset.expanded = "false";
      thinkContent.dataset.hasContent = "true";
    }
  } else {
    if (label) label.textContent = elapsedSec > 0
      ? `Thought for ${elapsedSec}s — no reasoning output`
      : "No reasoning output";
    if (thinkContent) thinkContent.dataset.expanded = "false";
  }

  indicator.style.display = "block"; // always visible, always
}

function createLoader() {
  const wrapper = document.createElement("div");
  wrapper.className = "loading-card";
  for (let i = 0; i < 3; i++) {
    const line = document.createElement("div");
    line.className = "loading-line";
    wrapper.appendChild(line);
  }
  return wrapper;
}

function escapeHtml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function applyInlineFormatting(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function renderAssistantContent(text) {
  const wrapper = document.createElement("div");
  wrapper.className = "content prose";

  // Strip any leaked <think> blocks
  let cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/\r\n/g, "\n")
    .trim();

  if (!cleaned) {
    const p = document.createElement("p");
    p.textContent = "No response content.";
    wrapper.appendChild(p);
    return wrapper;
  }

  // Extract code blocks FIRST before splitting on blank lines
  // Code blocks can contain blank lines internally — splitting first would break them
  const segments = [];
  const codeBlockRegex = /```[\s\S]*?```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(cleaned)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: cleaned.slice(lastIndex, match.index) });
    }
    segments.push({ type: "code", content: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < cleaned.length) {
    segments.push({ type: "text", content: cleaned.slice(lastIndex) });
  }

  for (const seg of segments) {
    if (seg.type === "code") {
      const rendered = renderCodeBlock(seg.content.trim());
      if (rendered) { wrapper.appendChild(rendered); continue; }
    }
    for (const rawBlock of seg.content.split(/\n\s*\n/)) {
      const block = rawBlock.trim();
      if (!block) continue;
      const rendered =
        renderTableBlock(block)    ||
        renderCalloutBlock(block)  ||
        renderKeyValueBlock(block) ||
        renderListBlock(block)     ||
        renderQuoteBlock(block)    ||
        renderHeadingBlock(block)  ||
        renderParagraphBlock(block);
      wrapper.appendChild(rendered);
    }
  }

  return wrapper;
}

function renderCodeBlock(block) {
  if (!block.startsWith("```") || !block.endsWith("```")) return null;
  const lines = block.split("\n");
  const language = lines[0].replace(/```/, "").trim() || "code";
  const code = lines.slice(1, -1).join("\n");
  const card = document.createElement("div"); card.className = "code-card";
  const bar = document.createElement("div"); bar.className = "code-card__bar";
  bar.innerHTML = `<span>Code</span><span>${escapeHtml(language)}</span>`;
  const pre = document.createElement("pre");
  const codeElement = document.createElement("code"); codeElement.textContent = code;
  pre.appendChild(codeElement);
  card.append(bar, pre);
  return card;
}

function renderTableBlock(block) {
  const lines = block.split("\n").map((line) => line.trim());
  if (lines.length < 2 || !lines.every((line) => line.includes("|"))) return null;
  const rows = lines.filter(Boolean).map((line) =>
    line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim())
  );
  if (rows.length < 2) return null;
  const divider = rows[1];
  if (!divider.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
  const wrap = document.createElement("div"); wrap.className = "table-wrap";
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const tbody = document.createElement("tbody");
  const headerRow = document.createElement("tr");
  for (const heading of rows[0]) {
    const th = document.createElement("th"); th.innerHTML = applyInlineFormatting(heading); headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  for (const row of rows.slice(2)) {
    const tr = document.createElement("tr");
    for (const cell of row) {
      const td = document.createElement("td"); td.innerHTML = applyInlineFormatting(cell); tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.append(thead, tbody); wrap.appendChild(table); return wrap;
}

function renderCalloutBlock(block) {
  const match = block.match(/^([A-Za-z]+):\s+([\s\S]+)/);
  if (!match) return null;
  const label = match[1].toLowerCase();
  if (!calloutTitles.includes(label)) return null;
  const container = document.createElement("section"); container.className = "callout";
  const title = document.createElement("p"); title.className = "callout__title"; title.textContent = `${symbolForLabel(label)} ${match[1]}`;
  const body = document.createElement("p"); body.innerHTML = applyInlineFormatting(match[2]).replace(/\n/g, "<br>");
  container.append(title, body); return container;
}

function renderKeyValueBlock(block) {
  const lines = block.split("\n");
  if (lines.length < 2) return null;
  const pairs = [];
  for (const line of lines) {
    const match = line.match(/^([^:]{2,40}):\s+(.+)$/);
    if (!match) return null;
    pairs.push({ key: match[1].trim(), value: match[2].trim() });
  }
  const container = document.createElement("section"); container.className = "key-value";
  for (const pair of pairs) {
    const row = document.createElement("div"); row.className = "kv-row";
    row.innerHTML = `<strong>${escapeHtml(pair.key)}</strong><span>${applyInlineFormatting(pair.value)}</span>`;
    container.appendChild(row);
  }
  return container;
}

function renderListBlock(block) {
  const lines = block.split("\n");
  const unordered = lines.every((line) => /^[-*]\s+/.test(line.trim()));
  const ordered = lines.every((line) => /^\d+\.\s+/.test(line.trim()));
  if (!unordered && !ordered) return null;
  const list = document.createElement(unordered ? "ul" : "ol");
  for (const line of lines) {
    const item = document.createElement("li");
    item.innerHTML = applyInlineFormatting(line.replace(unordered ? /^[-*]\s+/ : /^\d+\.\s+/, "").trim());
    list.appendChild(item);
  }
  return list;
}

function renderQuoteBlock(block) {
  const lines = block.split("\n");
  if (!lines.every((line) => line.trim().startsWith(">"))) return null;
  const quote = document.createElement("blockquote");
  quote.innerHTML = applyInlineFormatting(lines.map((line) => line.replace(/^>\s?/, "")).join("\n")).replace(/\n/g, "<br>");
  return quote;
}

function renderHeadingBlock(block) {
  if (!block.startsWith("#")) return null;
  const level = Math.min((block.match(/^#+/) || ["#"])[0].length + 1, 4);
  const heading = document.createElement(`h${level}`);
  heading.innerHTML = applyInlineFormatting(block.replace(/^#+\s*/, ""));
  return heading;
}

function renderParagraphBlock(block) {
  const paragraph = document.createElement("p");
  paragraph.innerHTML = applyInlineFormatting(block).replace(/\n/g, "<br>");
  return paragraph;
}

function symbolForLabel(label) {
  if (label === "tip")       return "✦";
  if (label === "warning")   return "▲";
  if (label === "important") return "■";
  if (label === "result")    return "✔";
  if (label === "summary")   return "◎";
  return "•";
}

function formatTimestamp(timestamp) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(timestamp));
}

function formatMessageTime(timestamp) {
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
}

function setBusyState(isBusy) {
  submitButton.textContent = isBusy ? "Stop" : "Send";
  submitButton.dataset.mode = isBusy ? "stop" : "send";
  resetButton.disabled = isBusy;
  input.disabled = isBusy;
  historyToggle.disabled = false;
  historyClose.disabled = false;
  renderSidebar();
}

function autoResizeInput() {
  input.style.height = "0px";
  input.style.height = `${Math.min(Math.max(input.scrollHeight, 72), 220)}px`;
}

function pushMessage(conversation, message) {
  conversation.messages.push(message);
  touchConversation(conversation);
  renderSidebar();
  renderCurrentConversation();
}

function replaceMessage(conversation, messageId, updater) {
  const index = conversation.messages.findIndex((message) => message.id === messageId);
  if (index === -1) return;
  conversation.messages[index] = updater(conversation.messages[index]);
  touchConversation(conversation);
  renderSidebar();
  renderCurrentConversation();
}

async function cancelMessage(requestId) {
  const response = await fetch("/api/chat/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId }),
  });
  if (response.status === 404) return;
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Cancel failed");
  }
}

async function stopActiveRequest() {
  if (!activeRequest) return;
  const { controller, requestId, conversationId, loadingMessageId } = activeRequest;
  const conversation = findConversation(conversationId);
  activeRequest = null;
  controller.abort();
  setBusyState(false);
  statusText.textContent = "Stopping request...";

  try {
    await cancelMessage(requestId);
    if (conversation) {
      replaceMessage(conversation, loadingMessageId, (message) => ({
        ...message, status: "done", text: "Warning: Request cancelled.", thinking: "", thinkingTime: 0,
      }));
    }
    statusText.textContent = "Request cancelled.";
  } catch (error) {
    if (conversation) {
      replaceMessage(conversation, loadingMessageId, (message) => ({
        ...message, status: "done", text: `Warning: Cancel error: ${error.message}`, thinking: "", thinkingTime: 0,
      }));
    }
    statusText.textContent = "Cancel failed.";
  } finally {
    input.disabled = false;
    input.focus();
  }
}

// ── Form submit ───────────────────────────────────────────────────────────────
form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (activeRequest) { await stopActiveRequest(); return; }

  const text = input.value.trim();
  if (!text) { statusText.textContent = "Type a message first."; return; }

  const conversation     = getCurrentConversation() || createConversation();
  const requestId        = crypto.randomUUID();
  const loadingMessageId = crypto.randomUUID();
  const controller       = new AbortController();
  const selectedModel    = modelSelect.value;

  pushMessage(conversation, {
    id: crypto.randomUUID(), role: "user", text, thinking: "", thinkingTime: 0, status: "done", createdAt: Date.now(),
  });

  pushMessage(conversation, {
    id: loadingMessageId, role: "assistant", text: "", thinking: "", thinkingTime: 0, status: "pending", createdAt: Date.now(),
  });

  input.value = "";
  autoResizeInput();
  activeRequest = { controller, requestId, conversationId: conversation.id, loadingMessageId };
  setBusyState(true);
  statusText.textContent = `Waiting for ${selectedModel === "opencode" ? "Opencode" : "Codex"}…`;

  let accumulatedThinking = "";
  let accumulatedReply    = "";

  try {
    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, threadId: conversation.threadId, requestId, model: selectedModel }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || "Stream failed");
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuf = "";
    let finalThreadId = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuf += decoder.decode(value, { stream: true });
      const lines = sseBuf.split("\n");
      sseBuf = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        let ev;
        try { ev = JSON.parse(line.slice(6)); } catch { continue; }

        if (ev.type === "thinking") {
          accumulatedThinking += ev.text;
          appendThinkingContent(loadingMessageId, ev.text);
        }
        if (ev.type === "reply") {
          accumulatedReply += ev.text;
          appendReplyContent(loadingMessageId, ev.text);
        }
        if (ev.type === "done") {
          finalThreadId = ev.threadId || "";
        }
        if (ev.type === "error") {
          throw new Error(ev.message);
        }
      }
    }

    if (!activeRequest || activeRequest.requestId !== requestId) return;

    if (finalThreadId) conversation.threadId = finalThreadId;

    // Capture elapsed time from the live indicator (handle (5s) format)
    const liveArticle = messages.querySelector(`article[data-message-id="${loadingMessageId}"]`);
    const liveIndicator = liveArticle ? liveArticle.querySelector(".thinking-indicator") : null;
    const elapsedEl = liveIndicator ? liveIndicator.querySelector(".thinking-elapsed") : null;
    const elapsedText = elapsedEl ? elapsedEl.textContent : "0";
    const thinkingTime = parseInt(elapsedText.replace(/[^0-9]/g, "")) || 0;

    // Finalize the live thinking block in DOM
    finalizeThinkingIndicator(loadingMessageId, accumulatedThinking);

    // Save to conversation — replaceMessage re-renders from saved data
    replaceMessage(conversation, loadingMessageId, (message) => ({
      ...message,
      status:      "done",
      text:        accumulatedReply,
      thinking:    accumulatedThinking,
      thinkingTime: thinkingTime,
    }));

    statusText.textContent = conversation.threadId
      ? `Connected to ${selectedModel} thread ${conversation.threadId.slice(0, 8)}...`
      : "Reply received.";

  } catch (error) {
    if (error.name !== "AbortError") {
      replaceMessage(conversation, loadingMessageId, (message) => ({
        ...message, status: "done", text: `Warning: Error: ${error.message}`, thinking: "", thinkingTime: 0,
      }));
      statusText.textContent = "Request failed.";
    }
  } finally {
    if (activeRequest && activeRequest.requestId === requestId) activeRequest = null;
    setBusyState(false);
    input.focus();
    autoResizeInput();
  }
});

resetButton.addEventListener("click", async () => {
  if (activeRequest) return;
  createConversation();
  renderSidebar();
  renderCurrentConversation();
  try { await fetch("/api/chat", { method: "DELETE" }); } catch {
    statusText.textContent = "Started a fresh local chat.";
  }
});

historyToggle.addEventListener("click", () => {
  setSidebarOpen(sidebar.dataset.open !== "true");
});

historyClose.addEventListener("click", () => {
  if (window.innerWidth <= 1120) setSidebarOpen(false);
});

input.addEventListener("input", autoResizeInput);

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

if (sidebarBackdrop) {
  sidebarBackdrop.addEventListener("click", () => {
    if (window.innerWidth <= 1120) setSidebarOpen(false);
  });
}

window.addEventListener("resize", () => {
  setSidebarOpen(sidebar.dataset.open === "true");
});