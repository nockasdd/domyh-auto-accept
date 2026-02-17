/**
 * verify-fix.cjs — Test the updated payload with Branch 3 (iframe traversal)
 *
 * Reads the LATEST src/payload/auto-accept.js, converts clicks to reports,
 * and evaluates it on the live IDE via CDP.
 *
 * This simulates EXACTLY what the engine does (Phase 1: evaluate on workbench page).
 * The payload should now find the "Accept all" span via Branch 3's scanIframeDocuments().
 *
 * Usage: node scripts/verify-fix.cjs [port]
 */

const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const CDP_PORT = process.argv[2] || '9000';

function buildDiagnosticPayload() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'payload', 'auto-accept.js'),
    'utf-8'
  );

  // Replace click() with report collection
  // Find the execute section and replace it
  const markerIdx = src.indexOf('// Execute with safety wrapper');
  if (markerIdx === -1) throw new Error('Marker not found');

  const core = src.substring(0, markerIdx);

  // Replace ALL occurrences of btn.click() with report push, and
  // buttons[i].click() and iframeButtons[ib].click() similarly
  // We wrap the entire core + new diagnostic executor
  const diagnostic = `
// ── DIAGNOSTIC MODE ──
(function diagnosticRun() {
  var report = {
    isTop: false,
    isChatPanel: false,
    scanMode: 'unknown',
    wouldClick: [],
    diffContainers: 0,
    iframesCanned: 0,
    chatIframesFound: 0,
    allButtonsInIframes: 0,
    branches: [],
  };

  try { report.isTop = (window === window.top); } catch(e) {}
  report.isChatPanel = isChatPanelIframe();

  // Simulate findAndClickAcceptButtons with reporting instead of clicking
  if (report.isChatPanel) {
    report.scanMode = 'chat-panel';
    report.branches.push('Branch 1: chat panel');
    var buttons = findChatPanelButtons();
    for (var i = 0; i < buttons.length; i++) {
      report.wouldClick.push({
        branch: 1,
        tag: buttons[i].tagName,
        text: getButtonText(buttons[i]),
        cls: (buttons[i].className||'').toString().substring(0, 80),
      });
    }
    return JSON.stringify(report);
  }

  // Branch 2: Editor diff
  var containers = findEditorDiffContainers();
  report.diffContainers = containers.length;
  if (containers.length > 0) {
    report.scanMode = 'editor-diff';
    report.branches.push('Branch 2: editor diff (' + containers.length + ' containers)');
    var checked = [];
    for (var c = 0; c < containers.length; c++) {
      var btns = deepQuerySelectorAll(containers[c], BUTTON_SELECTORS);
      for (var i = 0; i < btns.length; i++) {
        var btn = btns[i];
        if (checked.indexOf(btn) !== -1) continue;
        checked.push(btn);
        if (isInsideCodeOrProse(btn)) continue;
        if (isInsideForbiddenZone(btn)) continue;
        var text = getButtonText(btn);
        if (!text) continue;
        if (isAcceptButton(text) && isElementClickable(btn)) {
          report.wouldClick.push({
            branch: 2,
            tag: btn.tagName,
            text: text,
            cls: (btn.className||'').toString().substring(0, 80),
          });
        }
      }
    }
  }

  // Branch 3: Iframe traversal (THE KEY FIX)
  if (report.wouldClick.length === 0) {
    report.branches.push('Branch 3: iframe traversal');

    // Detailed iframe scan report
    var iframes = document.querySelectorAll('iframe');
    report.iframesCanned = iframes.length;

    for (var fi = 0; fi < iframes.length; fi++) {
      try {
        var doc = iframes[fi].contentDocument || (iframes[fi].contentWindow && iframes[fi].contentWindow.document);
        if (!doc) { report.branches.push('  iframe[' + fi + ']: no contentDocument'); continue; }

        var isChat = !!doc.getElementById('conversation') ||
                     !!doc.querySelector('.notify-user-container') ||
                     !!doc.querySelector('[data-tooltip-id="cascade-header-menu"]');

        report.branches.push('  iframe[' + fi + ']: accessible, isChat=' + isChat + ', src=' + (iframes[fi].src || '').substring(0, 80));

        if (!isChat) continue;
        report.chatIframesFound++;

        var found = doc.querySelectorAll(BUTTON_SELECTORS);
        report.allButtonsInIframes = found.length;

        for (var i = 0; i < found.length; i++) {
          var ibtn = found[i];
          var inCode = isInsideCodeOrProse(ibtn);
          var itext = getButtonText(ibtn);
          var isAccept = itext ? isAcceptButton(itext) : false;
          var clickable = isElementClickable(ibtn);

          if (isAccept) {
            var rect = null;
            try { var r = ibtn.getBoundingClientRect(); rect = {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; } catch(e) {}

            report.branches.push('    [' + i + '] <' + ibtn.tagName + '> "' + itext + '" inCode=' + inCode + ' clickable=' + clickable + ' rect=' + JSON.stringify(rect));

            if (!inCode && clickable) {
              report.wouldClick.push({
                branch: 3,
                tag: ibtn.tagName,
                text: itext,
                cls: (ibtn.className||'').toString().substring(0, 80),
                rect: rect,
              });
            }
          }
        }
      } catch (e) {
        report.branches.push('  iframe[' + fi + ']: cross-origin (' + e.message + ')');
      }
    }

    if (report.wouldClick.length > 0) {
      report.scanMode = 'iframe-traverse';
    } else if (report.scanMode === 'unknown') {
      report.scanMode = 'no-targets';
    }
  }

  return JSON.stringify(report);
})()`;

  return core + diagnostic;
}

