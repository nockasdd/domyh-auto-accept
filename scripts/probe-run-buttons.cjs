// Probe the exact DOM structure of Run/Reject/Always Run buttons in the chat iframe
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.argv[2] || '9000';

async function main() {
  const targets = await new Promise((res, rej) => {
    http.get('http://127.0.0.1:' + PORT + '/json', r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });

  const target = targets.find(t => t.type === 'page' && t.url && t.url.includes('workbench') && t.title !== 'Launchpad');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

  const result = await evalOn(ws, 1, `
    (function() {
      var iframes = document.querySelectorAll('iframe');
      var report = { runButtons: [], acceptButtons: [], rejectButtons: [], otherActions: [] };

      for (var fi = 0; fi < iframes.length; fi++) {
        try {
          var doc = iframes[fi].contentDocument || (iframes[fi].contentWindow && iframes[fi].contentWindow.document);
          if (!doc) continue;
          if (!doc.getElementById('conversation')) continue;

          // Find ALL clickable elements with action text
          var allBtns = doc.querySelectorAll('button, [role="button"], span[class*="bg-ide-button"], span.cursor-pointer, span[class*="bg-primary"], span[class*="bg-secondary"]');

          for (var i = 0; i < allBtns.length; i++) {
            var btn = allBtns[i];
            var text = '';
            // Get text content
            for (var ci = 0; ci < btn.childNodes.length; ci++) {
              if (btn.childNodes[ci].nodeType === 3) text += btn.childNodes[ci].textContent;
            }
            if (!text.trim()) text = (btn.textContent || '').trim();
            text = text.trim().toLowerCase();
            if (!text) continue;

            var rect = null;
            try { var r = btn.getBoundingClientRect(); rect = {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; } catch(e) {}

            // Classify
            var entry = {
              tag: btn.tagName,
              text: text.substring(0, 60),
              cls: (btn.className||'').toString().substring(0, 100),
              rect: rect,
              visible: rect && rect.w > 0 && rect.h > 0 && rect.y > -500,
            };

            // Get parent context (what section is this in?)
            var parent = btn.parentElement;
            var parentClasses = [];
            for (var d = 0; d < 5 && parent; d++) {
              parentClasses.push({
                tag: parent.tagName,
                cls: (parent.className||'').toString().substring(0, 60),
              });
              parent = parent.parentElement;
            }
            entry.parents = parentClasses;

            // Identify nearby text for context
            var container = btn.closest('[class*="border"]') || btn.closest('[class*="rounded"]');
            if (container) {
              var headerSpan = container.querySelector('.opacity-60, [class*="opacity-60"]');
              entry.sectionLabel = headerSpan ? (headerSpan.textContent || '').trim().substring(0, 40) : '';
            }

            if (text === 'run' || text.startsWith('run ') || text === 'always run') {
              report.runButtons.push(entry);
            } else if (text.indexOf('accept') !== -1 || text.indexOf('apply') !== -1) {
              report.acceptButtons.push(entry);
            } else if (text === 'reject' || text === 'cancel' || text.indexOf('reject') !== -1) {
              report.rejectButtons.push(entry);
            } else if (text === 'ask every time' || text === 'always allow' || text === 'go to terminal') {
              report.otherActions.push(entry);
            }
          }
        } catch(e) {
          report.error = e.message;
        }
      }
      return JSON.stringify(report);
    })()
  `);

  const data = JSON.parse(result);
  fs.writeFileSync(path.join(__dirname, 'run-buttons.json'), JSON.stringify(data, null, 2));

  console.log('=== RUN BUTTONS ===');
  for (const b of data.runButtons) {
    console.log('  <' + b.tag + '> "' + b.text + '" visible=' + b.visible + ' section="' + (b.sectionLabel||'') + '"');
    console.log('    cls: ' + b.cls);
    console.log('    rect: ' + JSON.stringify(b.rect));
  }

  console.log('\\n=== ACCEPT BUTTONS ===');
  for (const b of data.acceptButtons) {
    console.log('  <' + b.tag + '> "' + b.text + '" visible=' + b.visible);
    console.log('    cls: ' + b.cls);
  }

  console.log('\\n=== REJECT BUTTONS ===');
  for (const b of data.rejectButtons) {
    console.log('  <' + b.tag + '> "' + b.text + '" visible=' + b.visible);
  }

  console.log('\\n=== OTHER ACTIONS ===');
  for (const b of data.otherActions) {
    console.log('  <' + b.tag + '> "' + b.text + '" visible=' + b.visible);
  }

  ws.close();
}

function evalOn(ws, id, expr) {
  return new Promise((res, rej) => {
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) { ws.removeListener('message', handler); res(msg.result.result.value); }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
    setTimeout(() => { ws.removeListener('message', handler); rej(new Error('timeout')); }, 8000);
  });
}

main().catch(e => console.error('Fatal:', e.message));
