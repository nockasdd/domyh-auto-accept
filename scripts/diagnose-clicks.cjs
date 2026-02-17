#!/usr/bin/env node
/**
 * diagnose-clicks.cjs — CDP Diagnostic Script
 *
 * Connects to the IDE's CDP port, evaluates on ALL targets + iframe contexts,
 * and reports EXACTLY what the auto-accept payload would find and click.
 *
 * Usage:  node scripts/diagnose-clicks.cjs [port]
 * Default port: 9000 (also tries auto-detect)
 */

const http = require('node:http');
const WebSocket = require('ws');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ── Port Discovery
function discoverPort(fallback) {
  fallback = fallback || 9000;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const dirs = [
    path.join(appData, 'Antigravity'),
    path.join(appData, 'Antigravity', 'User'),
    path.join(appData, 'Code'),
  ];
  for (const dir of dirs) {
    const dtap = path.join(dir, 'DevToolsActivePort');
    try {
      const content = fs.readFileSync(dtap, 'utf-8').trim();
      const port = parseInt(content.split('\n')[0], 10);
      if (port > 0 && port < 65536) {
        console.log('[port] Found ' + port + ' from ' + dtap);
        return port;
      }
    } catch (e) { /* skip */ }
  }
  console.log('[port] Using fallback ' + fallback);
  return fallback;
}

