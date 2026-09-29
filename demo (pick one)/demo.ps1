<#
    Infinite Craft Bridge by cinovenx - interactive demo
    ====================================================
    A hands-on demonstration: it starts the bridge as a separate process and
    then lets you craft interactively - you type the first element, then the
    second one, you get the result, and it asks again. Type 'q' to quit.

    This script contains no bridge code of its own. It launches one of these,
    in order of preference, from the same folder:

        cinovenx-bridge.exe        compiled bridge, nothing to install
        bridge.ps1                 bridge written in PowerShell
        bridge.bat                 launcher for bridge.ps1

    Usage:
        demo.bat                    port 4242
        demo.bat 8080               another port
        powershell -File demo.ps1 -Port 8080

    Before the first craft, open https://neal.fun/infinite-craft/ in a browser
    with the userscript installed and press "Connect" in the panel.
#>
param(
    [int]$Port = 4242
)

$ErrorActionPreference = 'Stop'

$AppName = 'Infinite Craft Bridge by cinovenx'
$GitHubUrl = 'https://github.com/cinovenx/inf-craft-bridge'
$TabUrl = 'https://neal.fun/infinite-craft/'
$DefaultPort = 4242
$WaitSeconds = 90

# Windows consoles often default to legacy code pages (cp1251, cp1252).
# Results are full of emoji, so printing must never raise.
function Initialize-Console {
    try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
    try { $OutputEncoding = [System.Text.Encoding]::UTF8; $global:__cxUtf8 = $true } catch { $global:__cxUtf8 = $false }
}

function Format-Safe {
    param([string]$Text)
    if ($null -eq $Text) { return '' }
    if ($global:__cxUtf8) { return $Text }
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $Text.ToCharArray()) {
        $code = [int]$ch
        if ($ch -eq "`n" -or ($code -ge 32 -and $code -le 126)) { [void]$sb.Append($ch) } else { [void]$sb.Append('?') }
    }
    return $sb.ToString()
}

function Test-BridgeAlive {
    param([int]$P)
    try {
        $null = Invoke-WebRequest -Uri "http://127.0.0.1:$P/status" -UseBasicParsing -TimeoutSec 2
        return $true
    } catch { return $false }
}

function Get-CandidateFolders {
    # The release ships the bridge in a separate folder ("pick one" each), so
    # check this folder first and then the sibling bridge folder(s).
    $root = $PSScriptRoot
    if ([string]::IsNullOrWhiteSpace($root)) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }
    $parent = Split-Path -Parent $root
    return @(
        $root,
        (Join-Path $parent 'bridge (pick one)'),
        (Join-Path $parent 'bridge'),
        $parent
    )
}

function Find-Bridge {
    $folders = Get-CandidateFolders

    foreach ($folder in $folders) {
        $exe = Join-Path $folder 'cinovenx-bridge.exe'
        if (Test-Path -LiteralPath $exe) { return @{ Label = 'cinovenx-bridge.exe'; Argv = @($exe) } }
    }
    foreach ($folder in $folders) {
        $ps1 = Join-Path $folder 'bridge.ps1'
        if (Test-Path -LiteralPath $ps1) {
            return @{
                Label = 'bridge.ps1'
                Argv  = @('powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ps1)
            }
        }
    }
    foreach ($folder in $folders) {
        $bat = Join-Path $folder 'bridge.bat'
        if (Test-Path -LiteralPath $bat) { return @{ Label = 'bridge.bat'; Argv = @($bat) } }
    }
    return $null
}

function Start-Bridge {
    param([int]$P)
    if (Test-BridgeAlive -P $P) { return @{ Proc = $null; Note = 'using the bridge that is already running' } }

    $bridge = Find-Bridge
    if ($null -eq $bridge) { return @{ Proc = $null; Note = 'NO BRIDGE FOUND' } }

    Write-Host (Format-Safe "  Starting the bridge ($($bridge.Label))...")
    $all = @($bridge.Argv) + @($P)
    try {
        $proc = Start-Process -FilePath $all[0] -ArgumentList $all[1..($all.Length - 1)] -WindowStyle Hidden -PassThru
    } catch {
        return @{ Proc = $null; Note = "could not start $($bridge.Label): $($_.Exception.Message)" }
    }
    for ($i = 0; $i -lt ($WaitSeconds * 2); $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-BridgeAlive -P $P) { return @{ Proc = $proc; Note = "started $($bridge.Label)" } }
        if ($proc.HasExited) { return @{ Proc = $null; Note = "$($bridge.Label) exited immediately (port $P busy?)" } }
    }
    try { Stop-Process -Id $proc.Id -Force } catch { }
    return @{ Proc = $null; Note = "$($bridge.Label) did not answer on port $P" }
}

