// Precisely find "Accept all" elements inside the chat iframe
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

const PORT = process.argv[2] || '9000';

async function main() {
  const resp = await new Promise((res, rej) => {
    http.get('http://127.0.0.1:' + PORT + '/json', r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });

  const target = resp.find(t => t.type === 'page' && t.url && t.url.includes('workbench') && t.title !== 'Launchpad');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

  // Find accept-related elements in the iframe via cross-frame access
  const result = await evalOn(ws, 1, `
    (function() {
      var iframes = document.querySelectorAll('iframe');
      var report = { iframeCount: iframes.length, acceptElements: [], allButtonLikeElements: [] };

      for (var fi = 0; fi < iframes.length; fi++) {
        try {
          var doc = iframes[fi].contentDocument || (iframes[fi].contentWindow && iframes[fi].contentWindow.document);
          if (!doc) continue;

          // 1. Find the exact "Accept all" span/button - broad search
          var allEls = doc.querySelectorAll('*');
          for (var i = 0; i < allEls.length; i++) {
            var el = allEls[i];
            var direct = '';
            // Get DIRECT text only (no child text)
            for (var ci = 0; ci < el.childNodes.length; ci++) {
              if (el.childNodes[ci].nodeType === 3) {
                direct += el.childNodes[ci].textContent;
              }
            }
            direct = direct.trim().toLowerCase();

            var ariaLabel = '';
            try { ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase(); } catch(e) {}

            // Match "accept all", "accept", "reject all", "reject"
            var matchText = direct || ariaLabel;
            if (matchText !== 'accept all' && matchText !== 'accept' && matchText !== 'reject all' && matchText !== 'reject' && matchText !== 'apply' && matchText !== 'apply all') continue;

            var rect = null;
            try { var r = el.getBoundingClientRect(); rect = {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; } catch(e) {}

            var parents = [];
            var p = el.parentElement;
            for (var d = 0; d < 8 && p; d++) {
              parents.push({
                d: d,
                tag: p.tagName,
                id: p.id || '',
                cls: (p.className||'').toString().substring(0,60),
                role: p.getAttribute && (p.getAttribute('role')||'') || '',
              });
              p = p.parentElement;
            }

            report.acceptElements.push({
              iframe: fi,
              tag: el.tagName,
              text: matchText,
              directText: direct,
              ariaLabel: ariaLabel,
              cls: (el.className||'').toString(),
              id: el.id || '',
              role: el.getAttribute && (el.getAttribute('role')||'') || '',
              rect: rect,
              visible: rect && rect.w > 0 && rect.h > 0,
              parents: parents,
            });
          }

          // 2. List all button-like elements (for comparison)
          var btnLike = doc.querySelectorAll('button, [role="button"], span[class*="bg-ide-button"], .monaco-button, .bg-ide-button-background');
          for (var bi = 0; bi < btnLike.length && bi < 30; bi++) {
            var b = btnLike[bi];
            var bt = (b.getAttribute('aria-label') || b.textContent || '').trim().toLowerCase().substring(0, 40);
            var br = null;
            try { var r2 = b.getBoundingClientRect(); br = {x:Math.round(r2.x),y:Math.round(r2.y),w:Math.round(r2.width),h:Math.round(r2.height)}; } catch(e) {}
            report.allButtonLikeElements.push({
              iframe: fi,
              tag: b.tagName,
              text: bt,
              cls: (b.className||'').toString().substring(0,80),
              rect: br,
            });
          }

        } catch(e) {
          report.acceptElements.push({iframe: fi, error: e.message});
        }
      }

      return JSON.stringify(report);
    })()
  `);

  const data = JSON.parse(result);
  fs.writeFileSync('scripts/accept-elements.json', JSON.stringify(data, null, 2));

  console.log('Iframes:', data.iframeCount);
  console.log();

  console.log('=== ACCEPT ELEMENTS (exact match) ===');
  for (const el of data.acceptElements) {
    if (el.error) { console.log('[iframe ' + el.iframe + '] error: ' + el.error); continue; }
    console.log('[iframe ' + el.iframe + '] <' + el.tag + '> text="' + el.text + '"');
    console.log('  cls:     ' + el.cls);
    console.log('  role:    ' + el.role);
    console.log('  rect:    ' + JSON.stringify(el.rect));
    console.log('  visible: ' + el.visible);
    console.log('  parents:');
    for (const p of el.parents) {
      console.log('    ^' + p.d + ' <' + p.tag + '> id="' + p.id + '" cls="' + p.cls + '" role="' + p.role + '"');
    }
    console.log();
  }

  console.log('=== BUTTON-LIKE ELEMENTS IN IFRAME ===');
  for (const b of data.allButtonLikeElements) {
    console.log('  [iframe ' + b.iframe + '] <' + b.tag + '> "' + b.text + '" cls="' + b.cls + '"' + (b.rect ? ' rect=' + JSON.stringify(b.rect) : ''));
  }

  ws.close();
}

function evalOn(ws, id, expr) {
  return new Promise((res, rej) => {
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.removeListener('message', handler);
        if (msg.result && msg.result.result && msg.result.result.value !== undefined) res(msg.result.result.value);
        else res(JSON.stringify({error: 'no value', detail: JSON.stringify(msg).substring(0, 300)}));
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
    setTimeout(() => { ws.removeListener('message', handler); rej(new Error('timeout')); }, 8000);
  });
}

main().catch(e => { console.error('Fatal:', e.message); });
