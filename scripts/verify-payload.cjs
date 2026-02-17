/**
 * verify-payload.cjs — Comprehensive verification of auto-accept payload logic
 *
 * Tests the ACTUAL payload from src/payload/auto-accept.js against the live IDE
 * by connecting to CDP and evaluating on:
 *   1. Main workbench page (Phase 1 — editor diff containers)
 *   2. Iframe execution contexts (Phase 2 — chat panel buttons)
 *
 * Does NOT click anything — replaces btn.click() with report collection.
 * Reports exactly what WOULD be clicked, blocked, and why.
 *
 * Usage: node scripts/verify-payload.cjs [port]
 */

const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const CDP_PORT = process.argv[2] || '9000';
const TIMEOUT = 5000;

// ─── Build the diagnostic payload ─────────────────────────────
// Read the REAL payload source and convert click() to reporting
function buildDiagnosticPayload() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'payload', 'auto-accept.js'),
    'utf-8'
  );

  // Replace the execution section (from "// Execute with safety wrapper" to end)
  // with diagnostic reporting instead
  const markerIdx = src.indexOf('// Execute with safety wrapper');
  if (markerIdx === -1) {
    throw new Error('Could not find "// Execute with safety wrapper" marker in payload source');
  }

  const coreFunctions = src.substring(0, markerIdx);

  // Build diagnostic version that REPORTS instead of CLICKING
  const diagnosticExec = `
// ── DIAGNOSTIC MODE — report only, no clicks ──
(function() {
  var report = {
    isTop: false,
    isChatPanel: false,
    scanMode: 'unknown',
    diffContainers: [],
    allButtons: [],
    acceptButtons: [],
    blockedButtons: [],
    forbiddenZoneButtons: [],
    codeProseButtons: [],
    notClickableButtons: [],
    longTextButtons: [],
    rejectWordButtons: [],
    wouldClick: [],
    title: document.title,
    url: location.href.substring(0, 120),
    timestamp: Date.now(),
  };

  try { report.isTop = (window === window.top); } catch(e) { report.isTop = false; }
  report.isChatPanel = isChatPanelIframe();

  // ── Branch 1: Chat panel iframe ──
  if (report.isChatPanel) {
    report.scanMode = 'chat-panel';
    var allBtns = deepQuerySelectorAll(document, BUTTON_SELECTORS);
    report.allButtons = allBtns.map(function(b, idx) {
      var t = getButtonText(b);
      var rect = null;
      try { var r = b.getBoundingClientRect(); rect = {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; } catch(e) {}
      return {i: idx, tag: b.tagName, text: t, cls: (b.className||'').toString().substring(0,80), rect: rect};
    });

    for (var i = 0; i < allBtns.length; i++) {
      var btn = allBtns[i];
      var text = getButtonText(btn);
      var info = {i: i, tag: btn.tagName, text: text, cls: (btn.className||'').toString().substring(0,60)};

      if (isInsideCodeOrProse(btn)) { report.codeProseButtons.push(info); continue; }
      if (isInsideForbiddenZone(btn)) { report.forbiddenZoneButtons.push(info); continue; }
      if (!text) continue;
      if (text.length > 60) { report.longTextButtons.push(info); continue; }

      var isReject = false;
      for (var r = 0; r < REJECT_WORDS.length; r++) {
        if (text === REJECT_WORDS[r] || text.indexOf(REJECT_WORDS[r]) === 0) { isReject = true; break; }
      }
      if (isReject) { report.rejectWordButtons.push(info); continue; }

      if (isAcceptButton(text)) {
        if (isElementClickable(btn)) {
          report.wouldClick.push(info);
        } else {
          report.notClickableButtons.push(info);
        }
      }
    }
    return JSON.stringify(report);
  }

  // ── Branch 2: Main workbench ──
  var containers = findEditorDiffContainers();
  report.diffContainers = containers.map(function(c) {
    return {tag: c.tagName, id: c.id || '', cls: (c.className||'').toString().substring(0,60)};
  });

  if (containers.length > 0) {
    report.scanMode = 'editor-diff';
    var checked = [];
    for (var ci = 0; ci < containers.length; ci++) {
      var btns = deepQuerySelectorAll(containers[ci], BUTTON_SELECTORS);
      for (var bi = 0; bi < btns.length; bi++) {
        var b = btns[bi];
        if (checked.indexOf(b) !== -1) continue;
        checked.push(b);
        var t = getButtonText(b);
        var rect = null;
        try { var r2 = b.getBoundingClientRect(); rect = {x:Math.round(r2.x),y:Math.round(r2.y),w:Math.round(r2.width),h:Math.round(r2.height)}; } catch(e) {}
        var info2 = {i: bi, tag: b.tagName, text: t, cls: (b.className||'').toString().substring(0,60), rect: rect, container: ci};

        report.allButtons.push(info2);

        if (isInsideCodeOrProse(b)) { report.codeProseButtons.push(info2); continue; }
        if (isInsideForbiddenZone(b)) { report.forbiddenZoneButtons.push(info2); continue; }
        if (!t) continue;
        if (t.length > 60) { report.longTextButtons.push(info2); continue; }

        var isRej = false;
        for (var rj = 0; rj < REJECT_WORDS.length; rj++) {
          if (t === REJECT_WORDS[rj] || t.indexOf(REJECT_WORDS[rj]) === 0) { isRej = true; break; }
        }
        if (isRej) { report.rejectWordButtons.push(info2); continue; }

        if (isAcceptButton(t)) {
          if (isElementClickable(b)) {
            report.wouldClick.push(info2);
          } else {
            report.notClickableButtons.push(info2);
          }
        }
      }
    }
  } else {
    report.scanMode = 'no-targets';

    // Also report what buttons exist on the page for debugging
    var globalBtns = deepQuerySelectorAll(document, BUTTON_SELECTORS);
    var acceptCandidates = [];
    for (var gi = 0; gi < globalBtns.length && gi < 100; gi++) {
      var gb = globalBtns[gi];
      var gt = getButtonText(gb);
      if (gt && isAcceptButton(gt)) {
        var rect3 = null;
        try { var r3 = gb.getBoundingClientRect(); rect3 = {x:Math.round(r3.x),y:Math.round(r3.y),w:Math.round(r3.width),h:Math.round(r3.height)}; } catch(e) {}
        var forbidden = isInsideForbiddenZone(gb);
        acceptCandidates.push({tag:gb.tagName, text:gt, forbidden:forbidden, clickable:isElementClickable(gb), rect:rect3, cls:(gb.className||'').toString().substring(0,60)});
      }
    }
    report.acceptCandidatesOnPage = acceptCandidates;
    report.totalButtonsOnPage = globalBtns.length;
  }

  return JSON.stringify(report);
})()`;

  return coreFunctions + diagnosticExec;
}

