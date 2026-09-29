// ==UserScript==
// @name         Infinite Craft Bridge by cinovenx
// @namespace    https://github.com/cinovenx/inf-craft-bridge
// @version      3.0
// @description  Local bridge between Python scripts and neal.fun Infinite Craft. Fully automatic: the Turnstile token is read from the page, no manual crafting required. by cinovenx
// @author       cinovenx
// @match        https://neal.fun/infinite-craft/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @connect      127.0.0.1
// @connect      localhost
// @connect      neal.fun
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  var TAB_TITLE = 'Infinite Craft Bridge by cinovenx';
  var GITHUB_URL = 'https://github.com/cinovenx/inf-craft-bridge';
  var PAIR_URL = 'https://neal.fun/api/infinite-craft/pair';

  var DEFAULT_PORT = 4242;
  var POLL_MS = 800;
  var MAX_LOG = 300;
  var REQ_TIMEOUT = 25000;
  var MAX_ATTEMPTS = 3;

  var enabled = boolVal(GM_getValue('icb_enabled', false));
  var port = intVal(GM_getValue('icb_port', DEFAULT_PORT), DEFAULT_PORT);
  var sortLikeGame = boolVal(GM_getValue('icb_sort', true));
  var busy = false;
  var lastConnErr = 0;

  var hookReady = false;
  var auth = { token: '', session: '', widgetId: null };
  var authWatchTimer = null;
  var pending = {};          // reqId -> {resolve, timer}

  function boolVal(v) { return v === true || v === 'true' || v === 1; }
  function intVal(v, d) { var n = parseInt(v, 10); return isFinite(n) && n > 0 && n < 65536 ? n : d; }
  function base() { return 'http://127.0.0.1:' + port; }
  function now() { var d = new Date(); return d.toTimeString().slice(0, 8); }
  function mask(t) { t = String(t || ''); return t.length <= 10 ? '****' : t.slice(0, 4) + '…' + t.slice(-3); }

  /* ------------------------------------------------------------------ log */
  var logBox = null;
  var logs = [];
  function pushLog(msg, cls) {
    var line = '[' + now() + '] ' + msg;
    logs.push({ line: line, cls: cls || '' });
    if (logs.length > MAX_LOG) logs.shift();
    if (logBox) {
      var div = document.createElement('div');
      div.textContent = line;
      if (cls) div.className = cls;
      logBox.appendChild(div);
      while (logBox.children.length > MAX_LOG) logBox.removeChild(logBox.firstChild);
      logBox.scrollTop = logBox.scrollHeight;
    }
    try { console.log('[cinovenx]', line); } catch (e) {}
  }

  /* ======================================================================
   * PAGE HOOK - runs in the page context.
   *
   * Autonomy: the site itself publishes the credentials as page globals:
   *   window.turnstileToken     -> one-time token for the ?token= parameter
   *   window.craftSessionToken  -> sent as the x-craft-session header
   * We simply read them, so no manual crafting is ever needed.
   * Backups: intercept /verify, remember the Turnstile widget id, and mint a
   * fresh token with reset()+execute() if the current one is rejected.
   * ==================================================================== */
  var PAGE_HOOK_JS = [
    "(function(){",
    "if(window.__cinovenxHook){try{window.dispatchEvent(new CustomEvent('cx-hook-ready',{}));}catch(e){}return;}",
    "window.__cinovenxHook=true;",
    "function cxEmit(n,d){try{window.dispatchEvent(new CustomEvent(n,{detail:d}));}catch(e){}}",
    "function cxPath(u){u=String(u||'');var i=u.indexOf('?');return i<0?u:u.slice(0,i);}",
    "function cxIsVerify(u){return cxPath(u).indexOf('/api/infinite-craft/verify')>=0;}",
    "function cxTokenFrom(u){var m=/[?&]token=([^&]+)/.exec(String(u||''));return m?decodeURIComponent(m[1]):'';}",
    "var cxFetch=window.fetch;",
    "window.fetch=function(input,init){",
    " var u=(typeof input==='string')?input:((input&&input.url)||'');",
    " try{if(cxIsVerify(u)){var t=cxTokenFrom(u);if(t)cxEmit('cx-token-seen',{token:t});}}catch(e){}",
    " if(cxIsVerify(u)){",
    "  try{var p=cxFetch.call(window,input,init);",
    "   p.then(function(r){try{var c=(typeof r.clone==='function')?r.clone():r;c.text().then(function(x){try{var j=JSON.parse(x);if(j&&j.sessionToken)cxEmit('cx-session-seen',{session:j.sessionToken});}catch(e){}}).catch(function(){});}catch(e){}}).catch(function(){});",
    "   return p;}catch(e){}",
    " }",
    " return cxFetch.apply(this,arguments);",
    "};",
    "try{var X=window.XMLHttpRequest,oOpen=X.prototype.open,oSend=X.prototype.send;",
    " X.prototype.open=function(m,u){try{this.__u=u;if(cxIsVerify(u)){var t=cxTokenFrom(u);if(t)cxEmit('cx-token-seen',{token:t});}}catch(e){}return oOpen.apply(this,arguments);};",
    " X.prototype.send=function(b){",
    "  try{if(cxIsVerify(this.__u)){var s=this,ol=this.onload;this.onload=function(){try{var j=JSON.parse(s.responseText||'');if(j&&j.sessionToken)cxEmit('cx-session-seen',{session:j.sessionToken});}catch(e){}if(ol)ol.apply(s,arguments);};}}catch(e){}",
    "  return oSend.apply(this,arguments);};}catch(e){}",
    "function cxHookTS(){try{if(!window.turnstile)return false;var T=window.turnstile;if(T.__cxHooked)return true;T.__cxHooked=true;",
    " var oR=T.render,oRes=T.reset;",
    " T.render=function(el,p){var r=oR.apply(this,arguments);try{window.__cxWid=(r!==undefined&&r!==null)?r:window.__cxWid;cxEmit('cx-ts-widget',{id:window.__cxWid});}catch(e){}return r;};",
    " T.reset=function(){try{return oRes.apply(this,arguments);}catch(e){}};",
    " return true;}catch(e){return false;}}",
    "cxHookTS();window.setInterval(cxHookTS,1000);",
    "function cxGr(id){try{return id===undefined?((window.turnstile.getResponse())||''):((window.turnstile.getResponse(id))||'');}catch(e){return '';}}",
    "function cxMint(cb){try{cxHookTS();if(!window.turnstile){cb('');return;}",
    " var T=window.turnstile,wid=window.__cxWid,t=cxGr(wid);if(t){cb(t);return;}",
    " var t0=Date.now(),done=false;",
    " try{(wid===undefined)?T.reset():T.reset(wid);}catch(e){try{T.reset();}catch(e2){}}",
    " var iv=window.setInterval(function(){var x=cxGr(wid);if(x&&!done){done=true;window.clearInterval(iv);cb(x);return;}",
    "  if(!done&&Date.now()-t0>20000){done=true;window.clearInterval(iv);cb('');}},500);",
    " try{(wid===undefined)?T.execute():T.execute(wid);}catch(e){try{T.execute();}catch(e2){}}",
    "}catch(e){cb('');}}",
    "function cxRead(){return{token:String(window.turnstileToken||''),session:String(window.craftSessionToken||''),widgetId:(window.__cxWid!==undefined?window.__cxWid:null)};}",
    "var cxLast='';",
    "function cxWatch(){var a=cxRead(),sig=a.token+'|'+a.session;if(sig!==cxLast){cxLast=sig;cxEmit('cx-auth',a);}}",
    "window.setInterval(cxWatch,1000);",
    "window.addEventListener('cx-ts-widget',function(ev){try{var d=ev.detail||{};if(d.id!==undefined&&d.id!==null)window.__cxWid=d.id;cxWatch();}catch(e){}});",
    "window.addEventListener('cx-get-auth',function(){try{cxEmit('cx-auth',cxRead());}catch(e){cxEmit('cx-auth',{token:'',session:'',widgetId:null});}});",
    "window.addEventListener('cx-mint',function(ev){var r=((ev&&ev.detail)||{}).reqId;cxMint(function(t){cxEmit('cx-mint-done',{reqId:r,token:t||''});});});",
    "window.addEventListener('cx-page-get',function(ev){var d=(ev&&ev.detail)||{},r=d.reqId;",
    " var o={method:'GET',credentials:'include',headers:(d.headers||{})};",
    " cxFetch.call(window,String(d.url||''),o)",
    " .then(function(x){return x.text().then(function(t){cxEmit('cx-page-get-done',{reqId:r,ok:true,status:x.status,text:t});});})",
    " .catch(function(e){cxEmit('cx-page-get-done',{reqId:r,ok:false,error:String((e&&e.message)||e)});});});",
    "cxWatch();cxEmit('cx-hook-ready',{});",
    "})();"
  ].join("\n");

  /* ---------------------------------------------------------- hook install */
  function injectHook() {
    window.addEventListener('cx-hook-ready', function () {
      if (!hookReady) {
        hookReady = true;
        pushLog('page hook: ACTIVE', 'ok');
        refreshStatus();
      }
    });
    window.addEventListener('cx-auth', function (e) { onAuth(e && e.detail); });
    window.addEventListener('cx-token-seen', function (e) {
      var d = e && e.detail;
      if (d && d.token && d.token !== auth.token) {
        auth.token = d.token;
        pushLog('token picked up from /verify ' + mask(d.token), 'ok');
        refreshStatus();
      }
    });
    window.addEventListener('cx-session-seen', function (e) {
      var d = e && e.detail;
      if (d && d.session && d.session !== auth.session) { auth.session = d.session; refreshStatus(); }
    });
    window.addEventListener('cx-page-get-done', function (e) { settle(e && e.detail); });
    window.addEventListener('cx-mint-done', function (e) { settle(e && e.detail); });

    function tryInline() {
      var s = document.createElement('script');
      s.textContent = PAGE_HOOK_JS;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    }
    function tryBlob() {
      try {
        var b = new Blob([PAGE_HOOK_JS], { type: 'text/javascript' });
        var u = URL.createObjectURL(b);
        var s = document.createElement('script');
        s.src = u;
        s.onload = function () { try { URL.revokeObjectURL(u); } catch (e) {} s.remove(); };
        s.onerror = function () { s.remove(); };
        (document.head || document.documentElement).appendChild(s);
      } catch (e) {}
    }
    try { tryInline(); } catch (e) {}
    setTimeout(function () {
      if (!hookReady) tryBlob();
      setTimeout(function () {
        if (!hookReady) pushLog('page hook NOT active (page CSP) - pairing will fail', 'err');
        refreshStatus();
      }, 3000);
    }, 2500);
  }

  /* ------------------------------------------------------------------- IPC */
  function settle(d) {
    if (!d || !d.reqId) return;
    var p = pending[d.reqId];
    if (!p) return;
    delete pending[d.reqId];
    try { clearTimeout(p.timer); } catch (e) {}
    p.resolve(d);
  }
  function askPage(evt, detail, ms, timeoutMsg) {
    return new Promise(function (resolve) {
      var reqId = 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
      var to = setTimeout(function () { delete pending[reqId]; resolve({ ok: false, error: timeoutMsg }); }, ms);
      pending[reqId] = { resolve: resolve, timer: to };
      try {
        detail.reqId = reqId;
        window.dispatchEvent(new CustomEvent(evt, { detail: detail }));
      } catch (e) {
        clearTimeout(to);
        delete pending[reqId];
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }
  function pageGet(url, headers) {
    return askPage('cx-page-get', { url: url, headers: headers || {} }, REQ_TIMEOUT,
      'the page did not answer within ' + (REQ_TIMEOUT / 1000) + 's');
  }
  function askMint() {
    return askPage('cx-mint', {}, 30000, 'Turnstile did not answer within 30s')
      .then(function (d) { return (d && d.token) || ''; });
  }
  function askAuth() {
    return askPage('cx-get-auth', {}, 6000, 'the page did not answer').then(function (d) {
      if (d && d.token !== undefined) onAuth(d);
      return auth;
    });
  }

  /* --------------------------------------------------------- auth handling */
  function onAuth(d) {
    if (!d) return;
    var changed = false;
    if (d.token && d.token !== auth.token) { auth.token = d.token; changed = true; }
    if (d.session && d.session !== auth.session) { auth.session = d.session; changed = true; }
    if (d.widgetId !== undefined && d.widgetId !== null && d.widgetId !== auth.widgetId) auth.widgetId = d.widgetId;
    if (changed) {
      pushLog('token: ' + mask(auth.token) + '  |  x-craft-session: ' +
        (auth.session ? mask(auth.session) : 'none'), 'ok');
      refreshStatus();
    }
  }
  function buildPairUrl(first, second) {
    var a = String(first), b = String(second);
    // the game sorts the pair with localeCompare - match the client exactly
    var p = sortLikeGame ? [a, b].sort(function (x, y) { return x.localeCompare(y); }) : [a, b];
    return PAIR_URL + '?first=' + encodeURIComponent(p[0]) +
      '&second=' + encodeURIComponent(p[1]) +
      '&token=' + encodeURIComponent(auth.token);
  }
  function buildHeaders() {
    var h = {};
    if (auth.session) h['x-craft-session'] = auth.session;
    return h;
  }
  function looksLikeChallenge(t) {
    t = String(t || '');
    return t.indexOf('Just a moment') >= 0 || t.indexOf('_cf_chl_opt') >= 0 || t.indexOf('challenge-platform') >= 0;
  }
  function isTokenError(status, text) {
    if (status === 401 || status === 403) return true;
    var t = String(text || '');
    if (looksLikeChallenge(t)) return true;
    try {
      var j = JSON.parse(t);
      if (j && j.error && /token|session|challenge|forbidden|unauthorized|expired/i.test(String(j.error))) return true;
    } catch (e) {}
    return /invalid token|missing token|token (?:is )?(?:expired|stale|invalid)/i.test(t);
  }

  /* ------------------------------------------------- pair with auto-retry */
  function doPair(first, second) {
    if (!hookReady) return Promise.resolve({ ok: false, error: 'page hook is not active (CSP?) - reload the page' });
    var attempt = 0, lastErr = '';
    function step() {
      attempt++;
      if (attempt > MAX_ATTEMPTS) return Promise.resolve({ ok: false, error: lastErr || 'out of attempts' });
      if (!auth.token) {
        return askAuth().then(function (a) {
          if (a.token) return attemptReq();
          return askMint().then(function (t) {
            if (t) { auth.token = t; refreshStatus(); return attemptReq(); }
            return { ok: false, error: 'the page has no token: window.turnstileToken is empty and Turnstile did not answer. Reload the page.' };
          });
        });
      }
      return attemptReq();

      function attemptReq() {
        return pageGet(buildPairUrl(first, second), buildHeaders()).then(function (r) {
          if (!r || !r.ok) {
            lastErr = (r && r.error) || 'no answer from the page';
            return attempt < MAX_ATTEMPTS ? refreshAndRetry() : { ok: false, error: lastErr };
          }
          var txt = String(r.text || '');
          if (r.status === 200 && !isTokenError(r.status, txt)) {
            try {
              var body = JSON.parse(txt);
              if (body && !body.error) return { ok: true, body: body, attempt: attempt };
            } catch (e) { return { ok: false, error: 'answer is not JSON: ' + txt.slice(0, 200) }; }
          }
          lastErr = 'HTTP ' + r.status + ': ' + txt.slice(0, 200);
          return attempt < MAX_ATTEMPTS ? refreshAndRetry() : { ok: false, error: lastErr };
        });
      }

      function refreshAndRetry() {
        pushLog('token rejected (' + lastErr.slice(0, 60) + ') - refreshing automatically...', 'err');
        auth.token = '';
        return askAuth().then(function (a) {
          if (a.token) { pushLog('took a new token from the page globals', 'ok'); return delay(300).then(step); }
          return askMint().then(function (t) {
            if (t) { auth.token = t; pushLog('minted a new token via Turnstile', 'ok'); return delay(500).then(step); }
            lastErr += ' | could not refresh the token automatically';
            return { ok: false, error: lastErr };
          });
        });
      }
    }
    return step();
  }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* one pair at a time: the token is single use */
  var chain = Promise.resolve();
  function enqueue(fn) { chain = chain.then(fn, fn); return chain; }

  /* ------------------------------------------------------ bridge protocol */
  function gmReq(method, url, data) {
    return new Promise(function (resolve, reject) {
      try {
        GM_xmlhttpRequest({
          method: method, url: url,
          headers: { 'Content-Type': 'application/json' },
          data: data ? JSON.stringify(data) : undefined,
          onload: function (r) { resolve({ status: r.status, text: r.responseText }); },
          onerror: function () { reject(new Error('GM_xhr error')); },
          ontimeout: function () { reject(new Error('GM_xhr timeout')); }
        });
      } catch (e) { reject(e); }
    });
  }
  function postResult(id, ok, body, err) {
    var payload = { id: id, ok: !!ok };
    if (ok) payload.body = body; else payload.error = String(err || 'error');
    gmReq('POST', base() + '/result', payload).catch(function () {});
  }
  function pollOnce() {
    if (!enabled || busy) return;
    busy = true;
    gmReq('GET', base() + '/queue').then(function (r) {
      busy = false;
      if (r.status === 204 || !r.text) return;
      var task;
      try { task = JSON.parse(r.text); } catch (e) { pushLog('malformed task from /queue', 'err'); return; }
      if (!task || !task.id) return;
      enqueue(function () { return handleTask(task); });
    }).catch(function () {
      busy = false;
      var t = Date.now();
      if (t - lastConnErr > 5000) {
        lastConnErr = t;
        pushLog('no connection to ' + base() + ' - start cinovenx-bridge.exe, bridge.bat or python bridge.py', 'err');
        refreshStatus('offline');
      }
    });
  }
  function handleTask(task) {
    pushLog('-> ' + task.first + ' + ' + task.second + ' (#' + task.id + ')');
    doPair(task.first, task.second).then(function (res) {
      if (!res.ok) {
        pushLog('x ' + res.error, 'err');
        postResult(task.id, false, null, res.error);
        return;
      }
      var b = res.body;
      pushLog('<- ' + (b.result ? b.result : JSON.stringify(b).slice(0, 160)) +
        (b.emoji ? ' ' + b.emoji : '') + (b.isNew ? ' NEW' : ''), 'ok');
      postResult(task.id, true, b, null);
    });
  }
  function selfTest() {
    pushLog('test: Water + Fire ...');
    enqueue(function () {
      return doPair('Water', 'Fire').then(function (res) {
        if (!res.ok) { pushLog('test x ' + res.error, 'err'); return; }
        pushLog('test <- ' + JSON.stringify(res.body).slice(0, 200) + ' (attempts: ' + res.attempt + ')', 'ok');
      });
    });
  }

  /* ------------------------------------------------------- first run modal */
  function maybeShowFirstRun() {
    if (boolVal(GM_getValue('icb_seen_intro', false))) return;
    try { GM_setValue('icb_seen_intro', true); } catch (e) {}

    var wrap = document.createElement('div');
    wrap.id = 'cinovenx-intro';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;' +
      'align-items:center;justify-content:center;background:rgba(0,0,0,.72);' +
      'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    var box = document.createElement('div');
    box.style.cssText = 'background:#1b1d21;color:#eee;border:1px solid #4a4d55;border-radius:14px;' +
      'max-width:520px;width:calc(100% - 48px);padding:22px 24px;box-shadow:0 18px 60px rgba(0,0,0,.6)';
    var h = document.createElement('div');
    h.style.cssText = 'font-size:19px;font-weight:700;margin-bottom:10px';
    h.textContent = 'Infinite Craft Bridge by cinovenx';
    var p = document.createElement('div');
    p.style.cssText = 'font-size:14px;line-height:1.55;color:#d3d5db;margin-bottom:8px';
    p.textContent = 'This is the setup notice shown once. The bridge is driven by the companion ' +
      'userscript, so grab it from GitHub to finish:';
    var steps = document.createElement('div');
    steps.style.cssText = 'font-size:14px;line-height:1.8;color:#a9adb6;margin:0 0 18px;' +
      'padding-left:20px';
    steps.innerHTML = '<div>1. Download <b>infinite-craft-bridge.user.js</b> from the repository</div>' +
      '<div>2. Install it in Tampermonkey (it is already installed if you see this)</div>' +
      '<div>3. Start the local bridge: <b>bridge.bat</b>, <b>cinovenx-bridge.exe</b> or <b>python bridge.py</b></div>';
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap';
    function mkBtn(label, primary) {
      var b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'background:' + (primary ? '#3b82f6' : '#2e3138') + ';color:#fff;border:1px solid #555;' +
        'border-radius:9px;padding:9px 16px;cursor:pointer;font-size:14px';
      b.onclick = function () { wrap.remove(); };
      return b;
    }
    var later = mkBtn('Later', false);
    var ok = mkBtn('OK - open GitHub', true);
    ok.onclick = function () {
      wrap.remove();
      try {
        if (typeof GM_openInTab === 'function') GM_openInTab(GITHUB_URL, { active: true });
        else window.open(GITHUB_URL, '_blank', 'noopener');
      } catch (e) { try { window.open(GITHUB_URL, '_blank', 'noopener'); } catch (e2) {} }
    };
    row.appendChild(later);
    row.appendChild(ok);
    box.appendChild(h);
    box.appendChild(p);
    box.appendChild(steps);
    box.appendChild(row);
    wrap.appendChild(box);
    (document.body || document.documentElement).appendChild(wrap);
  }

  /* --------------------------------------------------------------------- UI */
  var statusDot = null, toggleBtn = null, portInput = null, statusText = null, authText = null;
  function refreshStatus(force) {
    if (statusDot) {
      if (force === 'offline') {
        statusDot.style.background = '#e5484d';
        if (statusText) statusText.textContent = 'offline - no connector';
      } else {
        statusDot.style.background = enabled ? '#30a46c' : '#8b8d98';
        if (statusText) statusText.textContent = enabled ? 'connected -> ' + base() : 'disconnected';
        if (toggleBtn) toggleBtn.textContent = enabled ? 'Disconnect' : 'Connect';
      }
    }
    if (authText) {
      authText.textContent = 'hook: ' + (hookReady ? 'ACTIVE' : '...') +
        '  |  token: ' + (auth.token ? mask(auth.token) : 'waiting for page') +
        '  |  x-craft-session: ' + (auth.session ? mask(auth.session) : 'none');
    }
  }
  function setEnabled(v) {
    enabled = !!v;
    try { GM_setValue('icb_enabled', enabled); } catch (e) {}
    pushLog(enabled ? 'bridge ON -> ' + base() : 'bridge OFF');
    if (enabled) startAuthWatch();
    refreshStatus();
  }
  function startAuthWatch() {
    if (authWatchTimer) clearInterval(authWatchTimer);
    authWatchTimer = setInterval(function () { if (hookReady) askAuth().catch(function () {}); }, 15000);
  }
  function buildUI() {
    var host = document.createElement('div');
    host.id = 'cinovenx-host';
    // middle left of the viewport
    host.style.cssText = 'position:fixed;left:16px;top:50%;transform:translateY(-50%);' +
      'z-index:2147483646;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    (document.body || document.documentElement).appendChild(host);
    var sh = host.attachShadow({ mode: 'open' });
    var css = document.createElement('style');
    css.textContent = '.fab{background:#111;color:#fff;border:1px solid #444;border-radius:999px;' +
      'padding:10px 16px;cursor:pointer;font-size:14px;white-space:nowrap}' +
      '.panel{background:#1b1d21;color:#eee;border:1px solid #444;border-radius:12px;width:380px;' +
      'padding:12px;margin-top:8px;display:none}' +
      '.panel.open{display:block}.row{display:flex;gap:8px;align-items:center;margin:6px 0;flex-wrap:wrap}' +
      'button{background:#2e3138;color:#fff;border:1px solid #555;border-radius:8px;padding:6px 10px;' +
      'cursor:pointer;font-size:13px}' +
      'input{background:#0f1113;color:#fff;border:1px solid #555;border-radius:8px;padding:6px 8px;width:88px}' +
      '.dot{width:10px;height:10px;border-radius:50%;background:#8b8d98;display:inline-block}' +
      '.log{background:#0f1113;border:1px solid #333;border-radius:8px;height:190px;overflow:auto;' +
      'font:11px/1.4 monospace;padding:6px;margin-top:6px}' +
      '.log .err{color:#ff6369}.log .ok{color:#7dd687}.hint{font-size:11px;color:#aaa}';
    sh.appendChild(css);

    var fab = document.createElement('button');
    fab.className = 'fab';
    fab.textContent = '\u267e\ufe0f Bridge';
    fab.title = TAB_TITLE;
    sh.appendChild(fab);

    var panel = document.createElement('div');
    panel.className = 'panel';
    sh.appendChild(panel);

    var title = document.createElement('div');
    title.className = 'hint';
    title.style.cssText = 'font-size:12px;color:#e6e8eb;font-weight:600;margin-bottom:6px';
    title.textContent = TAB_TITLE;
    panel.appendChild(title);

    var r1 = document.createElement('div'); r1.className = 'row';
    statusDot = document.createElement('span'); statusDot.className = 'dot';
    statusText = document.createElement('span'); statusText.className = 'hint'; statusText.textContent = '...';
    r1.appendChild(statusDot); r1.appendChild(statusText);
    panel.appendChild(r1);
    var rh = document.createElement('div'); rh.className = 'row';
    authText = document.createElement('span'); authText.className = 'hint'; authText.textContent = 'token: ...';
    rh.appendChild(authText);
    panel.appendChild(rh);

    var r2 = document.createElement('div'); r2.className = 'row';
    toggleBtn = document.createElement('button');
    toggleBtn.onclick = function () { setEnabled(!enabled); };
    var chk = document.createElement('button'); chk.textContent = 'Check';
    chk.onclick = function () {
      gmReq('GET', base() + '/status').then(function (r) { pushLog('/status: ' + r.text, 'ok'); refreshStatus(); })
        .catch(function () { pushLog('no connector at ' + base(), 'err'); refreshStatus('offline'); });
    };
    var tst = document.createElement('button'); tst.textContent = 'Test Water+Fire';
    tst.onclick = selfTest;
    r2.appendChild(toggleBtn); r2.appendChild(chk); r2.appendChild(tst);
    panel.appendChild(r2);

    var r3 = document.createElement('div'); r3.className = 'row';
    var lab = document.createElement('span'); lab.className = 'hint'; lab.textContent = 'Port:';
    portInput = document.createElement('input');
    portInput.value = String(port);
    portInput.onchange = function () {
      port = intVal(portInput.value, DEFAULT_PORT);
      portInput.value = String(port);
      try { GM_setValue('icb_port', port); } catch (e) {}
      pushLog('port -> ' + port);
      refreshStatus();
    };
    var readBtn = document.createElement('button'); readBtn.textContent = 'Read token';
    readBtn.onclick = function () {
      askAuth().then(function (a) {
        pushLog(a.token ? 'token: ' + mask(a.token) : 'window.turnstileToken is empty - reload the page',
          a.token ? 'ok' : 'err');
        refreshStatus();
      });
    };
    var mintBtn = document.createElement('button'); mintBtn.textContent = 'Mint token';
    mintBtn.onclick = function () {
      pushLog('Turnstile reset+execute ...');
      askMint().then(function (t) {
        if (t) { auth.token = t; pushLog('token minted: ' + mask(t), 'ok'); }
        else pushLog('Turnstile did not answer', 'err');
        refreshStatus();
      });
    };
    r3.appendChild(lab); r3.appendChild(portInput); r3.appendChild(readBtn); r3.appendChild(mintBtn);
    panel.appendChild(r3);

    var r4 = document.createElement('div'); r4.className = 'row';
    var sortLbl = document.createElement('label'); sortLbl.className = 'hint';
    var sortChk = document.createElement('input');
    sortChk.type = 'checkbox'; sortChk.checked = sortLikeGame; sortChk.style.width = 'auto';
    sortChk.onchange = function () {
      sortLikeGame = sortChk.checked;
      try { GM_setValue('icb_sort', sortLikeGame); } catch (e) {}
      pushLog('sort pair like the game: ' + (sortLikeGame ? 'on' : 'off'));
    };
    sortLbl.appendChild(sortChk);
    sortLbl.appendChild(document.createTextNode(' sort the pair like the game (localeCompare)'));
    r4.appendChild(sortLbl);
    panel.appendChild(r4);

    var hint = document.createElement('div'); hint.className = 'hint';
    hint.textContent = 'Fully automatic - the token is read from the page. From Python: GET ' +
      base() + '/pair?first=Water&second=Fire';
    panel.appendChild(hint);

    logBox = document.createElement('div'); logBox.className = 'log';
    panel.appendChild(logBox);
    var r5 = document.createElement('div'); r5.className = 'row';
    var clr = document.createElement('button'); clr.textContent = 'Clear log';
    clr.onclick = function () { logs = []; if (logBox) logBox.innerHTML = ''; };
    var gh = document.createElement('button'); gh.textContent = 'GitHub';
    gh.onclick = function () {
      try {
        if (typeof GM_openInTab === 'function') GM_openInTab(GITHUB_URL, { active: true });
        else window.open(GITHUB_URL, '_blank', 'noopener');
      } catch (e) { try { window.open(GITHUB_URL, '_blank', 'noopener'); } catch (e2) {} }
    };
    r5.appendChild(clr); r5.appendChild(gh);
    panel.appendChild(r5);

    fab.onclick = function () { panel.classList.toggle('open'); };
    logs.forEach(function (l) {
      var d = document.createElement('div'); d.textContent = l.line; if (l.cls) d.className = l.cls; logBox.appendChild(d);
    });
    refreshStatus();
  }

  /* ------------------------------------------------------------------ boot */
  function boot() {
    buildUI();
    pushLog('Infinite Craft Bridge v3.0 loaded. Port ' + port + ', state: ' + (enabled ? 'ON' : 'OFF') + '.');
    pushLog('mode: automatic token from window.turnstileToken + x-craft-session header');
    if (enabled) startAuthWatch();
    pushLog('example: ' + base() + '/pair?first=Water&second=Fire');
    maybeShowFirstRun();
  }
  injectHook();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  setTimeout(function () { if (hookReady) askAuth().catch(function () {}); }, 3000);
  setInterval(pollOnce, POLL_MS);
})();
