# Trigger AtlasFive Service - Quick Script
# Usage: .\trigger-service.ps1 -ServiceName "EliminationService"

param(
    [string]$ServiceName = "EliminationService",
    [string]$BlobUrl = "https://stgeventarchitecturedev.blob.core.windows.net/blob-payloads-dev/3601718d-9803-4045-89ee-28558081efff.json"
)

# Generate proper GUID (NOT random string!)
$guid = [guid]::NewGuid().ToString()

# Read template
$template = Get-Content "$PSScriptRoot\trigger_template.json" -Raw

# Replace placeholder with GUID
$json = $template -replace "REPLACE_WITH_GUID", $guid

# Update blob URL if provided
if ($BlobUrl) {
    $blobName = $BlobUrl.Split('/')[-1]
    $json = $json -replace "3601718d-9803-4045-89ee-28558081efff.json", $blobName
    $json = $json -replace "https://stgeventarchitecturedev.blob.core.windows.net/blob-payloads-dev/3601718d-9803-4045-89ee-28558081efff.json", $BlobUrl
}

# CORRECT endpoint for EliminationService
$endpoint = "http://localhost:7088/api/agt/eliminate"

Write-Host "Triggering $ServiceName..." -ForegroundColor Cyan
Write-Host "ID: $guid" -ForegroundColor Yellow
Write-Host "CorrelationID: $guid" -ForegroundColor Yellow
Write-Host "Endpoint: $endpoint" -ForegroundColor Cyan

# Trigger service
$response = Invoke-RestMethod -Uri $endpoint -Method Post -Body $json -ContentType "application/json"

Write-Host "`nService triggered successfully!" -ForegroundColor Green
Write-Host "Waiting for processing..." -ForegroundColor Cyan

Start-Sleep -Seconds 8

# Check logs on CORRECT port (5001, NOT 5000!)
Write-Host "`nChecking logs..." -ForegroundColor Cyan
$logUrl = "http://localhost:5001/api/serviceflow/$guid"

try {
    $logs = Invoke-RestMethod -Uri $logUrl -Method Get
    $logs | ConvertTo-Json -Depth 10
} catch {
    Write-Host "Could not fetch logs: $_" -ForegroundColor Red
}
