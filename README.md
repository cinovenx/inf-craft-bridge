# Infinite Craft Bridge by cinovenx

**by [cinovenx](https://github.com/cinovenx)**

Use the [neal.fun](https://neal.fun/infinite-craft/) *Infinite Craft* API from your own
Python scripts, over a local port.

```
Python script  ->  http://127.0.0.1:4242/pair?first=Water&second=Fire
              ->  the bridge           ->  the browser tab runs the real API call
              ->  the game answers     ->  the bridge  ->  your script gets the JSON
```

---

## Why this exists

The game API is protected by Cloudflare Turnstile, so any request made outside a real
browser tab is rejected. Neither side can do the job alone: a browser cannot listen on
a TCP port, and Python cannot produce a valid Turnstile token.

So the work is split in two:

| Part | Job |
|---|---|
| `cinovenx-bridge` (exe / bat / ps1 / py) | Opens a local port on `127.0.0.1` and passes the work to the tab |
| `infinite-craft-bridge.user.js` | Runs inside the game page, calls the real API with a valid token, returns the answer |

**No manual crafting is required.** The site publishes its own credentials as page
globals (`window.turnstileToken` and `window.craftSessionToken`); the userscript reads
them directly. If a token ever expires, the userscript refreshes it by itself and
retries.

---

## Package layout

Download the whole package and keep this structure:

```
infinite-craft-bridge/
├── infinite-craft-bridge.user.js     the userscript
├── README.md
├── LICENSE
├── bridge (pick one)/
│   ├── cinovenx-bridge.exe           Windows, nothing to install   \
│   ├── bridge.bat                    Windows, nothing to install    |  any ONE
│   ├── bridge.ps1                    Windows, nothing to install   |
│   └── bridge.py                     Python 3.7+                   /
└── demo (pick one)/
    ├── demo.exe                      Windows, nothing to install   \
    ├── demo.bat                      Windows, nothing to install    |  any ONE
    ├── demo.ps1                      Windows, nothing to install   |
    └── demo.py                       Python 3.7+                   /
```

* **Pick one** file from each folder. All builds of the same kind are
  interchangeable and speak the same protocol.
* The demo finds the bridge next to itself or in the sibling `bridge (pick one)`
  folder, so keep the two folders side by side.
* `bridge.bat` needs `bridge.ps1` next to it, `demo.bat` needs `demo.ps1` next to
  it. Keep each pair together.
* Windows may warn about the unsigned `.exe` files (SmartScreen): choose
  *More info* -> *Run anyway*.

---

## Quick start

### 1. Install the userscript

1. Open [`infinite-craft-bridge.user.js`](infinite-craft-bridge.user.js) in
   Tampermonkey and confirm the installation
2. Go to <https://neal.fun/infinite-craft/>

On the first run a one-time notice appears, with a button that takes you to this
repository.

### 2. Pick a bridge and start it

From `bridge (pick one)/` - see the table above for what each one needs.

On the very first run the bridge shows a short notice and offers to open this
repository in your browser.

### 3. Connect the tab

In the game page click the **♾️ Bridge** button in the **middle-left** of the screen
and press **Connect**. The port and the on/off state are remembered, so reloading the
page keeps them.

### 4. Craft from your code

```bash
curl "http://127.0.0.1:4242/pair?first=Water&second=Fire"
```

```json
{"result": "Steam", "emoji": "💨", "isNew": false}
```

---

## Interactive demo

Not sure how it works? Run the demo. It starts the bridge for you and then walks you
through it: you type the first element, then the second one, you get the result, and
it asks again.

```
$ demo.bat                    (or demo.exe, or python demo.py)

  first  > Water
  second > Fire
  Water + Fire  ->  waiting for the browser tab ...
  => Steam 💨

  first  > Earth
  second > Wind
  Earth + Wind  ->  waiting for the browser tab ...
  => Tornado 🌪️   [NEW]

  first  > q
  Demo finished. Stopping the bridge.
```

Three identical demos, same behaviour. Run one from `demo (pick one)/`:

| Command | Needs |
|---|---|
| `demo.bat` | nothing |
| `demo.exe` | nothing |
| `python demo.py` | Python 3.7+ |

`demo.bat 8080` / `demo.exe 8080` / `python demo.py 8080` use another port.

The demo scripts contain **no bridge code**. Each one launches the bridge as a
separate process - it looks for `cinovenx-bridge.exe`, `bridge.py`, `bridge.bat` or
`bridge.ps1` next to itself and then in the sibling `bridge (pick one)` folder - and
stops it again when you quit. If a bridge is already running, the demo simply uses it.

Before the first craft, open <https://neal.fun/infinite-craft/>, press **Connect** in
the panel, then come back to the demo.

---

## HTTP API

The bridge listens on `127.0.0.1` only, so nothing is reachable from your network.

### `GET /pair`

| Parameter | Required | Description |
|---|---|---|
| `first` | yes | first element |
| `second` | yes | second element |
| anything else | no | **ignored**, never an error |

```bash
curl "http://127.0.0.1:4242/pair?first=Item%201&second=Any%20Item&debug=1"
```

`Item 1` and `Any Item` arrive untouched, and `debug=1` is ignored.

`GET /api/infinite-craft/pair` is an alias with identical behaviour.

**Responses**

| Code | Meaning |
|---|---|
| `200` | the game answered, body is the raw neal.fun JSON |
| `400` | `first` or `second` is missing |
| `500` | the page reported a failure (details in `error`) |
| `504` | no answer from the browser tab within 60 s - open the game and press Connect |

### Internal endpoints

Used by the userscript, not meant for day-to-day use.

| Endpoint | Purpose |
|---|---|
| `GET /queue` | next queued task for the tab, `204` when empty |
| `POST /result` | the tab returns the answer |
| `GET /status` | `{"ok":true,"bridge":"cinovenx","queue":0,"pending":0}` |

---

## Using it from Python

Standard library only:

```python
import json
import urllib.parse
import urllib.request


def pair(first, second, port=4242):
    query = urllib.parse.urlencode({"first": first, "second": second})
    url = f"http://127.0.0.1:{port}/pair?{query}"
    with urllib.request.urlopen(url, timeout=80) as response:
        return json.loads(response.read().decode("utf-8"))


print(pair("Water", "Fire"))
# {'result': 'Steam', 'emoji': '💨', 'isNew': False}
```

---

## Files

**`bridge (pick one)/`** - the bridge, all four builds speak the same protocol:

| File | What it is |
|---|---|
| `cinovenx-bridge.exe` | compiled bridge for Windows, nothing to install |
| `bridge.bat` | double-click launcher for Windows |
| `bridge.ps1` | PowerShell host, the real engine behind `bridge.bat` |
| `bridge.py` | bridge written in Python, standard library only |

**`demo (pick one)/`** - the interactive demo, identical behaviour:

| File | What it is |
|---|---|
| `demo.exe` | compiled demo for Windows, nothing to install |
| `demo.bat` | double-click launcher for Windows |
| `demo.ps1` | the real engine behind `demo.bat` |
| `demo.py` | the same demo in Python, standard library only |

**Root:**

| File | What it is |
|---|---|
| `infinite-craft-bridge.user.js` | installed in Tampermonkey |

---

## Notes and limits

* **One pair at a time.** The Turnstile token is single use, so the userscript handles
  requests one by one on purpose.
* **The tab must stay open.** Pairs wait up to 60 seconds for the browser, otherwise
  you get `504`.
* **Pair order follows the game.** Elements are sorted with `localeCompare`, exactly
  like the game client, so results match what you see in the browser. Turn it off with
  the *sort the pair like the game* checkbox in the panel.
* **The port** defaults to `4242` and can be changed in the panel or on the command
  line (`cinovenx-bridge.exe 8080`).
* Cloudflare may occasionally challenge the tab. The userscript notices that, refreshes
  the token and retries automatically, up to three attempts.

---

## License

MIT - see [LICENSE](LICENSE).