// ── CDP Helpers
function httpGet(url) {
  return new Promise(function(resolve, reject) {
    http.get(url, function(res) {
      let data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse: ' + data.substring(0, 200))); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function cdpEval(ws, expression) {
  return new Promise(function(resolve, reject) {
    const id = Date.now() + Math.floor(Math.random() * 10000);
    const params = {
      expression: expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,
    };
    const timeout = setTimeout(function() { reject(new Error('Timeout')); }, 8000);
    function handler(data) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(timeout);
          ws.removeListener('message', handler);
          if (msg.error) resolve({ error: msg.error.message });
          else if (msg.result && msg.result.result && msg.result.result.value !== undefined)
            resolve({ value: msg.result.result.value });
          else if (msg.result && msg.result.exceptionDetails)
            resolve({ error: msg.result.exceptionDetails.text || 'Exception' });
          else resolve({ value: null });
        }
      } catch (e) { /* ignore */ }
    }
    ws.on('message', handler);
    ws.send(JSON.stringify({ id: id, method: 'Runtime.evaluate', params: params }));
  });
}

function connectWS(url) {
  return new Promise(function(resolve, reject) {
    const ws = new WebSocket(url);
    const timer = setTimeout(function() { reject(new Error('WS timeout')); }, 5000);
    ws.on('open', function() { clearTimeout(timer); resolve(ws); });
    ws.on('error', function(e) { clearTimeout(timer); reject(e); });
  });
}

// ── The Diagnostic Payload ─────────────────────
// EXACT mirror of auto-accept.js but REPORTS instead of clicking.
const DIAG_PAYLOAD = [
'(function() {',
'  "use strict";',
'  var ACCEPT_WORDS = ["accept","accept all","accept all files","approve","apply","apply all","confirm","allow","allow once","save all","overwrite","proceed","keep","keep all","yes","ok"];',
'  var REJECT_WORDS = ["skip","reject","cancel","close","dismiss","decline","deny","discard","undo","revert","run","debug","start","stop","restart","terminal","delete","remove","open","copy","edit","thought"];',
'  var BUTTON_SELECTORS = "button, [role=\\"button\\"], .monaco-button, .bg-ide-button-background, span[class*=\\"bg-ide-button\\"]";',
'  var EDITOR_DIFF_SELECTORS = [".chat-editing-session",".chatEditing",".modified-in-chat",".inline-chat-widget",".diff-review-widget"];',
'',
'  function deepQSA(root, sel) {',
'    var r = [];',
'    if (!root) return r;',
'    try { var f = root.querySelectorAll(sel); for (var i=0;i<f.length;i++) r.push(f[i]); } catch(e) {}',
'    try {',
'      var all = root.querySelectorAll("*");',
'      for (var i=0;i<all.length;i++) {',
'        if (all[i].shadowRoot) {',
'          var sr = deepQSA(all[i].shadowRoot, sel);',
'          for (var j=0;j<sr.length;j++) r.push(sr[j]);',
'        }',
'      }',
'    } catch(e) {}',
'    return r;',
'  }',
'',
'  function getText(el) {',
'    var t = "";',
'    try { t = el.getAttribute("aria-label") || ""; } catch(e) {}',
'    if (!t) try { t = (el.textContent || el.innerText || "").substring(0, 60); } catch(e) {}',
'    if (!t) try { t = el.getAttribute("title") || ""; } catch(e) {}',
'    return t.trim().toLowerCase().replace(/\\s+/g, " ");',
'  }',
'',
'  function isAccept(text) {',
'    if (!text || text.length > 60) return false;',
'    for (var i=0;i<REJECT_WORDS.length;i++) { if (text === REJECT_WORDS[i] || text.indexOf(REJECT_WORDS[i]) === 0) return false; }',
'    for (var i=0;i<ACCEPT_WORDS.length;i++) {',
'      var w = ACCEPT_WORDS[i];',
'      if (text === w) return true;',
'      if (text.indexOf(w) === 0 && (text.length === w.length || text[w.length] === " ")) return true;',
'    }',
'    return false;',
'  }',
'',
'  function isCodeProse(el) {',
'    var p = el, d = 0;',
'    while (p && d < 15) {',
'      var tag = p.tagName;',
'      if (tag === "PRE" || tag === "CODE") return true;',
'      var c = p.className || "";',
'      if (typeof c === "string") {',
'        if (c.indexOf("prose") !== -1) return true;',
'        if (c.indexOf("code-block") !== -1 || c.indexOf("codeblock") !== -1) return true;',
'      }',
'      p = p.parentElement; d++;',
'    }',
'    return false;',
'  }',
'',
'  function forbiddenCheck(el) {',
'    var p = el, d = 0, trail = [];',
'    while (p && d < 50) {',
'      var id = p.id || "", cls = p.className || "", part = "";',
'      try { part = p.getAttribute("part") || ""; } catch(e) {}',
'      if (typeof cls !== "string") cls = "";',
'      if (id || cls) trail.push(d + ":" + p.tagName + "#" + id + "." + cls.substring(0,60));',
'      if (id === "workbench.parts.statusbar") return {f:true,r:"statusbar#id",t:trail};',
'      if (cls.indexOf("statusbar") !== -1 && cls.indexOf("part") !== -1) return {f:true,r:"statusbar#cls",t:trail};',
'      if (id === "workbench.parts.sidebar") return {f:true,r:"sidebar",t:trail};',
'      if (id === "workbench.parts.auxiliarybar") return {f:true,r:"auxbar",t:trail};',
'      if (cls.indexOf("explorer-folders") !== -1) return {f:true,r:"explorer",t:trail};',
'      if (cls.indexOf("file-explorer") !== -1) return {f:true,r:"file-explorer",t:trail};',
'      if (id === "workbench.parts.activitybar") return {f:true,r:"actbar",t:trail};',
'      if (id === "workbench.parts.titlebar") return {f:true,r:"titlebar",t:trail};',
'      if (id === "workbench.parts.panel") return {f:true,r:"panel",t:trail};',
'      if (cls.indexOf("notifications-center") !== -1) return {f:true,r:"notif",t:trail};',
'      if (cls.indexOf("notification-toast") !== -1) return {f:true,r:"toast",t:trail};',
'      if (part === "statusbar" || part === "sidebar" || part === "activitybar" || part === "titlebar" || part === "panel") return {f:true,r:"part="+part,t:trail};',
'      if (cls.indexOf("auto-accept") !== -1 || cls.indexOf("domyh") !== -1) return {f:true,r:"domyh-ui",t:trail};',
'      if (id === "workbench.parts.editor" && cls.indexOf("settings") !== -1) return {f:true,r:"settings",t:trail};',
'      if (cls.indexOf("getting-started") !== -1 || cls.indexOf("walkthrough") !== -1) return {f:true,r:"walkthrough",t:trail};',
'      p = p.parentElement || (p.getRootNode && p.getRootNode().host) || null;',
'      d++;',
'    }',
'    return {f:false,r:null,t:trail};',
'  }',
'',
'  function isClickable(el) {',
'    try {',
'      if (el.offsetParent === null && el.style && el.style.position !== "fixed") return false;',
'      var s = window.getComputedStyle(el);',
'      if (s.display==="none"||s.visibility==="hidden"||s.opacity==="0") return false;',
'      if (s.pointerEvents==="none") return false;',
'      var r = el.getBoundingClientRect();',
'      if (r.width===0||r.height===0) return false;',
'      if (r.bottom<0||r.top>window.innerHeight) return false;',
'      if (r.right<0||r.left>window.innerWidth) return false;',
'      return true;',
'    } catch(e) { return false; }',
'  }',
'',
'  function isChatPanel() {',
'    try { if (window === window.top) return false; } catch(e) { return true; }',
'    if (document.getElementById("conversation")) return true;',
'    if (document.querySelector(".notify-user-container")) return true;',
'    if (document.querySelector("[data-tooltip-id=\\"cascade-header-menu\\"]")) return true;',
'    return false;',
'  }',
'',
'  // ── Diagnostic run ──',
'  var rpt = {',
'    title: document.title,',
'    url: location.href.substring(0,120),',
'    isIframe: false,',
'    isChatPanel: false,',
'    scanMode: "none",',
'    diffContainers: [],',
'    totalButtons: 0,',
'    wouldClick: [],',
'    blocked: [],',
'    filtered: [],',
'  };',
'',
'  try { rpt.isIframe = (window !== window.top); } catch(e) { rpt.isIframe = true; }',
'  rpt.isChatPanel = isChatPanel();',
'',
'  function getRect(el) {',
'    try { var r=el.getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; }',
'    catch(e) { return null; }',
'  }',
'',
'  function analyzeBtn(btn, container) {',
'    var text = getText(btn);',
'    var entry = {',
'      tag: btn.tagName,',
'      text: text,',
'      aria: btn.getAttribute("aria-label") || "",',
'      cls: (btn.className||"").toString().substring(0,100),',
'      id: btn.id || "",',
'      rect: getRect(btn),',
'      container: container || "document",',
'      accept: isAccept(text),',
'      codeProse: isCodeProse(btn),',
'      forbidden: forbiddenCheck(btn),',
'      clickable: isClickable(btn),',
'    };',
'    if (entry.codeProse) { entry.verdict = "BLOCKED:code-prose"; rpt.blocked.push(entry); }',
'    else if (entry.forbidden.f) { entry.verdict = "BLOCKED:forbidden(" + entry.forbidden.r + ")"; rpt.blocked.push(entry); }',
'    else if (!text || text.length > 60) { entry.verdict = "SKIP:no-text"; rpt.filtered.push(entry); }',
'    else if (!entry.accept) { entry.verdict = "SKIP:not-accept"; rpt.filtered.push(entry); }',
'    else if (!entry.clickable) { entry.verdict = "SKIP:not-clickable"; rpt.filtered.push(entry); }',
'    else { entry.verdict = "WOULD_CLICK"; rpt.wouldClick.push(entry); }',
'    return entry;',
'  }',
'',
'  if (rpt.isChatPanel) {',
'    rpt.scanMode = "chat-panel";',
'    var found = deepQSA(document, BUTTON_SELECTORS);',
'    rpt.totalButtons = found.length;',
'    for (var i=0; i<found.length; i++) analyzeBtn(found[i], "chat-panel-doc");',
'  } else {',
'    var containers = [];',
'    for (var s=0; s<EDITOR_DIFF_SELECTORS.length; s++) {',
'      var f = deepQSA(document, EDITOR_DIFF_SELECTORS[s]);',
'      for (var k=0; k<f.length; k++) {',
'        containers.push({sel: EDITOR_DIFF_SELECTORS[s], el: f[k]});',
'        rpt.diffContainers.push({sel: EDITOR_DIFF_SELECTORS[s], tag: f[k].tagName, id: f[k].id||"", cls:(f[k].className||"").toString().substring(0,80)});',
'      }',
'    }',
'    if (containers.length > 0) {',
'      rpt.scanMode = "editor-diff";',
'      var seen = [];',
'      for (var c=0; c<containers.length; c++) {',
'        var btns = deepQSA(containers[c].el, BUTTON_SELECTORS);',
'        for (var i=0; i<btns.length; i++) {',
'          if (seen.indexOf(btns[i]) !== -1) continue;',
'          seen.push(btns[i]);',
'          analyzeBtn(btns[i], containers[c].sel);',
'        }',
'      }',
'    } else {',
'      rpt.scanMode = "no-targets";',
'    }',
'  }',
'',
'  return JSON.stringify(rpt);',
'})()',
].join('\n');


// ── Main ──────────────────────────────────────
async function main() {
  const port = parseInt(process.argv[2]) || discoverPort();

  console.log('\n' + '='.repeat(60));
  console.log('  DIAGNOSTIC: Auto-Accept Click Analysis — port ' + port);
  console.log('='.repeat(60) + '\n');

  // 1. List all targets
  let targets;
  try {
    targets = await httpGet('http://127.0.0.1:' + port + '/json');
  } catch (e) {
    console.error('ERROR: Cannot reach CDP on port ' + port + ': ' + e.message);
    console.error('  Make sure IDE is running with --remote-debugging-port=' + port);
    process.exit(1);
  }

  console.log('TARGETS (' + targets.length + ' total):\n');
  targets.forEach(function(t, i) {
    console.log('  [' + i + '] type=' + t.type + '  title="' + t.title + '"');
    console.log('      url=' + t.url.substring(0, 100));
    console.log('      ws=' + (t.webSocketDebuggerUrl ? 'yes' : 'NO'));
  });

  // 2. Filter targets (mirror antigravity.ts filterTargets logic)
  const filtered = targets.filter(function(t) {
    if (!t.webSocketDebuggerUrl) return false;
    const url = t.url.toLowerCase();
    if (url.includes('domyh-auto-accept') || url.includes('domyh.auto-accept')) return false;
    if (t.type === 'webview' || t.type === 'iframe') return true;
    if (t.type === 'page' && url.includes('workbench')) {
      if ((t.title || '').toLowerCase() === 'launchpad') return false;
      return true;
    }
    return false;
  });

  console.log('\nFILTERED: ' + filtered.length + '/' + targets.length + ' targets will be evaluated\n');

  // 3. Connect and evaluate each
  const allReports = [];
  for (let idx = 0; idx < filtered.length; idx++) {
    const target = filtered[idx];
    console.log('-'.repeat(60));
    console.log('EVAL [' + target.type + '] "' + target.title + '"');
    console.log('-'.repeat(60));

    let ws;
    try {
      ws = await connectWS(target.webSocketDebuggerUrl);
    } catch (e) {
      console.log('  SKIP: cannot connect: ' + e.message + '\n');
      continue;
    }

    try {
      const result = await cdpEval(ws, DIAG_PAYLOAD);
      if (result.error) {
        console.log('  ERROR: ' + result.error + '\n');
        continue;
      }

      let rpt;
      try {
        rpt = typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
      } catch (e) {
        console.log('  PARSE ERROR: ' + e.message + '\n');
        continue;
      }

      if (!rpt) {
        console.log('  No report returned\n');
        continue;
      }

      // Save raw report
      allReports.push({ target: target.title, type: target.type, report: rpt });

      // Display
      console.log('  title:      ' + rpt.title);
      console.log('  url:        ' + rpt.url);
      console.log('  isIframe:   ' + rpt.isIframe);
      console.log('  isChatPanel:' + rpt.isChatPanel);
      console.log('  scanMode:   ' + rpt.scanMode);
      console.log('  diffCtrs:   ' + (rpt.diffContainers ? rpt.diffContainers.length : 0));
      console.log('  totalBtns:  ' + (rpt.totalButtons || 0));
      console.log();

      if (rpt.diffContainers && rpt.diffContainers.length > 0) {
        console.log('  DIFF CONTAINERS:');
        rpt.diffContainers.forEach(function(c) {
          console.log('    ' + c.sel + ' -> <' + c.tag + ' id="' + c.id + '" class="' + c.cls + '">');
        });
        console.log();
      }

      // WOULD CLICK
      if (rpt.wouldClick && rpt.wouldClick.length > 0) {
        console.log('  *** WOULD_CLICK (' + rpt.wouldClick.length + ') ***');
        rpt.wouldClick.forEach(function(b) {
          console.log('    [WOULD_CLICK]');
          console.log('      tag:   <' + b.tag + '>');
          console.log('      text:  "' + b.text + '"');
          console.log('      aria:  "' + b.aria + '"');
          console.log('      class: "' + b.cls + '"');
          console.log('      id:    "' + b.id + '"');
          console.log('      rect:  ' + (b.rect ? 'x:'+b.rect.x+' y:'+b.rect.y+' '+b.rect.w+'x'+b.rect.h : 'N/A'));
          console.log('      ctr:   ' + b.container);
          if (b.forbidden && b.forbidden.t && b.forbidden.t.length > 0) {
            console.log('      trail: ' + b.forbidden.t.slice(-5).join(' > '));
          }
        });
        console.log();
      } else {
        console.log('  (no buttons would be clicked)');
      }

      // BLOCKED
      if (rpt.blocked && rpt.blocked.length > 0) {
        console.log('  BLOCKED (' + rpt.blocked.length + '):');
        rpt.blocked.forEach(function(b) {
          console.log('    [' + b.verdict + '] <' + b.tag + '> "' + b.text + '" rect:' + (b.rect ? 'x:'+b.rect.x+' y:'+b.rect.y : 'N/A'));
        });
        console.log();
      }

      // FILTERED (accept text matches only, for debugging)
      if (rpt.filtered) {
        const acceptFiltered = rpt.filtered.filter(function(b) { return b.accept; });
        if (acceptFiltered.length > 0) {
          console.log('  FILTERED-BUT-ACCEPT (' + acceptFiltered.length + '):');
          acceptFiltered.forEach(function(b) {
            console.log('    [' + b.verdict + '] <' + b.tag + '> "' + b.text + '"');
          });
          console.log();
        }
      }

      const total = (rpt.wouldClick ? rpt.wouldClick.length : 0) +
                    (rpt.blocked ? rpt.blocked.length : 0) +
                    (rpt.filtered ? rpt.filtered.length : 0);
      console.log('  SUMMARY: ' + (rpt.wouldClick ? rpt.wouldClick.length : 0) + ' click / ' +
                  (rpt.blocked ? rpt.blocked.length : 0) + ' blocked / ' + total + ' total');

    } catch (e) {
      console.log('  ERROR: ' + e.message);
    } finally {
      ws.close();
    }
    console.log();
  }

  console.log('='.repeat(60));
  console.log('  Diagnostic complete');
  console.log('='.repeat(60));

  // Save raw results to file for reliable analysis
  const outPath = path.join(__dirname, 'diagnostic-report.json');
  fs.writeFileSync(outPath, JSON.stringify(allReports, null, 2));
  console.log('\nFull report saved to: ' + outPath);
}

main().catch(console.error);
