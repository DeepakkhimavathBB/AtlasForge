# AtlasForge Chat Portal

This is a minimal local web UI that gives you a chat-style portal instead of typing directly into the terminal.

## Run

```powershell
npm start
```

Then open `http://127.0.0.1:3000`.

## What it does

- Serves a browser chat UI.
- Sends messages to `POST /api/chat`.
- Starts a real local `codex` CLI session on the first message.
- Resumes that Codex thread on follow-up messages from the same browser.

## Important limitation

## How the bridge works

- First message: `codex exec --skip-git-repo-check --json "<prompt>"`
- Next messages: `codex exec resume <thread-id> --skip-git-repo-check --json "<prompt>"`
- A PowerShell wrapper at `scripts/codex-bridge.ps1` normalizes Codex output into one JSON response for the Node server.
- The browser stores `threadId` in `localStorage`, so refresh keeps the conversation.

## Requirements

- `codex` CLI must already be installed and logged in on this machine.
- The machine must have network access to Codex services while the server is running.

## Reset

Use the `New chat` button in the UI to clear the saved thread id and start a fresh Codex conversation.

## Stop

While a prompt is running, the `Send` button changes to `Stop`.
Clicking it:

- aborts the browser request
- calls `POST /api/chat/cancel`
- terminates the active Codex wrapper process for that request

## Port

The server defaults to `3000`. If that port is already in use, start with another one:

```powershell
$env:PORT=3014
npm start
```
