#!/usr/bin/env python3
"""
Infinite Craft Bridge by cinovenx - interactive demo
====================================================
A hands-on demonstration: it starts the bridge as a separate process and then
lets you craft interactively - you type the first element, then the second one,
you get the result, and it asks again. Type 'q' to quit.

This script contains no bridge code of its own. It launches one of these,
in order of preference, from the same folder:

    cinovenx-bridge.exe        compiled bridge, nothing to install
    bridge.py                  bridge written in Python
    bridge.bat / bridge.ps1    bridge written in PowerShell

Usage:
    python demo.py                port 4242
    python demo.py 8080           another port
    demo.exe / demo.exe 8080      compiled version, same thing

Before the first craft, open https://neal.fun/infinite-craft/ in a browser with
the userscript installed and press "Connect" in the panel.
"""

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

APP_NAME = "Infinite Craft Bridge by cinovenx"
GITHUB_URL = "https://github.com/cinovenx/inf-craft-bridge"
TAB_URL = "https://neal.fun/infinite-craft/"
DEFAULT_PORT = 4242
WAIT_SECONDS = 90
PAIR_TIMEOUT = 80


# ---------------------------------------------------------------- output ---
def _force_utf8():
    """Windows consoles often default to legacy code pages (cp1251, cp1252).
    Results are full of emoji, so printing must never raise."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def say(text=""):
    try:
        print(text, flush=True)
    except UnicodeEncodeError:
        safe = "".join(c if c == "\n" or 32 <= ord(c) < 127 else "?" for c in str(text))
        try:
            print(safe, flush=True)
        except Exception:
            pass
    except Exception:
        pass


# ------------------------------------------------------------------ paths ---
def here():
    if getattr(sys, "frozen", False):          # running from demo.exe
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def candidate_folders():
    """Where to look for the bridge.

    The release ships them in separate folders ("pick one" each), so check this
    folder first and then the sibling bridge folder(s).
    """
    root = here()
    parent = os.path.dirname(root)
    return [
        root,
        os.path.join(parent, "bridge (pick one)"),
        os.path.join(parent, "bridge"),
        parent,
    ]


def find_bridge():
    """Return (argv, label) for the bridge to launch, or (None, None)."""
    for folder in candidate_folders():
        exe = os.path.join(folder, "cinovenx-bridge.exe")
        if os.path.isfile(exe):
            return [exe], "cinovenx-bridge.exe"
    for folder in candidate_folders():
        py = os.path.join(folder, "bridge.py")
        if os.path.isfile(py):
            interp = sys.executable if sys.executable else "python"
            return [interp, py], "bridge.py"
    for folder in candidate_folders():
        bat = os.path.join(folder, "bridge.bat")
        if os.path.isfile(bat):
            return [bat], "bridge.bat"
    for folder in candidate_folders():
        ps1 = os.path.join(folder, "bridge.ps1")
        if os.path.isfile(ps1):
            return ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], "bridge.ps1"
    return None, None


# ------------------------------------------------------------------ bridge ---
def bridge_alive(port, timeout=2):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/status" % port, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def start_bridge(port):
    """Start the bridge as a child process unless one is already running.
    Returns (process_or_None, note)."""
    if bridge_alive(port):
        return None, "using the bridge that is already running"
    argv, label = find_bridge()
    if argv is None:
        return None, "NO BRIDGE FOUND"
    say("  Starting the bridge (%s)..." % label)
    try:
        proc = subprocess.Popen(argv + [str(port)])
    except Exception as exc:
        return None, "could not start %s: %s" % (label, exc)
    for _ in range(WAIT_SECONDS * 2):
        if bridge_alive(port):
            return proc, "started %s" % label
        if proc.poll() is not None:
            return None, "%s exited immediately (port %d busy?)" % (label, port)
        time.sleep(0.5)
    try:
        proc.kill()
    except Exception:
        pass
    return None, "%s did not answer on port %d" % (label, port)


def stop_bridge(proc, port):
    """Stop the bridge we started.

    On Windows a PyInstaller one-file exe is a bootloader that spawns the real
    process, so terminate() alone would leave the grandchild holding the port.
    taskkill /T kills the whole tree, which is what we need.
    """
    if proc is None:
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        else:
            proc.terminate()
            try:
                proc.wait(5)
            except Exception:
                proc.kill()
    except Exception:
        pass
    for _ in range(20):            # wait until the port is released
        if not bridge_alive(port):
            return
        time.sleep(0.25)


# -------------------------------------------------------------------- pair ---
def pair(port, first, second):
    query = urllib.parse.urlencode({"first": first, "second": second})
    url = "http://127.0.0.1:%d/pair?%s" % (port, query)
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=PAIR_TIMEOUT) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(raw)
        except ValueError:
            return exc.code, {"error": raw[:200]}
    except Exception as exc:
        return 0, {"error": str(exc)}


def is_quit(text):
    return text.strip().lower() in ("q", "quit", "exit", "n", "no")


# -------------------------------------------------------------------- loop ---
def demo_loop(port):
    say("  ------------------------------------------------------------")
    say("  Type the first element, then the second one.")
    say("  You get the result from the real neal.fun API, then it asks again.")
    say("  Type 'q' at any prompt to quit.")
    say("  ------------------------------------------------------------")
    say()
    while True:
        try:
            first = input("  first  > ").strip()
        except (EOFError, KeyboardInterrupt):
            say()
            return
        if not first:
            continue
        if is_quit(first):
            return
        try:
            second = input("  second > ").strip()
        except (EOFError, KeyboardInterrupt):
            say()
            return
        if not second:
            continue
        if is_quit(second):
            return
        say("  %s + %s  ->  waiting for the browser tab ..." % (first, second))
        status, body = pair(port, first, second)
        if status == 200 and isinstance(body, dict) and "error" not in body:
            emoji = body.get("emoji", "")
            new = "   [NEW]" if body.get("isNew") else ""
            say("  => %s %s%s" % (body.get("result", "(no result)"), emoji, new))
        else:
            say("  => HTTP %s  %s" % (status, body.get("error", body)))
        say()


# -------------------------------------------------------------------- main ---
def main(argv):
    _force_utf8()
    args = list(argv[1:])
    if any(a in ("-h", "--help", "help", "/?") for a in args):
        say(__doc__.strip())
        return 0

    port = DEFAULT_PORT
    for arg in args:
        if arg.lower().startswith("--port="):
            args = [arg.split("=", 1)[1]]
            break
    if args:
        try:
            port = int(args[0])
        except ValueError:
            say("  '%s' is not a valid port, using %d" % (args[0], DEFAULT_PORT))
    if not (1 <= port <= 65535):
        say("  Port %d is out of range, using %d" % (port, DEFAULT_PORT))
        port = DEFAULT_PORT

    say()
    say("=" * 66)
    say("  %s - interactive demo" % APP_NAME)
    say("  %s" % GITHUB_URL)
    say("=" * 66)
    say()

    say("  You need the userscript running in a browser tab:")
    say("      %s" % TAB_URL)
    say("  Press 'Connect' in the cinovenx panel there, then come back.")
    say()

    proc, note = start_bridge(port)
    if note == "NO BRIDGE FOUND":
        say("  I could not find the bridge next to this script.")
        say("  Expected one of: cinovenx-bridge.exe, bridge.py, bridge.bat, bridge.ps1")
        say("  Get the full package from %s" % GITHUB_URL)
        return 1
    if proc is None and note != "using the bridge that is already running":
        say("  %s" % note)
        say("  Start the bridge manually and try again, or use another port.")
        return 1

    say("  Bridge: %s on port %d" % (note, port))
    say()
    demo_loop(port)

    say()
    say("  Demo finished. Stopping the bridge.")
    stop_bridge(proc, port)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