function Invoke-Pair {
    param([int]$P, [string]$First, [string]$Second)
    $url = 'http://127.0.0.1:{0}/pair?first={1}&second={2}' -f $P,
        [uri]::EscapeDataString($First), [uri]::EscapeDataString($Second)
    try {
        $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 80
        return @{ Status = [int]$resp.StatusCode; Body = ($resp.Content | ConvertFrom-Json) }
    } catch {
        $msg = $_.Exception.Message
        $code = 0
        if ($_.Exception.Response) {
            try {
                $code = [int]$_.Exception.Response.StatusCode
                $reader = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
                $msg = $reader.ReadToEnd()
                $reader.Close()
            } catch { }
        }
        $body = $null
        try { $body = $msg | ConvertFrom-Json } catch { $body = @{ error = $msg } }
        return @{ Status = $code; Body = $body }
    }
}

Write-Host ''
Write-Host ('=' * 66)
Write-Host "  $AppName - interactive demo"
Write-Host "  $GitHubUrl"
Write-Host ('=' * 66)
Write-Host ''
Write-Host '  You need the userscript running in a browser tab:'
Write-Host "      $TabUrl"
Write-Host "  Press 'Connect' in the cinovenx panel there, then come back."
Write-Host ''

$started = Start-Bridge -P $Port
if ($started.Note -eq 'NO BRIDGE FOUND') {
    Write-Host '  I could not find the bridge next to this script.' -ForegroundColor Red
    Write-Host '  Expected one of: cinovenx-bridge.exe, bridge.ps1, bridge.bat'
    Write-Host "  Get the full package from $GitHubUrl"
    exit 1
}
if ($null -eq $started.Proc -and $started.Note -ne 'using the bridge that is already running') {
    Write-Host (Format-Safe "  $($started.Note)") -ForegroundColor Red
    Write-Host '  Start the bridge manually and try again, or use another port.'
    exit 1
}

Write-Host "  Bridge: $($started.Note) on port $Port"
Write-Host ''
Write-Host '  ------------------------------------------------------------'
Write-Host '  Type the first element, then the second one.'
Write-Host '  You get the result from the real neal.fun API, then it asks again.'
Write-Host "  Type 'q' at any prompt to quit."
Write-Host '  ------------------------------------------------------------'
Write-Host ''

$emptyReads = 0
while ($true) {
    $first = Read-Host '  first  > '
    # With redirected (piped) stdin, Read-Host returns an empty string forever at
    # end of input. Guard against that so the demo cannot spin.
    if ([string]::IsNullOrWhiteSpace($first) -and [Console]::IsInputRedirected) {
        $emptyReads++
        if ($emptyReads -ge 3) { break }
    } else { $emptyReads = 0 }
    if ($null -eq $first) { break }
    $first = $first.Trim()
    if (-not $first) { continue }
    if ($first.ToLower() -in @('q', 'quit', 'exit', 'n', 'no')) { break }

    $second = Read-Host '  second > '
    if ($null -eq $second) { break }
    $second = $second.Trim()
    if (-not $second) { continue }
    if ($second.ToLower() -in @('q', 'quit', 'exit', 'n', 'no')) { break }

    Write-Host (Format-Safe "  $first + $second  ->  waiting for the browser tab ...")
    $r = Invoke-Pair -P $Port -First $first -Second $second
    if ($r.Status -eq 200 -and $null -ne $r.Body -and -not $r.Body.error) {
        $flag = if ($r.Body.isNew) { '   [NEW]' } else { '' }
        Write-Host (Format-Safe ("  => {0} {1}{2}" -f $r.Body.result, $r.Body.emoji, $flag)) -ForegroundColor Green
    } else {
        Write-Host (Format-Safe "  => HTTP $($r.Status)  $($r.Body.error)") -ForegroundColor Red
    }
    Write-Host ''
}

Write-Host ''
Write-Host '  Demo finished. Stopping the bridge.'
if ($null -ne $started.Proc) {
    # /T kills the whole tree: a PyInstaller one-file exe is a bootloader plus a
    # child, and killing only the parent would leave the port occupied.
    & taskkill /F /T /PID $started.Proc.Id 2>&1 | Out-Null
}
exit 0
