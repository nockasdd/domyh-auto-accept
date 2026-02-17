#!/usr/bin/env node
/**
 * diagnose-clicks.mjs — CDP Diagnostic Script
 *
 * Connects to the IDE's CDP port, evaluates on ALL targets + iframe contexts,
 * and reports EXACTLY what the auto-accept payload would find and click.
 *
 * Usage:  node scripts/diagnose-clicks.mjs [port]
 * Default port: 9000 (auto-detect from DevToolsActivePort)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

// ── Port Discovery ────────────────────────────
async function discoverPort(fallback = 9000) {
  // Try DevToolsActivePort files
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const possibleDirs = [
    path.join(appData, 'Antigravity'),
    path.join(appData, 'Antigravity', 'User'),
    path.join(appData, 'Code'),
  ];

  for (const dir of possibleDirs) {
    const dtap = path.join(dir, 'DevToolsActivePort');
    try {
      const content = fs.readFileSync(dtap, 'utf-8').trim();
      const port = parseInt(content.split('\n')[0], 10);
      if (port > 0 && port < 65536) {
        console.log(`📍 Found port ${port} from ${dtap}`);
        return port;
      }
    } catch { /* skip */ }
  }

  console.log(`📍 Using fallback port ${fallback}`);
  return fallback;
}

// ── CDP Helpers ────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function cdpEval(ws, expression, contextId) {
  return new Promise((resolve, reject) => {
    const id = Date.now() + Math.floor(Math.random() * 10000);
    const params = {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,  // DO NOT click — diagnostic only
    };
    if (contextId !== undefined) params.contextId = contextId;

    const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);

    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(timeout);
          ws.removeListener('message', handler);
          if (msg.error) resolve({ error: msg.error.message });
          else if (msg.result?.result?.value !== undefined)
            resolve({ value: msg.result.result.value });
          else if (msg.result?.exceptionDetails)
            resolve({ error: msg.result.exceptionDetails.text || 'Exception' });
          else resolve({ value: null });
        }
      } catch { /* ignore */ }
    };

    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params }));
  });
}

function connectWS(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS timeout')), 5000);
  });
}