// ─── CDP communication ────────────────────────────
function sendCDP(ws, method, params, timeout) {
  return new Promise(function(resolve, reject) {
    var id = Math.floor(Math.random() * 100000);
    var timer = setTimeout(function() {
      ws.removeListener('message', handler);
      reject(new Error('Timeout: ' + method));
    }, timeout || TIMEOUT);

    function handler(data) {
      var msg = JSON.parse(data.toString());
      if (msg.id === id) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    }

    ws.on('message', handler);
    ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
  });
}

async function getTargets() {
  return new Promise(function(resolve, reject) {
    http.get('http://127.0.0.1:' + CDP_PORT + '/json', function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() { resolve(JSON.parse(d)); });
    }).on('error', reject);
  });
}

// ─── Main ─────────────────────────────────────────
async function main() {
  console.log('='.repeat(70));
  console.log('  PAYLOAD VERIFICATION SCRIPT');
  console.log('  CDP Port: ' + CDP_PORT);
  console.log('  Payload: src/payload/auto-accept.js (diagnostic mode)');
  console.log('='.repeat(70));

  // 1. Build diagnostic payload
  var payload = buildDiagnosticPayload();
  console.log('\n[1] Diagnostic payload built (' + payload.length + ' chars)');

  // 2. Get CDP targets
  var targets = await getTargets();
  console.log('\n[2] CDP targets: ' + targets.length);

  // Filter for workbench page (same logic as AntigravityAdapter.filterTargets)
  var workbenchTarget = null;
  for (var i = 0; i < targets.length; i++) {
    var t = targets[i];
    console.log('    [' + i + '] type=' + t.type + ' title="' + (t.title || '').substring(0, 50) + '"');
    if (t.type === 'page' && t.url && t.url.includes('workbench') && t.title !== 'Launchpad') {
      workbenchTarget = t;
    }
  }

  if (!workbenchTarget) {
    console.log('\n*** ERROR: No workbench target found! ***');
    return;
  }

  // 3. Connect to workbench
  console.log('\n[3] Connecting to: ' + workbenchTarget.title);
  var ws = new WebSocket(workbenchTarget.webSocketDebuggerUrl);
  await new Promise(function(res, rej) { ws.on('open', res); ws.on('error', rej); });
  console.log('    Connected!');

  // 4. Enable Runtime to track iframe execution contexts
  console.log('\n[4] Enabling Runtime domain to discover iframe contexts...');
  var executionContexts = [];

  // Listen for execution context events BEFORE enabling
  ws.on('message', function(data) {
    var msg = JSON.parse(data.toString());
    if (msg.method === 'Runtime.executionContextCreated') {
      var ctx = msg.params.context;
      executionContexts.push({
        id: ctx.id,
        name: ctx.name || '',
        origin: ctx.origin || '',
        auxData: ctx.auxData || {},
      });
    }
  });

  await sendCDP(ws, 'Runtime.enable', {});
  // Wait a bit for contexts to arrive
  await new Promise(function(r) { setTimeout(r, 1000); });
  console.log('    Found ' + executionContexts.length + ' execution contexts:');
  for (var ei = 0; ei < executionContexts.length; ei++) {
    var ec = executionContexts[ei];
    var isMainFrame = ec.auxData && ec.auxData.isDefault && ec.auxData.type === 'default';
    console.log('    [' + ec.id + '] name="' + ec.name + '" origin="' + ec.origin + '"' + (isMainFrame ? ' (main)' : ''));
  }

  // 5. Phase 1: Evaluate on main workbench (same as engine Phase 1)
  console.log('\n[5] PHASE 1 — Main workbench evaluation');
  console.log('-'.repeat(50));
  var wrapPayload = '(function(){ ' + payload + ' })()';
  var mainResult = await sendCDP(ws, 'Runtime.evaluate', {
    expression: wrapPayload,
    returnByValue: true,
    timeout: TIMEOUT,
  });

  var mainReport = null;
  if (mainResult.result && mainResult.result.result && mainResult.result.result.value) {
    mainReport = JSON.parse(mainResult.result.result.value);
    printReport('WORKBENCH', mainReport);
  } else if (mainResult.result && mainResult.result.exceptionDetails) {
    console.log('    *** EXCEPTION: ' + JSON.stringify(mainResult.result.exceptionDetails.text || mainResult.result.exceptionDetails));
  } else {
    console.log('    *** No result returned');
    console.log('    Raw:', JSON.stringify(mainResult).substring(0, 300));
  }

  // 6. Phase 2: Evaluate on iframe contexts (same as engine Phase 2)
  console.log('\n[6] PHASE 2 — Iframe execution contexts');
  console.log('-'.repeat(50));

  // Filter for non-main-frame contexts (iframes)
  var iframeContexts = executionContexts.filter(function(ctx) {
    // Skip main frame context
    if (ctx.auxData && ctx.auxData.isDefault && ctx.auxData.type === 'default') return false;
    // Include iframes matching known patterns
    var name = ctx.name.toLowerCase();
    var origin = ctx.origin.toLowerCase();
    return name.includes('cascade') || name.includes('agent') || name.includes('chat') ||
           origin.includes('vscode-webview') || ctx.auxData.type === 'isolated' ||
           true; // Include ALL non-main contexts for diagnostics
  });

  console.log('    ' + iframeContexts.length + ' iframe contexts to evaluate');

  var iframeReports = [];
  for (var ii = 0; ii < iframeContexts.length; ii++) {
    var ictx = iframeContexts[ii];
    console.log('\n    [ctx:' + ictx.id + '] name="' + ictx.name + '"');

    try {
      var iResult = await sendCDP(ws, 'Runtime.evaluate', {
        expression: wrapPayload,
        contextId: ictx.id,
        returnByValue: true,
        timeout: TIMEOUT,
      });

      if (iResult.result && iResult.result.result && iResult.result.result.value) {
        var iReport = JSON.parse(iResult.result.result.value);
        iframeReports.push({ contextId: ictx.id, name: ictx.name, report: iReport });
        printReport('IFRAME:' + ictx.id, iReport);
      } else if (iResult.result && iResult.result.exceptionDetails) {
        console.log('      Exception: ' + (iResult.result.exceptionDetails.text || 'unknown'));
      } else if (iResult.error) {
        console.log('      Error: ' + (iResult.error.message || JSON.stringify(iResult.error)));
      } else {
        console.log('      No result');
      }
    } catch (err) {
      console.log('      Failed: ' + err.message);
    }
  }

  // 7. Summary
  console.log('\n' + '='.repeat(70));
  console.log('  VERIFICATION SUMMARY');
  console.log('='.repeat(70));

  var totalWouldClick = 0;
  if (mainReport) {
    totalWouldClick += (mainReport.wouldClick || []).length;
    console.log('\n  WORKBENCH (Phase 1):');
    console.log('    Scan mode:       ' + mainReport.scanMode);
    console.log('    Diff containers: ' + (mainReport.diffContainers || []).length);
    console.log('    Would click:     ' + (mainReport.wouldClick || []).length);
    console.log('    Forbidden zone:  ' + (mainReport.forbiddenZoneButtons || []).length + ' blocked');
    console.log('    Code/prose:      ' + (mainReport.codeProseButtons || []).length + ' blocked');
    if (mainReport.acceptCandidatesOnPage) {
      console.log('    Accept candidates on page (NOT clicked - no diff container): ' + mainReport.acceptCandidatesOnPage.length);
      for (var ac = 0; ac < mainReport.acceptCandidatesOnPage.length; ac++) {
        var cand = mainReport.acceptCandidatesOnPage[ac];
        console.log('      <' + cand.tag + '> "' + cand.text + '" forbidden=' + cand.forbidden + ' clickable=' + cand.clickable + ' rect=' + JSON.stringify(cand.rect));
      }
    }
  }

  for (var ri = 0; ri < iframeReports.length; ri++) {
    var ir = iframeReports[ri].report;
    totalWouldClick += (ir.wouldClick || []).length;
    if ((ir.allButtons || []).length > 0 || ir.isChatPanel) {
      console.log('\n  IFRAME ctx:' + iframeReports[ri].contextId + ' (' + iframeReports[ri].name + '):');
      console.log('    Is chat panel:   ' + ir.isChatPanel);
      console.log('    Scan mode:       ' + ir.scanMode);
      console.log('    All buttons:     ' + (ir.allButtons || []).length);
      console.log('    Would click:     ' + (ir.wouldClick || []).length);
      console.log('    Forbidden zone:  ' + (ir.forbiddenZoneButtons || []).length + ' blocked');
      console.log('    Code/prose:      ' + (ir.codeProseButtons || []).length + ' blocked');
    }
  }

  console.log('\n  ────────────');
  console.log('  TOTAL WOULD CLICK: ' + totalWouldClick);
  if (totalWouldClick === 0) {
    console.log('  ⚠ NO BUTTONS WOULD BE CLICKED');
    console.log('    Possible reasons:');
    if (mainReport && mainReport.scanMode === 'no-targets') {
      console.log('    - Workbench: No editor diff containers found (no .chat-editing-session, .chatEditing, etc.)');
    }
    if (iframeReports.length === 0) {
      console.log('    - No iframe execution contexts detected');
    }
    var foundChatPanel = iframeReports.some(function(r) { return r.report.isChatPanel; });
    if (!foundChatPanel) {
      console.log('    - No iframe detected as chat panel (missing #conversation, .notify-user-container)');
    }
  } else {
    console.log('  ✓ Extension WOULD click these buttons (correctly):');
    if (mainReport && mainReport.wouldClick) {
      for (var w = 0; w < mainReport.wouldClick.length; w++) {
        console.log('    [workbench] "' + mainReport.wouldClick[w].text + '"');
      }
    }
    for (var iri = 0; iri < iframeReports.length; iri++) {
      var wc = iframeReports[iri].report.wouldClick || [];
      for (var wci = 0; wci < wc.length; wci++) {
        console.log('    [iframe:' + iframeReports[iri].contextId + '] "' + wc[wci].text + '"');
      }
    }
  }

  // Save full report
  var fullReport = { workbench: mainReport, iframes: iframeReports, totalWouldClick: totalWouldClick };
  fs.writeFileSync(path.join(__dirname, 'verification-report.json'), JSON.stringify(fullReport, null, 2));
  console.log('\n  Full report saved to: scripts/verification-report.json');

  ws.close();
}

function printReport(label, report) {
  console.log('    [' + label + '] scanMode=' + report.scanMode + ' isTop=' + report.isTop + ' isChatPanel=' + report.isChatPanel);
  console.log('      Diff containers: ' + (report.diffContainers || []).length);
  console.log('      All buttons: ' + (report.allButtons || []).length);
  console.log('      Would click: ' + (report.wouldClick || []).length);
  if ((report.wouldClick || []).length > 0) {
    for (var w = 0; w < report.wouldClick.length; w++) {
      var btn = report.wouldClick[w];
      console.log('        ✓ <' + btn.tag + '> "' + btn.text + '" cls="' + (btn.cls||'').substring(0,40) + '"');
    }
  }
  console.log('      Forbidden zone: ' + (report.forbiddenZoneButtons || []).length);
  console.log('      Code/prose: ' + (report.codeProseButtons || []).length);
  console.log('      Reject words: ' + (report.rejectWordButtons || []).length);
  console.log('      Not clickable: ' + (report.notClickableButtons || []).length);
}

main().catch(function(e) { console.error('Fatal: ' + e.message); process.exit(1); });
