<#
    Infinite Craft Bridge by cinovenx
    ============================================
    This file is the PowerShell host for the local bridge. No Python required.
    It is the bridge only - use demo.bat / demo.ps1 for a guided tour.

    The HTTP core lives in C# (Add-Type) so the listener never deadlocks:
    every request is dispatched to the thread pool, which matters because a
    /pair request waits for the browser tab while /queue and /result must stay
    responsive at the same time.

    Usage:
        bridge.bat                    start the bridge on port 4242
        bridge.bat 8080               start the bridge on port 8080

    Or directly:
        powershell -File bridge.ps1 -Port 4242

    Entry point: bridge.bat -> this file. Keep them together.
#>
param(
    [int]$Port = 4242
)

$ErrorActionPreference = 'Stop'

$AppName = 'Infinite Craft Bridge by cinovenx'
$Version = '1.0'
$Author = 'cinovenx'
$GitHubUrl = 'https://github.com/cinovenx/inf-craft-bridge'
$TabUrl = 'https://neal.fun/infinite-craft/'
$DefaultPort = 4242
$WaitTimeoutMs = 60000

function Write-Banner {
    Write-Host ''
    Write-Host ('=' * 66)
    Write-Host ("  $AppName v$Version")
    Write-Host ("  by $Author  -  $GitHubUrl")
    Write-Host ('=' * 66)
}