// ── The Diagnostic Payload ─────────────────────
// This is an EXACT mirror of auto-accept.js logic, but instead of clicking,
// it REPORTS what it would do. Every function is copied from the source.
const DIAGNOSTIC_PAYLOAD = `
(function() {
  'use strict';

  // ── EXACT copies from auto-accept.js ──────────

  var ACCEPT_WORDS = [
    'accept', 'accept all', 'accept all files',
    'approve', 'apply', 'apply all',
    'confirm', 'allow', 'allow once',
    'save all', 'overwrite',
    'proceed', 'keep', 'keep all',
    'yes', 'ok',
  ];

  var REJECT_WORDS = [
    'skip', 'reject', 'cancel', 'close', 'dismiss', 'decline',
    'deny', 'discard', 'undo', 'revert', 'run', 'debug', 'start',
    'stop', 'restart', 'terminal', 'delete', 'remove', 'open',
    'copy', 'edit', 'thought',
  ];

  var BUTTON_SELECTORS = [
    'button',
    '[role="button"]',
    '.monaco-button',
    '.bg-ide-button-background',
    'span[class*="bg-ide-button"]',
  ].join(', ');

  var EDITOR_DIFF_SELECTORS = [
    '.chat-editing-session',
    '.chatEditing',
    '.modified-in-chat',
    '.inline-chat-widget',
    '.diff-review-widget',
  ];

  function deepQuerySelectorAll(root, selector) {
    var results = [];
    if (!root) return results;
    try {
      var found = root.querySelectorAll(selector);
      for (var i = 0; i < found.length; i++) results.push(found[i]);
    } catch (e) {}
    try {
      var allElements = root.querySelectorAll('*');
      for (var i = 0; i < allElements.length; i++) {
        var el = allElements[i];
        if (el.shadowRoot) {
          var shadowResults = deepQuerySelectorAll(el.shadowRoot, selector);
          for (var j = 0; j < shadowResults.length; j++) results.push(shadowResults[j]);
        }
      }
    } catch (e) {}
    return results;
  }

  function getButtonText(el) {
    var text = '';
    try {
      text = el.getAttribute('aria-label') || '';
      if (!text) {
        text = (el.textContent || el.innerText || '').substring(0, 60);
      }
      if (!text) {
        text = el.getAttribute('title') || '';
      }
    } catch (e) {}
    return text.trim().toLowerCase().replace(/\\s+/g, ' ');
  }

  function isAcceptButton(text) {
    if (!text) return false;
    if (text.length > 60) return false;
    for (var i = 0; i < REJECT_WORDS.length; i++) {
      if (text === REJECT_WORDS[i] || text.indexOf(REJECT_WORDS[i]) === 0) return false;
    }
    for (var i = 0; i < ACCEPT_WORDS.length; i++) {
      var word = ACCEPT_WORDS[i];
      if (text === word) return true;
      if (text.indexOf(word) === 0 && (text.length === word.length || text[word.length] === ' ')) return true;
    }
    return false;
  }

  function isInsideCodeOrProse(el) {
    var parent = el;
    var depth = 0;
    while (parent && depth < 15) {
      var tag = parent.tagName;
      if (tag === 'PRE' || tag === 'CODE') return true;
      var cls = parent.className || '';
      if (typeof cls === 'string') {
        if (cls.indexOf('prose') !== -1) return true;
        if (cls.indexOf('code-block') !== -1 || cls.indexOf('codeblock') !== -1) return true;
        if (cls.indexOf('inline') !== -1 && tag === 'PRE') return true;
      }
      parent = parent.parentElement;
      depth++;
    }
    return false;
  }

  function isInsideForbiddenZone(el) {
    var parent = el;
    var depth = 0;
    var trail = [];
    while (parent && depth < 50) {
      var id = parent.id || '';
      var cls = parent.className || '';
      var part = parent.getAttribute ? (parent.getAttribute('part') || '') : '';

      if (id || cls) trail.push({ depth: depth, tag: parent.tagName, id: id, cls: (typeof cls === 'string' ? cls : '').substring(0, 80), part: part });

      if (id === 'workbench.parts.statusbar') return { forbidden: true, reason: 'statusbar#id', trail: trail };
      if (typeof cls === 'string' && cls.indexOf('statusbar') !== -1 && cls.indexOf('part') !== -1) return { forbidden: true, reason: 'statusbar#cls', trail: trail };
      if (id === 'workbench.parts.sidebar') return { forbidden: true, reason: 'sidebar', trail: trail };
      if (id === 'workbench.parts.auxiliarybar') return { forbidden: true, reason: 'auxiliarybar', trail: trail };
      if (typeof cls === 'string' && cls.indexOf('explorer-folders') !== -1) return { forbidden: true, reason: 'explorer', trail: trail };
      if (typeof cls === 'string' && cls.indexOf('file-explorer') !== -1) return { forbidden: true, reason: 'file-explorer', trail: trail };
      if (id === 'workbench.parts.activitybar') return { forbidden: true, reason: 'activitybar', trail: trail };
      if (id === 'workbench.parts.titlebar') return { forbidden: true, reason: 'titlebar', trail: trail };
      if (id === 'workbench.parts.panel') return { forbidden: true, reason: 'panel', trail: trail };
      if (typeof cls === 'string' && cls.indexOf('notifications-center') !== -1) return { forbidden: true, reason: 'notifications', trail: trail };
      if (typeof cls === 'string' && cls.indexOf('notification-toast') !== -1) return { forbidden: true, reason: 'notification-toast', trail: trail };
      if (part === 'statusbar' || part === 'sidebar' || part === 'activitybar' || part === 'titlebar' || part === 'panel') return { forbidden: true, reason: 'part=' + part, trail: trail };
      if (typeof cls === 'string' && (cls.indexOf('auto-accept') !== -1 || cls.indexOf('domyh') !== -1)) return { forbidden: true, reason: 'domyh-ui', trail: trail };
      if (id === 'workbench.parts.editor' && typeof cls === 'string' && cls.indexOf('settings') !== -1) return { forbidden: true, reason: 'settings-editor', trail: trail };
      if (typeof cls === 'string' && (cls.indexOf('getting-started') !== -1 || cls.indexOf('walkthrough') !== -1)) return { forbidden: true, reason: 'walkthrough', trail: trail };

      parent = parent.parentElement || (parent.getRootNode && parent.getRootNode().host) || null;
      depth++;
    }
    return { forbidden: false, reason: null, trail: trail };
  }

  function isElementClickable(el) {
    try {
      if (el.offsetParent === null && el.style && el.style.position !== 'fixed') return false;
      var style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      if (style.pointerEvents === 'none') return false;
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
      if (rect.right < 0 || rect.left > window.innerWidth) return false;
      return true;
    } catch (e) { return false; }
  }

  function isChatPanelIframe() {
    try {
      if (window === window.top) return false;
    } catch (e) {
      return true;
    }
    if (document.getElementById('conversation')) return true;
    if (document.querySelector('.notify-user-container')) return true;
    if (document.querySelector('[data-tooltip-id="cascade-header-menu"]')) return true;
    return false;
  }

  function findEditorDiffContainers() {
    var containers = [];
    for (var s = 0; s < EDITOR_DIFF_SELECTORS.length; s++) {
      var found = deepQuerySelectorAll(document, EDITOR_DIFF_SELECTORS[s]);
      for (var f = 0; f < found.length; f++) {
        containers.push({ selector: EDITOR_DIFF_SELECTORS[s], el: found[f] });
      }
    }
    return containers;
  }

  // ── Diagnostic logic (REPORT, never click) ────

  var report = {
    pageTitle: document.title,
    pageURL: location.href.substring(0, 120),
    isIframe: false,
    isChatPanel: false,
    scanMode: 'none',
    editorDiffContainers: [],
    allButtonsFound: 0,
    wouldClick: [],
    wouldBlock: [],
    allFiltered: [],
  };

  try { report.isIframe = (window !== window.top); } catch (e) { report.isIframe = true; }
  report.isChatPanel = isChatPanelIframe();

  // ── Branch 1: Chat panel iframe ──
  if (report.isChatPanel) {
    report.scanMode = 'chat-panel';
    var found = deepQuerySelectorAll(document, BUTTON_SELECTORS);
    report.allButtonsFound = found.length;

    for (var i = 0; i < found.length; i++) {
      var btn = found[i];
      var text = getButtonText(btn);
      var rect = null;
      try { var r = btn.getBoundingClientRect(); rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; } catch(e) {}

      var entry = {
        index: i,
        tag: btn.tagName,
        text: text,
        ariaLabel: btn.getAttribute('aria-label') || '',
        classList: (btn.className || '').toString().substring(0, 100),
        id: btn.id || '',
        rect: rect,
        isAccept: isAcceptButton(text),
        isCodeProse: isInsideCodeOrProse(btn),
        forbiddenZone: isInsideForbiddenZone(btn),
        isClickable: isElementClickable(btn),
      };

      // Determine verdict
      if (entry.isCodeProse) {
        entry.verdict = 'BLOCKED:code-prose';
        report.wouldBlock.push(entry);
      } else if (entry.forbiddenZone.forbidden) {
        entry.verdict = 'BLOCKED:forbidden(' + entry.forbiddenZone.reason + ')';
        report.wouldBlock.push(entry);
      } else if (!text || text.length > 60) {
        entry.verdict = 'FILTERED:no-text-or-long';
        report.allFiltered.push(entry);
      } else if (!entry.isAccept) {
        entry.verdict = 'FILTERED:not-accept';
        report.allFiltered.push(entry);
      } else if (!entry.isClickable) {
        entry.verdict = 'FILTERED:not-clickable';
        report.allFiltered.push(entry);
      } else {
        entry.verdict = '🚨 WOULD_CLICK';
        report.wouldClick.push(entry);
      }
    }
  }

  // ── Branch 2: Main workbench ──
  else {
    var containers = findEditorDiffContainers();
    report.editorDiffContainers = containers.map(function(c) {
      return { selector: c.selector, tag: c.el.tagName, id: c.el.id || '', cls: (c.el.className || '').toString().substring(0, 80) };
    });

    if (containers.length > 0) {
      report.scanMode = 'editor-diff';
      var checkedElements = new Set();

      for (var c = 0; c < containers.length; c++) {
        var btns = deepQuerySelectorAll(containers[c].el, BUTTON_SELECTORS);
        for (var i = 0; i < btns.length; i++) {
          var btn = btns[i];
          if (checkedElements.has(btn)) continue;
          checkedElements.add(btn);

          var text = getButtonText(btn);
          var rect = null;
          try { var r = btn.getBoundingClientRect(); rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; } catch(e) {}

          var entry = {
            container: containers[c].selector,
            tag: btn.tagName,
            text: text,
            ariaLabel: btn.getAttribute('aria-label') || '',
            classList: (btn.className || '').toString().substring(0, 100),
            rect: rect,
            isAccept: isAcceptButton(text),
            isCodeProse: isInsideCodeOrProse(btn),
            forbiddenZone: isInsideForbiddenZone(btn),
            isClickable: isElementClickable(btn),
          };

          if (entry.isCodeProse) {
            entry.verdict = 'BLOCKED:code-prose';
            report.wouldBlock.push(entry);
          } else if (entry.forbiddenZone.forbidden) {
            entry.verdict = 'BLOCKED:forbidden(' + entry.forbiddenZone.reason + ')';
            report.wouldBlock.push(entry);
          } else if (!text || text.length > 60) {
            entry.verdict = 'FILTERED:no-text-or-long';
          } else if (!entry.isAccept) {
            entry.verdict = 'FILTERED:not-accept';
          } else if (!entry.isClickable) {
            entry.verdict = 'FILTERED:not-clickable';
          } else {
            entry.verdict = '🚨 WOULD_CLICK';
            report.wouldClick.push(entry);
          }
        }
      }
    } else {
      report.scanMode = 'no-targets';
    }
  }

  return JSON.stringify(report);
})()
`;

