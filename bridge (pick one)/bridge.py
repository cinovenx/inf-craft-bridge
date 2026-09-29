#!/usr/bin/env python3
"""
Infinite Craft Bridge by cinovenx
=================================
Local bridge between Python scripts and the neal.fun "Infinite Craft" game.

The browser cannot listen on a TCP port, so this program opens a local port on
127.0.0.1. The Tampermonkey userscript polls that port from the game page,
performs the real API call from the page (correct cookies, origin and
Cloudflare Turnstile token) and returns the answer here.

This file is the bridge only. For a hands-on demonstration use demo.py /
demo.ps1 / demo.bat (or demo.exe), which start this bridge and then let you
craft interactively.

Standard library only - no pip install required.

Usage
-----
    python bridge.py                 start the bridge on port 4242
    python bridge.py 8080            start the bridge on port 8080
    python bridge.py --help

Compiled Windows build:
    cinovenx-bridge.exe
    cinovenx-bridge.exe 8080

HTTP API (served on 127.0.0.1)
-----------------------------
    GET  /pair?first=A&second=B[&anything=ignored]
         -> waits for the userscript, returns the neal.fun JSON answer.
            Extra query parameters are ignored, never an error.
    GET  /api/infinite-craft/pair?first=A&second=B
         -> alias of /pair, identical behaviour.
    GET  /queue     -> used by the userscript only: 204 when empty,
                        otherwise {"id","first","second"}.
    POST /result    -> used by the userscript only: {"id","ok","body"} or
                        {"id","ok":false,"error"}.
    GET  /status    -> {"ok":true,"bridge","queue","pending"}.

Notes
-----
* The bridge binds 127.0.0.1 only, so nothing is reachable from the network.
* Extra arguments in a /pair request are ignored on purpose.
* Keep https://neal.fun/infinite-craft/ open with the userscript enabled,
  otherwise /pair times out with HTTP 504.
"""

import json
import os
import sys
import threading
import time
import uuid
import webbrowser
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

APP_NAME = "Infinite Craft Bridge by cinovenx"
AUTHOR = "cinovenx"
VERSION = "1.0"
GITHUB_URL = "https://github.com/cinovenx/inf-craft-bridge"
TAB_URL = "https://neal.fun/infinite-craft/"

DEFAULT_PORT = 4242
WAIT_TIMEOUT = 60          # seconds to wait for the browser tab

_queue = deque()
_queue_lock = threading.Lock()
_pending = {}              # id -> {"event": Event, "result": dict|None}
_pending_lock = threading.Lock()

_server_started = threading.Event()


# --------------------------------------------------------------------------
# logging helpers
# --------------------------------------------------------------------------
def log(*parts):
    print("[%s]" % time.strftime("%H:%M:%S"), *parts, flush=True)