async function main() {
  console.log('='.repeat(60));
  console.log('  VERIFY FIX — Testing Updated Payload');
  console.log('  Branch 3: iframe traversal for Accept all span');
  console.log('='.repeat(60));

  const payload = buildDiagnosticPayload();
  console.log('\nPayload size: ' + payload.length + ' chars');

  // Get targets
  const targets = await new Promise((res, rej) => {
    http.get('http://127.0.0.1:' + CDP_PORT + '/json', r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });

  const target = targets.find(t => t.type === 'page' && t.url && t.url.includes('workbench') && t.title !== 'Launchpad');
  if (!target) { console.log('ERROR: No workbench target'); return; }

  console.log('Target: ' + target.title);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

  // Evaluate
  const result = await new Promise((res, rej) => {
    const id = 42;
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.removeListener('message', handler);
        res(msg);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression: payload, returnByValue: true, timeout: 8000 },
    }));
    setTimeout(() => { ws.removeListener('message', handler); rej(new Error('timeout')); }, 10000);
  });

  if (result.result && result.result.result && result.result.result.value) {
    const report = JSON.parse(result.result.result.value);

    console.log('\n' + '─'.repeat(60));
    console.log('RESULT:');
    console.log('  isTop:          ' + report.isTop);
    console.log('  isChatPanel:    ' + report.isChatPanel);
    console.log('  scanMode:       ' + report.scanMode);
    console.log('  diffContainers: ' + report.diffContainers);
    console.log('  iframesScanned: ' + report.iframesCanned);
    console.log('  chatIframes:    ' + report.chatIframesFound);
    console.log('  btnsInIframes:  ' + report.allButtonsInIframes);

    console.log('\n  Branch trace:');
    for (const b of report.branches) {
      console.log('    ' + b);
    }

    console.log('\n' + '━'.repeat(60));
    if (report.wouldClick.length > 0) {
      console.log('  ✓ WOULD CLICK ' + report.wouldClick.length + ' button(s):');
      for (const w of report.wouldClick) {
        console.log('    [Branch ' + w.branch + '] <' + w.tag + '> "' + w.text + '"');
        if (w.rect) console.log('      rect: ' + JSON.stringify(w.rect));
        console.log('      cls: ' + w.cls);
      }
      console.log('\n  ✓ FIX IS WORKING — payload finds the Accept all button!');
    } else {
      console.log('  ✗ WOULD CLICK 0 buttons');
      console.log('  ✗ FIX NOT WORKING — need further investigation');
    }
    console.log('━'.repeat(60));

    // Save
    fs.writeFileSync(path.join(__dirname, 'verification-result.json'), JSON.stringify(report, null, 2));
    console.log('\nFull report: scripts/verification-result.json');
  } else {
    console.log('\nERROR: No result returned');
    if (result.result && result.result.exceptionDetails) {
      console.log('Exception:', JSON.stringify(result.result.exceptionDetails, null, 2));
    } else {
      console.log('Raw:', JSON.stringify(result).substring(0, 500));
    }
  }

  ws.close();
}

main().catch(e => { console.error('Fatal:', e.message); });
