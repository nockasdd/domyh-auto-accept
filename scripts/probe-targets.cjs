// Probe all CDP targets to find which one has the chat panel / Accept button
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

const PORT = process.argv[2] || '9000';

async function main() {
  // Get all targets
  const resp = await new Promise((res, rej) => {
    http.get('http://127.0.0.1:' + PORT + '/json', r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });

  console.log('Total targets:', resp.length);
  console.log();

  for (let i = 0; i < resp.length; i++) {
    const t = resp[i];
    console.log('─'.repeat(60));
    console.log('[' + i + '] type=' + t.type);
    console.log('    title: ' + (t.title || '(none)'));
    console.log('    url:   ' + (t.url || '(none)').substring(0, 120));
    console.log('    ws:    ' + (t.webSocketDebuggerUrl ? 'available' : 'NONE'));

    if (!t.webSocketDebuggerUrl || t.type === 'worker') {
      console.log('    -> Skipping (no ws or worker)\n');
      continue;
    }

    // Connect and probe
    try {
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.on('open', res);
        ws.on('error', rej);
        setTimeout(() => rej(new Error('ws timeout')), 3000);
      });

      // Simple probe: check for Accept buttons and key DOM markers
      const probe = `
        (function() {
          try {
            var isTop = false;
            try { isTop = (window === window.top); } catch(e) {}

            var allBtns = document.querySelectorAll('button, [role="button"]');
            var acceptBtns = [];
            for (var b = 0; b < allBtns.length; b++) {
              var text = (allBtns[b].getAttribute('aria-label') || allBtns[b].textContent || '').trim().toLowerCase().substring(0, 50);
              if (text.indexOf('accept') !== -1 || text.indexOf('apply') !== -1) {
                var rect = null;
                try { var r = allBtns[b].getBoundingClientRect(); rect = {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; } catch(e) {}
                acceptBtns.push({text: text, tag: allBtns[b].tagName, cls: (allBtns[b].className||'').toString().substring(0,60), rect: rect});
              }
            }

            var hasConversation = !!document.getElementById('conversation');
            var hasNotifyUser = !!document.querySelector('.notify-user-container');
            var hasCascade = !!document.querySelector('[data-tooltip-id="cascade-header-menu"]');

            var iframes = document.querySelectorAll('iframe');

            return JSON.stringify({
              isTop: isTop,
              title: document.title,
              url: location.href.substring(0, 100),
              totalButtons: allBtns.length,
              acceptButtons: acceptBtns,
              chatMarkers: {conversation: hasConversation, notifyUser: hasNotifyUser, cascade: hasCascade},
              iframes: iframes.length,
            });
          } catch(e) { return JSON.stringify({error: e.message}); }
        })()
      `;

      const result = await new Promise((res, rej) => {
        const id = 100 + i;
        const handler = (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.id === id) {
            ws.removeListener('message', handler);
            if (msg.result && msg.result.result && msg.result.result.value)
              res(msg.result.result.value);
            else if (msg.error)
              res(JSON.stringify({error: msg.error.message}));
            else
              res(JSON.stringify({error: 'no value', type: msg.result?.result?.type}));
          }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({id, method: 'Runtime.evaluate', params: {expression: probe, returnByValue: true}}));
        setTimeout(() => { ws.removeListener('message', handler); rej(new Error('eval timeout')); }, 5000);
      });

      const data = JSON.parse(result);
      console.log('    isTop:    ' + data.isTop);
      console.log('    buttons:  ' + data.totalButtons);
      console.log('    accept:   ' + (data.acceptButtons || []).length);
      console.log('    iframes:  ' + data.iframes);
      console.log('    chat markers: ' + JSON.stringify(data.chatMarkers));

      if (data.acceptButtons && data.acceptButtons.length > 0) {
        console.log('    >> ACCEPT BUTTONS FOUND:');
        for (const ab of data.acceptButtons) {
          console.log('       "' + ab.text + '" <' + ab.tag + '> cls="' + ab.cls + '" rect=' + JSON.stringify(ab.rect));
        }
      }

      ws.close();
    } catch (err) {
      console.log('    -> Error: ' + err.message);
    }
    console.log();
  }

  // Also try /json/list endpoint
  try {
    const listResp = await new Promise((res, rej) => {
      http.get('http://127.0.0.1:' + PORT + '/json/list', r => {
        let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
      }).on('error', rej);
    });
    if (listResp.length !== resp.length) {
      console.log('\n/json/list has ' + listResp.length + ' targets (vs /json: ' + resp.length + ')');
      for (const t of listResp) {
        console.log('  type=' + t.type + ' title="' + (t.title||'').substring(0,50) + '" url=' + (t.url||'').substring(0,80));
      }
    }
  } catch(e) {}
}

main().catch(e => { console.error('Fatal:', e.message); });