def _force_utf8():
    """Windows consoles still default to legacy code pages (cp1251, cp1252, ...).
    Game results are full of emoji, so a plain print would raise
    UnicodeEncodeError and kill the process. Make stdout/stderr forgiving."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def say(text=""):
    """Print that can never raise, whatever the console encoding is."""
    try:
        print(text, flush=True)
    except UnicodeEncodeError:
        safe = "".join(ch if ch == "\n" or 32 <= ord(ch) < 127 else "?" for ch in str(text))
        try:
            print(safe, flush=True)
        except Exception:
            pass
    except Exception:
        pass


def banner():
    say()
    say("=" * 66)
    say("  %s v%s" % (APP_NAME, VERSION))
    say("  by %s  -  %s" % (AUTHOR, GITHUB_URL))
    say("=" * 66)


# --------------------------------------------------------------------------
# first run notice
# --------------------------------------------------------------------------
def _marker_path():
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    return os.path.join(base, "cinovenx", "first-run.done")


def first_run_notice():
    """Once per machine: point the user at GitHub, then offer to open it."""
    marker = _marker_path()
    if os.path.exists(marker):
        return
    say()
    say("-" * 66)
    say("  First run - one quick step.")
    say()
    say("  To use this bridge you need the companion userscript:")
    say("      1. Go to GitHub:  %s" % GITHUB_URL)
    say("      2. Download  infinite-craft-bridge.user.js")
    say("      3. Install it in Tampermonkey, then open %s" % TAB_URL)
    say("-" * 66)
    try:
        answer = input("  Press ENTER to open GitHub in your browser, or type n to skip: ")
    except EOFError:
        answer = "n"
    if answer.strip().lower() not in ("n", "no"):
        try:
            webbrowser.open(GITHUB_URL)
            say("  Browser opened.")
        except Exception as exc:                      # pragma: no cover
            say("  Could not open a browser automatically: %s" % exc)
            say("  Please copy this link manually: %s" % GITHUB_URL)
    try:
        os.makedirs(os.path.dirname(marker), exist_ok=True)
        with open(marker, "w", encoding="utf-8") as handle:
            handle.write(GITHUB_URL)
    except OSError:
        pass
    say("  This message will not appear again.")
    say()


# --------------------------------------------------------------------------
# HTTP layer
# --------------------------------------------------------------------------
def send_json(handler, code, obj, raw_text=None):
    if raw_text is not None:
        body = raw_text.encode("utf-8")
    else:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.end_headers()
    handler.wfile.write(body)


class Handler(BaseHTTPRequestHandler):
    server_version = "cinovenx-bridge/" + VERSION

    def log_message(self, fmt, *args):
        log("%s %s" % (self.command, self.path))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = parse_qs(parsed.query, keep_blank_values=True)

        if path == "/status":
            with _queue_lock:
                queued = len(_queue)
            with _pending_lock:
                pending = len(_pending)
            send_json(self, 200, {"ok": True, "bridge": "cinovenx", "version": VERSION,
                                  "queue": queued, "pending": pending})
            return

        if path == "/queue":
            with _queue_lock:
                task = _queue.popleft() if _queue else None
            if task is None:
                self.send_response(204)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            send_json(self, 200, task)
            return

        if path in ("/pair", "/api/infinite-craft/pair"):
            self.handle_pair(query)
            return

        send_json(self, 404, {"ok": False,
                              "error": "unknown path %s. Use /pair, /status or /queue" % parsed.path})

    def handle_pair(self, query):
        # Unknown query parameters are ignored on purpose - never an error.
        first = (query.get("first", [""])[0] or "").strip()
        second = (query.get("second", [""])[0] or "").strip()
        if not first or not second:
            send_json(self, 400, {"ok": False,
                                  "error": "missing first/second. Usage: "
                                           "/pair?first=Water&second=Fire"})
            return
        task_id = uuid.uuid4().hex[:12]
        event = threading.Event()
        with _pending_lock:
            _pending[task_id] = {"event": event, "result": None}
        with _queue_lock:
            _queue.append({"id": task_id, "first": first, "second": second})
        log("queued %s: %r + %r" % (task_id, first, second))

        answered = event.wait(WAIT_TIMEOUT)
        with _pending_lock:
            entry = _pending.pop(task_id, None)
        if not answered or entry is None or entry["result"] is None:
            log("timeout %s: is the game tab open with the bridge enabled?" % task_id)
            send_json(self, 504, {"ok": False,
                                  "error": "no response from the browser tab: open %s "
                                           "and click 'Connect' in the bridge panel" % TAB_URL})
            return
        result = entry["result"]
        if result.get("ok"):
            body = result.get("body")
            if isinstance(body, (dict, list)):
                send_json(self, 200, body)
            else:
                send_json(self, 200, {"ok": True}, raw_text=str(body if body is not None else ""))
            log("done %s -> %s" % (task_id, (body or {}).get("result", "?")))
        else:
            send_json(self, 500, {"ok": False, "error": result.get("error", "bridge error")})
            log("failed %s: %s" % (task_id, result.get("error")))

    def do_POST(self):
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path != "/result":
            send_json(self, 404, {"ok": False, "error": "unknown path, use POST /result"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except Exception as exc:
            send_json(self, 400, {"ok": False, "error": "bad JSON: %s" % exc})
            return
        task_id = str(data.get("id", ""))
        if not task_id:
            send_json(self, 400, {"ok": False, "error": "missing id"})
            return
        with _pending_lock:
            entry = _pending.get(task_id)
            if entry is None:
                send_json(self, 404, {"ok": False, "error": "unknown id (maybe timed out)"})
                return
            entry["result"] = {"ok": bool(data.get("ok", True)),
                               "body": data.get("body"),
                               "error": data.get("error", "")}
            entry["event"].set()
        send_json(self, 200, {"ok": True})
        log("result <- %s ok=%s" % (task_id, data.get("ok")))


# --------------------------------------------------------------------------
# server lifecycle
# --------------------------------------------------------------------------
def start_server(port):
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError as exc:
        say()
        say("  Cannot listen on port %d: %s" % (port, exc))
        say("  The port is probably already used by another instance of the bridge.")
        say("  Try another port, for example:  %s %d" % (os.path.basename(sys.argv[0]), port + 1))
        say()
        return None
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, name="bridge", daemon=True)
    thread.start()
    _server_started.set()
    return server


def print_ready(port):
    say()
    say("  Bridge listening on  http://127.0.0.1:%d" % port)
    say("  Endpoint:  http://127.0.0.1:%d/pair?first=Water&second=Fire" % port)
    say("  Alias:     http://127.0.0.1:%d/api/infinite-craft/pair?first=Water&second=Fire" % port)
    say("  Extra query parameters are ignored.")
    say()
    say("  Keep this page open and click 'Connect' in the bridge panel:")
    say("      %s" % TAB_URL)
    say()
    say("  Want a guided tour? Run demo.bat (Windows) or python demo.py (Python).")
    say()


# --------------------------------------------------------------------------
# argument parsing
# --------------------------------------------------------------------------
def usage():
    say(__doc__.strip())


def main(argv):
    _force_utf8()
    args = list(argv[1:])
    if any(a in ("-h", "--help", "help", "/?") for a in args):
        usage()
        return 0

    ports = []
    for arg in args:
        if arg.lower().startswith("--port="):
            ports.append(arg.split("=", 1)[1])
            continue
        ports.append(arg)

    port = DEFAULT_PORT
    if ports:
        try:
            port = int(ports[0])
        except ValueError:
            say("  '%s' is not a valid port, using %d" % (ports[0], DEFAULT_PORT))
    if not (1 <= port <= 65535):
        say("  Port %d is out of range, using %d" % (port, DEFAULT_PORT))
        port = DEFAULT_PORT

    banner()
    first_run_notice()

    server = start_server(port)
    if server is None:
        return 1
    print_ready(port)

    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        say()
        say("  Bye. Stopping the bridge.")
        try:
            server.shutdown()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
