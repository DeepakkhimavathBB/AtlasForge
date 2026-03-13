# Generate Proper GUID for EliminationService Trigger
# IMPORTANT: Use proper GUID format, NOT random strings!

$guid = [guid]::NewGuid().ToString()

Write-Host "Generated GUID: $guid" -ForegroundColor Green
Write-Host ""
Write-Host "Use this GUID for both 'id' and 'correlationid' in the trigger payload" -ForegroundColor Yellow
