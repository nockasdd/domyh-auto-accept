// Probe the iframe inside the workbench to check for chat panel
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
  if (!target) { console.log('No target'); return; }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

  // 1. Check iframe details
  const iframeInfo = await evalOn(ws, 1, `
    (function() {
      var iframes = document.querySelectorAll('iframe');
      var results = [];
      for (var i = 0; i < iframes.length; i++) {
        var fr = iframes[i];
        var info = {
          src: (fr.src || '').substring(0, 200),
          id: fr.id || '',
          cls: (fr.className || '').toString().substring(0, 80),
          rect: null,
          canAccess: false,
          contentInfo: null,
        };
        try { var r = fr.getBoundingClientRect(); info.rect = {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; } catch(e) {}

        // Try to access iframe content
        try {
          var doc = fr.contentDocument || (fr.contentWindow && fr.contentWindow.document);
          if (doc) {
            info.canAccess = true;
            var btns = doc.querySelectorAll('button, [role="button"]');
            var acceptBtns = [];
            for (var b = 0; b < btns.length; b++) {
              var text = (btns[b].getAttribute('aria-label') || btns[b].textContent || '').trim().toLowerCase().substring(0,60);
              if (text.indexOf('accept') !== -1 || text.indexOf('apply') !== -1 || text.indexOf('allow') !== -1) {
                var br = null;
                try { br = btns[b].getBoundingClientRect(); br = {x:Math.round(br.x),y:Math.round(br.y),w:Math.round(br.width),h:Math.round(br.height)}; } catch(e) {}
                acceptBtns.push({text: text, cls: (btns[b].className||'').toString().substring(0,60), rect: br});
              }
            }
            info.contentInfo = {
              title: doc.title || '',
              url: (doc.location && doc.location.href || '').substring(0, 200),
              totalButtons: btns.length,
              acceptButtons: acceptBtns,
              hasConversation: !!doc.getElementById('conversation'),
              hasNotifyUser: !!doc.querySelector('.notify-user-container'),
              hasCascade: !!doc.querySelector('[data-tooltip-id="cascade-header-menu"]'),
            };
          }
        } catch(e) {
          info.crossOrigin = true;
          info.crossOriginError = e.message;
        }
        results.push(info);
      }

      // Also check deep shadow DOM for iframes
      function deepFindIframes(root) {
        var found = [];
        try {
          var all = root.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            if (all[i].shadowRoot) {
              var shadowIframes = all[i].shadowRoot.querySelectorAll('iframe');
              for (var j = 0; j < shadowIframes.length; j++) {
                found.push({
                  inShadow: true,
                  hostTag: all[i].tagName,
                  hostId: all[i].id || '',
                  src: (shadowIframes[j].src || '').substring(0, 200),
                  id: shadowIframes[j].id || '',
                });
              }
              // Recurse
              var deeper = deepFindIframes(all[i].shadowRoot);
              for (var k = 0; k < deeper.length; k++) found.push(deeper[k]);
            }
          }
        } catch(e) {}
        return found;
      }
      var shadowIframes = deepFindIframes(document);

      return JSON.stringify({iframes: results, shadowIframes: shadowIframes, totalShadowIframes: shadowIframes.length});
    })()
  `);

  const data = JSON.parse(iframeInfo);
  console.log('=== IFRAME ANALYSIS ===\n');
  console.log('Light DOM iframes:', data.iframes.length);
  console.log('Shadow DOM iframes:', data.totalShadowIframes);

  for (let i = 0; i < data.iframes.length; i++) {
    const f = data.iframes[i];
    console.log('\n--- Iframe [' + i + '] ---');
    console.log('  src: ' + f.src);
    console.log('  id:  ' + f.id);
    console.log('  cls: ' + f.cls);
    console.log('  rect: ' + JSON.stringify(f.rect));
    console.log('  canAccess: ' + f.canAccess);
    if (f.crossOrigin) console.log('  CROSS-ORIGIN: ' + f.crossOriginError);
    if (f.contentInfo) {
      console.log('  content.title:   ' + f.contentInfo.title);
      console.log('  content.url:     ' + f.contentInfo.url);
      console.log('  content.buttons: ' + f.contentInfo.totalButtons);
      console.log('  content.accept:  ' + f.contentInfo.acceptButtons.length);
      console.log('  content.markers: ' + JSON.stringify(f.contentInfo));
      if (f.contentInfo.acceptButtons.length > 0) {
        for (const ab of f.contentInfo.acceptButtons) {
          console.log('    >> "' + ab.text + '" cls="' + ab.cls + '" rect=' + JSON.stringify(ab.rect));
        }
      }
    }
  }

  if (data.shadowIframes.length > 0) {
    console.log('\n=== SHADOW DOM IFRAMES ===');
    for (const si of data.shadowIframes) {
      console.log('  host: <' + si.hostTag + ' id="' + si.hostId + '">');
      console.log('  src: ' + si.src);
      console.log('  id:  ' + si.id);
    }
  }

  // 2. Also enable Runtime and check execution contexts
  console.log('\n=== EXECUTION CONTEXTS ===');
  var contexts = [];
  ws.on('message', function(d) {
    var msg = JSON.parse(d.toString());
    if (msg.method === 'Runtime.executionContextCreated') {
      contexts.push(msg.params.context);
    }
  });
  await evalOn(ws, 999, 'null'); // dummy to set up listener
  await sendCDP(ws, 900, 'Runtime.enable', {});
  await new Promise(r => setTimeout(r, 1500));

  console.log('Total contexts: ' + contexts.length);
  for (const ctx of contexts) {
    console.log('  [' + ctx.id + '] name="' + (ctx.name || '') + '" origin="' + (ctx.origin || '') + '" type=' + (ctx.auxData && ctx.auxData.type || 'unknown') + ' isDefault=' + (ctx.auxData && ctx.auxData.isDefault || false));
  }

  ws.close();
}

function sendCDP(ws, id, method, params) {
  return new Promise((res, rej) => {
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) { ws.removeListener('message', handler); res(msg); }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { ws.removeListener('message', handler); rej(new Error('timeout')); }, 5000);
  });
}

function evalOn(ws, id, expr) {
  return new Promise((res, rej) => {
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.removeListener('message', handler);
        if (msg.result && msg.result.result && msg.result.result.value !== undefined)
          res(msg.result.result.value);
        else res(JSON.stringify(msg));
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
    setTimeout(() => { ws.removeListener('message', handler); rej(new Error('timeout')); }, 5000);
  });
}

main().catch(e => { console.error('Fatal:', e.message); });