// ── Main ────────────────────────────────────────
async function main() {
  const port = parseInt(process.argv[2]) || await discoverPort();

  console.log(`\\n${'═'.repeat(60)}`);
  console.log(`  🔬 Auto-Accept Diagnostic — CDP port ${port}`);
  console.log(`${'═'.repeat(60)}\\n`);

  // 1. List all targets
  let targets;
  try {
    targets = await httpGet(\`http://127.0.0.1:\${port}/json\`);
  } catch (e) {
    console.error(\`❌ Cannot reach CDP on port \${port}: \${e.message}\`);
    console.error('   Make sure the IDE is running with --remote-debugging-port=' + port);
    process.exit(1);
  }

  console.log(\`📋 CDP Targets (\${targets.length} total):\\n\`);
  for (const t of targets) {
    console.log(\`  [\${t.type}] "\${t.title}"\`);
    console.log(\`         url: \${t.url.substring(0, 100)}\`);
    console.log(\`         ws:  \${t.webSocketDebuggerUrl ? '✅' : '❌ no debugger URL'}\`);
    console.log();
  }

  // 2. Connect to each target and run diagnostic
  const filteredTargets = targets.filter(t => {
    if (!t.webSocketDebuggerUrl) return false;
    const urlLower = t.url.toLowerCase();
    // Mirror the filterTargets logic from antigravity.ts
    if (urlLower.includes('domyh-auto-accept') || urlLower.includes('domyh.auto-accept')) return false;
    if (t.type === 'webview' || t.type === 'iframe') return true;
    if (t.type === 'page' && urlLower.includes('workbench')) {
      if ((t.title || '').toLowerCase() === 'launchpad') return false;
      return true;
    }
    return false;
  });

  console.log(\`\\n🎯 Filtered targets for evaluation: \${filteredTargets.length}/\${targets.length}\\n\`);

  for (const target of filteredTargets) {
    console.log(\`${'─'.repeat(60)}\`);
    console.log(\`🔍 Evaluating: [\${target.type}] "\${target.title}"\`);
    console.log(\`${'─'.repeat(60)}\`);

    let ws;
    try {
      ws = await connectWS(target.webSocketDebuggerUrl);
    } catch (e) {
      console.log(\`  ❌ Cannot connect: \${e.message}\\n\`);
      continue;
    }

    try {
      const result = await cdpEval(ws, DIAGNOSTIC_PAYLOAD);

      if (result.error) {
        console.log(\`  ❌ Eval error: \${result.error}\\n\`);
        continue;
      }

      const report = typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
      if (!report) {
        console.log('  ⚠️  No report returned\\n');
        continue;
      }

      // ── Display report ──
      console.log(\`  📄 Page: \${report.pageTitle}\`);
      console.log(\`  🔗 URL:  \${report.pageURL}\`);
      console.log(\`  📱 isIframe:     \${report.isIframe}\`);
      console.log(\`  💬 isChatPanel:  \${report.isChatPanel}\`);
      console.log(\`  🔍 scanMode:     \${report.scanMode}\`);
      console.log(\`  📦 editorDiff:   \${report.editorDiffContainers?.length || 0} containers\`);
      console.log(\`  🔘 allButtons:   \${report.allButtonsFound || 0}\`);
      console.log();

      if (report.editorDiffContainers?.length > 0) {
        console.log('  📦 Editor Diff Containers:');
        for (const c of report.editorDiffContainers) {
          console.log(\`     - \${c.selector} → <\${c.tag} id="\${c.id}" class="\${c.cls}">\`);
        }
        console.log();
      }

      // 🚨 WOULD CLICK
      if (report.wouldClick?.length > 0) {
        console.log(\`  🚨 WOULD CLICK (\${report.wouldClick.length} buttons):\`);
        for (const btn of report.wouldClick) {
          console.log(\`     ┌─ 🚨 WOULD_CLICK\`);
          console.log(\`     │  tag:      <\${btn.tag}>\`);
          console.log(\`     │  text:     "\${btn.text}"\`);
          console.log(\`     │  aria:     "\${btn.ariaLabel}"\`);
          console.log(\`     │  class:    "\${btn.classList}"\`);
          console.log(\`     │  id:       "\${btn.id || ''}"\`);
          console.log(\`     │  rect:     \${btn.rect ? \`x:\${btn.rect.x} y:\${btn.rect.y} \${btn.rect.w}x\${btn.rect.h}\` : 'N/A'}\`);
          console.log(\`     │  container:\${btn.container || 'document'}\`);
          console.log(\`     └─\`);
        }
        console.log();
      } else {
        console.log('  ✅ No buttons would be clicked');
      }

      // 🛡️ BLOCKED
      if (report.wouldBlock?.length > 0) {
        console.log(\`  🛡️  BLOCKED (\${report.wouldBlock.length} buttons):\`);
        for (const btn of report.wouldBlock) {
          console.log(\`     - [\${btn.verdict}] <\${btn.tag}> "\${btn.text}" rect:\${btn.rect ? \`x:\${btn.rect.x} y:\${btn.rect.y}\` : 'N/A'}\`);
        }
        console.log();
      }

      // Summary
      const total = (report.wouldClick?.length || 0) + (report.wouldBlock?.length || 0) + (report.allFiltered?.length || 0);
      console.log(\`  📊 Summary: \${report.wouldClick?.length || 0} click / \${report.wouldBlock?.length || 0} blocked / \${total} total evaluated\`);

    } catch (e) {
      console.log(\`  ❌ Error: \${e.message}\`);
    } finally {
      ws.close();
    }
    console.log();
  }

  console.log(\`${'═'.repeat(60)}\`);
  console.log('  Diagnostic complete');
  console.log(\`${'═'.repeat(60)}\`);
}

main().catch(console.error);
