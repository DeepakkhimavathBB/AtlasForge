$body = @{
    message = "say hello"
    model = "opencode"
} | ConvertTo-Json

$wreq = [System.Net.WebRequest]::Create("http://127.0.0.1:3000/api/chat")
$wreq.Method = "POST"
$wreq.ContentType = "application/json"
$wreq.Timeout = 120000

$sw = [System.IO.StreamWriter]::new($wreq.GetRequestStream())
$sw.Write($body)
$sw.Close()

try {
    $resp = $wreq.GetResponse()
    $sr = [System.IO.StreamReader]::new($resp.GetResponseStream())
    $content = $sr.ReadToEnd()
    $resp.Close()
    Write-Host "SUCCESS:"
    Write-Host $content
} catch {
    Write-Host "ERROR: $_"
}
