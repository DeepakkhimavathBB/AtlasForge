param(
  [Parameter(Mandatory = $true)]
  [string]$RequestFile
)

$ErrorActionPreference = "Stop"

function Parse-CodexEvents {
  param(
    [string]$RawOutput
  )

  $threadId = ""
  $reply = ""
  $usage = $null

  foreach ($line in ($RawOutput -split "(`r`n|`n|`r)")) {
    $trimmed = $line.Trim()
    if (-not $trimmed) {
      continue
    }

    try {
      $event = $trimmed | ConvertFrom-Json
    } catch {
      continue
    }

    if ($event.type -eq "thread.started" -and $event.thread_id) {
      $threadId = [string]$event.thread_id
    }

    if ($event.type -eq "item.completed" -and $event.item -and $event.item.type -eq "agent_message") {
      $reply = [string]$event.item.text
    }

    if ($event.type -eq "turn.completed" -and $event.usage) {
      $usage = $event.usage
    }

    if ($event.type -eq "turn.failed" -and $event.error -and $event.error.message) {
      throw [System.Exception]::new([string]$event.error.message)
    }
  }

  if (-not $threadId) {
    throw "Codex did not return a thread id."
  }

  if (-not $reply) {
    throw "Codex did not return a reply."
  }

  return @{
    threadId = $threadId
    reply = $reply
    usage = $usage
  }
}

$request = Get-Content -LiteralPath $RequestFile -Raw | ConvertFrom-Json
$message = [string]$request.message
$threadId = [string]$request.threadId

if (-not $message.Trim()) {
  throw "Message is required."
}

$codexRoot = Join-Path ([Environment]::GetFolderPath("ApplicationData")) "npm"
$codexScript = Join-Path $codexRoot "codex.ps1"

if (-not (Test-Path -LiteralPath $codexScript)) {
  throw "Codex CLI script not found at $codexScript"
}

$codexArgs = @()
if ($threadId.Trim()) {
  $codexArgs += "exec", "resume", $threadId
} else {
  $codexArgs += "exec"
}
$codexArgs += "--skip-git-repo-check", "--json", $message

$rawOutput = & $codexScript @codexArgs 2>&1 | Out-String

if ($LASTEXITCODE -ne 0) {
  throw ("Codex exited with code {0}. {1}" -f $LASTEXITCODE, $rawOutput.Trim())
}

$result = Parse-CodexEvents -RawOutput $rawOutput
$result | ConvertTo-Json -Depth 8 -Compress
