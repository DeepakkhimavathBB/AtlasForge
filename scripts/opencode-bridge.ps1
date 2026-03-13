param(
  [Parameter(Mandatory = $true)]
  [string]$RequestFile
)

$ErrorActionPreference = "Stop"

$request   = Get-Content -LiteralPath $RequestFile -Raw | ConvertFrom-Json
$message   = [string]$request.message
$sessionId = [string]$request.threadId

if (-not $message.Trim()) {
  throw "Message is required."
}

$opencodeScript = Join-Path ([Environment]::GetFolderPath("ApplicationData")) "npm\opencode.ps1"
if (-not (Test-Path -LiteralPath $opencodeScript)) {
  throw "opencode.ps1 not found at $opencodeScript"
}

$opencodeArgs = @("run", "--format", "json")
if ($sessionId.Trim()) {
  $opencodeArgs += "--session"
  $opencodeArgs += $sessionId
}
$opencodeArgs += $message

# Capture stdout and stderr into SEPARATE variables.
# opencode always writes a "Failed to fetch models.dev" warning to stderr which
# makes $LASTEXITCODE non-zero even when the response is perfectly valid.
# We must NOT mix them with 2>&1 — only parse stdout.
$stdoutLines = [System.Collections.Generic.List[string]]::new()
$stderrLines = [System.Collections.Generic.List[string]]::new()

& $opencodeScript @opencodeArgs 2>&1 | ForEach-Object {
  if ($_ -is [System.Management.Automation.ErrorRecord]) {
    $stderrLines.Add($_.ToString())
  } else {
    $stdoutLines.Add($_.ToString())
  }
}

$stdoutRaw = $stdoutLines -join "`n"

# Parse JSON stream from stdout only
function Parse-OpencodeEvents {
  param([string]$RawOutput)

  $reply      = [System.Text.StringBuilder]::new()
  $sessionOut = ""
  $usage      = $null

  foreach ($line in ($RawOutput -split "(`r`n|`n|`r)")) {
    $trimmed = $line.Trim()
    if (-not $trimmed) { continue }

    try   { $ev = $trimmed | ConvertFrom-Json }
    catch { continue }

    # Grab session ID
    if (-not $sessionOut -and $ev.PSObject.Properties["sessionID"] -and $ev.sessionID) {
      $sessionOut = [string]$ev.sessionID
    }

    switch ($ev.type) {
      "text" {
        if ($ev.PSObject.Properties["part"] -and
            $ev.part.PSObject.Properties["text"] -and
            $ev.part.text) {
          [void]$reply.Append([string]$ev.part.text)
        }
      }
      "step_finish" {
        if ($ev.PSObject.Properties["part"] -and
            $ev.part.PSObject.Properties["tokens"]) {
          $usage = $ev.part.tokens
        }
        return @{ threadId = $sessionOut; reply = $reply.ToString(); usage = $usage }
      }
      "error" {
        $msg = if ($ev.PSObject.Properties["message"]) { [string]$ev.message } else { "Opencode error" }
        throw $msg
      }
    }
  }

  $replyText = $reply.ToString().Trim()
  if ($replyText) {
    return @{ threadId = $sessionOut; reply = $replyText; usage = $null }
  }

  throw "Opencode did not return a reply. Stderr: $($stderrLines -join ' ')"
}

$result = Parse-OpencodeEvents -RawOutput $stdoutRaw
$result | ConvertTo-Json -Depth 8 -Compress