# Windows consoles still default to legacy code pages (cp1251, cp1252, ...).
# Game results are full of emoji, so writing them raw can corrupt the console or
# throw. Try UTF-8 first, and fall back to '?' for anything unrepresentable.
function Initialize-Console {
    try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
    try {
        $OutputEncoding = [System.Text.Encoding]::UTF8
        $global:__cxUtf8 = $true
    } catch { $global:__cxUtf8 = $false }
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

function Get-MarkerPath {
    $base = $env:APPDATA
    if ([string]::IsNullOrWhiteSpace($base)) { $base = $HOME }
    return (Join-Path $base 'cinovenx\first-run.done')
}

function Invoke-FirstRunNotice {
    $marker = Get-MarkerPath
    if (Test-Path -LiteralPath $marker) { return }
    Write-Host ''
    Write-Host ('-' * 66)
    Write-Host '  First run - one quick step.'
    Write-Host ''
    Write-Host '  To use this bridge you need the companion userscript:'
    Write-Host "      1. Go to GitHub:  $GitHubUrl"
    Write-Host '      2. Download  infinite-craft-bridge.user.js'
    Write-Host "      3. Install it in Tampermonkey, then open $TabUrl"
    Write-Host ('-' * 66)
    $answer = Read-Host '  Press ENTER to open GitHub in your browser, or type n to skip'
    if ($answer.Trim().ToLower() -notin @('n', 'no')) {
        try {
            Start-Process $GitHubUrl
            Write-Host '  Browser opened.'
        } catch {
            Write-Host "  Could not open a browser automatically: $($_.Exception.Message)"
            Write-Host "  Please copy this link manually: $GitHubUrl"
        }
    }
    try {
        $dir = Split-Path -Parent $marker
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Set-Content -LiteralPath $marker -Value $GitHubUrl -Encoding UTF8
    } catch { }
    Write-Host '  This message will not appear again.'
    Write-Host ''
}

$csharp = @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

public static class CinovenxBridge {
    public class TaskItem { public string Id; public string First; public string Second; }
    public class Pending { public ManualResetEventSlim Ev = new ManualResetEventSlim(false); public bool Ok; public string BodyJson; public string Error; }

    static ConcurrentQueue<TaskItem> queue = new ConcurrentQueue<TaskItem>();
    static ConcurrentDictionary<string, Pending> pending = new ConcurrentDictionary<string, Pending>();
    static int waitMs = 60000;

    static string Now() { return DateTime.Now.ToString("HH:mm:ss"); }
    static string Esc(string s) {
        if (s == null) return "";
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
    }

    static void Send(HttpListenerContext ctx, int code, string json) {
        byte[] b = Encoding.UTF8.GetBytes(json);
        var r = ctx.Response;
        r.StatusCode = code;
        r.ContentType = "application/json; charset=utf-8";
        r.Headers["Access-Control-Allow-Origin"] = "*";
        r.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
        r.Headers["Access-Control-Allow-Headers"] = "Content-Type";
        r.ContentLength64 = b.Length;
        r.OutputStream.Write(b, 0, b.Length);
        r.OutputStream.Close();
    }
    static void SendEmpty(HttpListenerContext ctx, int code) {
        var r = ctx.Response;
        r.StatusCode = code;
        r.Headers["Access-Control-Allow-Origin"] = "*";
        r.ContentLength64 = 0;
        r.OutputStream.Close();
    }

    static Dictionary<string, string> ParseQs(string q) {
        var d = new Dictionary<string, string>();
        if (q == null) return d;
        if (q.StartsWith("?")) q = q.Substring(1);
        foreach (var p in q.Split('&')) {
            if (p.Length == 0) continue;
            int i = p.IndexOf('=');
            string k, v;
            if (i < 0) { k = p; v = ""; } else { k = p.Substring(0, i); v = p.Substring(i + 1); }
            k = WebUtility.UrlDecode(k);
            v = WebUtility.UrlDecode(v);
            if (!d.ContainsKey(k)) d[k] = v;
        }
        return d;
    }

    static string ExtractString(string json, string key) {
        var m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"");
        if (!m.Success) return null;
        return Regex.Unescape(m.Groups[1].Value);
    }
    static bool ExtractBool(string json, string key, bool def) {
        var m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*(true|false)");
        if (!m.Success) return def;
        return m.Groups[1].Value == "true";
    }
    // Raw JSON of the "body" value (object/array/string/number/true/false/null), brace aware.
    static string ExtractRaw(string json, string key) {
        int ki = json.IndexOf("\"" + key + "\"");
        if (ki < 0) return null;
        int ci = json.IndexOf(':', ki + key.Length + 2);
        if (ci < 0) return null;
        int i = ci + 1;
        while (i < json.Length && char.IsWhiteSpace(json[i])) i++;
        if (i >= json.Length) return null;
        char c = json[i];
        if (c == '{' || c == '[') {
            char open = c, close = c == '{' ? '}' : ']';
            int depth = 0; bool inStr = false; bool esc = false;
            int j = i;
            for (; j < json.Length; j++) {
                char ch = json[j];
                if (inStr) {
                    if (esc) esc = false;
                    else if (ch == '\\') esc = true;
                    else if (ch == '"') inStr = false;
                } else {
                    if (ch == '"') inStr = true;
                    else if (ch == open) depth++;
                    else if (ch == close) { depth--; if (depth == 0) { j++; break; } }
                }
            }
            return json.Substring(i, j - i);
        }
        if (c == '"') {
            int j = i + 1; bool esc = false;
            for (; j < json.Length; j++) {
                char ch = json[j];
                if (esc) esc = false;
                else if (ch == '\\') esc = true;
                else if (ch == '"') { j++; break; }
            }
            return json.Substring(i, j - i);
        }
        int k = i;
        while (k < json.Length && json[k] != ',' && json[k] != '}') k++;
        return json.Substring(i, k - i).Trim();
    }

    static void Handle(object o) {
        var ctx = (HttpListenerContext)o;
        var req = ctx.Request;
        try {
            if (req.HttpMethod == "OPTIONS") { SendEmpty(ctx, 204); return; }
            string path = req.Url.AbsolutePath;
            if (path.Length > 1 && path.EndsWith("/")) path = path.TrimEnd('/');
            if (path == "/status") {
                Send(ctx, 200, "{\"ok\":true,\"bridge\":\"cinovenx\",\"queue\":" + queue.Count +
                       ",\"pending\":" + pending.Count + "}");
                return;
            }
            if (path == "/queue") {
                TaskItem t;
                if (queue.TryDequeue(out t))
                    Send(ctx, 200, "{\"id\":\"" + t.Id + "\",\"first\":\"" + Esc(t.First) +
                         "\",\"second\":\"" + Esc(t.Second) + "\"}");
                else
                    SendEmpty(ctx, 204);
                return;
            }
            if (path == "/pair" || path == "/api/infinite-craft/pair") {
                var qs = ParseQs(req.Url.Query);
                string first, second;
                qs.TryGetValue("first", out first);
                qs.TryGetValue("second", out second);
                first = (first ?? "").Trim();
                second = (second ?? "").Trim();
                if (first.Length == 0 || second.Length == 0) {
                    Send(ctx, 400, "{\"ok\":false,\"error\":\"missing first/second. Usage: " +
                           "/pair?first=Water&second=Fire\"}");
                    return;
                }
                string id = Guid.NewGuid().ToString("N").Substring(0, 12);
                var p = new Pending();
                pending[id] = p;
                queue.Enqueue(new TaskItem { Id = id, First = first, Second = second });
                Console.WriteLine("[{0}] queued {1}: {2} + {3}", Now(), id, first, second);
                if (!p.Ev.Wait(waitMs)) {
                    Pending dummy; pending.TryRemove(id, out dummy);
                    Console.WriteLine("[{0}] timeout {1}: is the game tab open with the bridge enabled?", Now(), id);
                    Send(ctx, 504, "{\"ok\":false,\"error\":\"no response from the browser tab: open " +
                           "https://neal.fun/infinite-craft/ and click 'Connect' in the bridge panel\"}");
                    return;
                }
                Pending done; pending.TryRemove(id, out done);
                if (done != null && done.Ok) {
                    Send(ctx, 200, done.BodyJson ?? "{\"ok\":true}");
                    Console.WriteLine("[{0}] done {1}", Now(), id);
                } else {
                    string err = (done != null && done.Error != null) ? done.Error : "bridge error";
                    Send(ctx, 500, "{\"ok\":false,\"error\":\"" + Esc(err) + "\"}");
                    Console.WriteLine("[{0}] failed {1}: {2}", Now(), id, err);
                }
                return;
            }
            if (path == "/result" && req.HttpMethod == "POST") {
                string raw;
                using (var sr = new StreamReader(req.InputStream, Encoding.UTF8)) raw = sr.ReadToEnd();
                string id = ExtractString(raw, "id");
                if (string.IsNullOrEmpty(id)) { Send(ctx, 400, "{\"ok\":false,\"error\":\"missing id\"}"); return; }
                Pending e;
                if (!pending.TryGetValue(id, out e)) { Send(ctx, 404, "{\"ok\":false,\"error\":\"unknown id (maybe timed out)\"}"); return; }
                e.Ok = ExtractBool(raw, "ok", true);
                e.Error = ExtractString(raw, "error") ?? "";
                e.BodyJson = ExtractRaw(raw, "body");
                e.Ev.Set();
                Send(ctx, 200, "{\"ok\":true}");
                return;
            }
            Send(ctx, 404, "{\"ok\":false,\"error\":\"unknown path " + Esc(path) + ". Use /pair, /status or /queue\"}");
        } catch (Exception ex) {
            try { Send(ctx, 500, "{\"ok\":false,\"error\":\"" + Esc(ex.Message) + "\"}"); } catch { }
        }
    }

    public static void Start(int port, int waitMsArg) {
        waitMs = waitMsArg;
        var listener = new HttpListener();
        listener.Prefixes.Add("http://127.0.0.1:" + port + "/");
        try {
            listener.Start();
        } catch (Exception ex) {
            Console.WriteLine("");
            Console.WriteLine("  Cannot listen on port " + port + ": " + ex.Message);
            Console.WriteLine("  The port is probably already used by another instance of the bridge.");
            Console.WriteLine("  Try another port, for example:  bridge.bat " + (port + 1));
            Console.WriteLine("");
            Environment.Exit(1);
        }
        while (listener.IsListening) {
            try {
                var ctx = listener.GetContext();
                ThreadPool.QueueUserWorkItem(new WaitCallback(Handle), ctx);
            } catch { break; }
        }
    }
}
'@

Write-Banner
Initialize-Console
Invoke-FirstRunNotice

Add-Type -TypeDefinition $csharp

Write-Host ''
Write-Host "  Bridge listening on  http://127.0.0.1:$Port"
Write-Host "  Endpoint:  http://127.0.0.1:$Port/pair?first=Water&second=Fire"
Write-Host "  Alias:     http://127.0.0.1:$Port/api/infinite-craft/pair?first=Water&second=Fire"
Write-Host '  Extra query parameters are ignored.'
Write-Host ''
Write-Host '  Keep this page open and click ''Connect'' in the bridge panel:'
Write-Host "      $TabUrl"
Write-Host ''
Write-Host '  Want a guided tour? Run demo.bat (Windows) or demo.ps1.'
Write-Host ''

[CinovenxBridge]::Start($Port, $WaitTimeoutMs)
