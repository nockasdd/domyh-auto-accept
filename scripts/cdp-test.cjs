// Save CDP diagnostic to file — just writes JSON
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

async function main() {
  const resp = await new Promise((res, rej) => {
    http.get('http://127.0.0.1:9000/json', r => {
      let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(JSON.parse(d)));
    }).on('error', rej);
  });

  const target = resp.find(t => t.type==='page' && t.url.includes('workbench') && t.title !== 'Launchpad');
  if (!target) { console.log('No target'); return; }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

  // Get ALL buttons with full context
  const expr = [
    '(function(){',
    '  function dq(root,sel){var r=[];if(!root)return r;try{var f=root.querySelectorAll(sel);for(var i=0;i<f.length;i++)r.push(f[i]);}catch(e){}try{var all=root.querySelectorAll("*");for(var i=0;i<all.length;i++){if(all[i].shadowRoot){var sr=dq(all[i].shadowRoot,sel);for(var j=0;j<sr.length;j++)r.push(sr[j]);}}}catch(e){}return r;}',
    '  var ACCEPT_WORDS=["accept","accept all","accept all files","approve","apply","apply all","confirm","allow","allow once","save all","overwrite","proceed","keep","keep all","yes","ok"];',
    '  var REJECT_WORDS=["skip","reject","cancel","close","dismiss","decline","deny","discard","undo","revert","run","debug","start","stop","restart","terminal","delete","remove","open","copy","edit","thought"];',
    '  function getText(el){var t="";try{t=el.getAttribute("aria-label")||"";}catch(e){}if(!t)try{t=(el.textContent||el.innerText||"").substring(0,60);}catch(e){}if(!t)try{t=el.getAttribute("title")||"";}catch(e){}return t.trim().toLowerCase().replace(/\\s+/g," ");}',
    '  function isAccept(text){if(!text||text.length>60)return false;for(var i=0;i<REJECT_WORDS.length;i++){if(text===REJECT_WORDS[i]||text.indexOf(REJECT_WORDS[i])===0)return false;}for(var i=0;i<ACCEPT_WORDS.length;i++){var w=ACCEPT_WORDS[i];if(text===w)return true;if(text.indexOf(w)===0&&(text.length===w.length||text[w.length]===" "))return true;}return false;}',
    '  var DIFF_SELS=[".chat-editing-session",".chatEditing",".modified-in-chat",".inline-chat-widget",".diff-review-widget"];',
    '  function findDiffCtrs(){var c=[];for(var s=0;s<DIFF_SELS.length;s++){var f=dq(document,DIFF_SELS[s]);for(var k=0;k<f.length;k++)c.push({sel:DIFF_SELS[s],el:f[k]});}return c;}',
    '  function getParentChain(el){var c=[];var p=el;for(var d=0;d<20&&p;d++){var id=p.id||"";var cls=p.className||"";if(typeof cls!=="string")cls="";if(id||cls)c.push({d:d,tag:p.tagName,id:id,cls:cls.substring(0,60)});p=p.parentElement||(p.getRootNode&&p.getRootNode().host)||null;}return c;}',
    '  var btns=dq(document,"button, [role=\\"button\\"], .monaco-button, .bg-ide-button-background, span[class*=\\"bg-ide-button\\"]");',
    '  var items=[];',
    '  for(var i=0;i<btns.length;i++){',
    '    var b=btns[i];',
    '    var text=getText(b);',
    '    var rect=null;try{var r=b.getBoundingClientRect();rect={x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};}catch(e){}',
    '    var parentChain=getParentChain(b);',
    '    var visible=true;try{if(b.offsetParent===null&&b.style&&b.style.position!=="fixed")visible=false;var s=window.getComputedStyle(b);if(s.display==="none"||s.visibility==="hidden"||s.opacity==="0")visible=false;if(rect&&(rect.w===0||rect.h===0))visible=false;}catch(e){}',
    '    items.push({i:i,tag:b.tagName,text:text,accept:isAccept(text),cls:(b.className||"").toString().substring(0,80),id:b.id||"",rect:rect,visible:visible,chain:parentChain});',
    '  }',
    '  var diffCtrs=findDiffCtrs().map(function(c){return{sel:c.sel,tag:c.el.tagName,id:c.el.id||"",cls:(c.el.className||"").toString().substring(0,60)};});',
    '  var isTop=(window===window.top);',
    '  return JSON.stringify({title:document.title,isTop:isTop,totalBtns:btns.length,acceptBtns:items.filter(function(b){return b.accept;}).length,diffContainers:diffCtrs,buttons:items});',
    '})()',
  ].join('\n');

  const result = await new Promise((res, rej) => {
    const id = 99;
    ws.on('message', data => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        if (msg.result && msg.result.result && msg.result.result.value !== undefined)
          res(msg.result.result.value);
        else res(JSON.stringify(msg));
      }
    });
    ws.send(JSON.stringify({id, method:'Runtime.evaluate', params:{expression:expr, returnByValue:true}}));
    setTimeout(() => rej(new Error('timeout')), 8000);
  });

  fs.writeFileSync('scripts/diagnostic-report.json', typeof result === 'string' ? result : JSON.stringify(result), 'utf-8');
  console.log('Written to scripts/diagnostic-report.json');

  // Parse and print summary
  const data = JSON.parse(result);
  console.log('Title:', data.title);
  console.log('isTop:', data.isTop);
  console.log('Total buttons:', data.totalBtns);
  console.log('Accept buttons:', data.acceptBtns);
  console.log('Diff containers:', data.diffContainers.length);

  // Print accept buttons
  const acceptBtns = data.buttons.filter(b => b.accept);
  console.log('\n=== ACCEPT BUTTONS ===');
  for (const b of acceptBtns) {
    console.log('  ['+b.i+'] <'+b.tag+'> text="'+b.text+'" visible='+b.visible+' rect='+(b.rect?'x:'+b.rect.x+' y:'+b.rect.y+' '+b.rect.w+'x'+b.rect.h:'N/A'));
    if (b.chain && b.chain.length > 0) {
      const topParents = b.chain.slice(-3);
      for (const p of topParents) {
        console.log('      ^'+p.d+' <'+p.tag+'> id="'+p.id+'" cls="'+p.cls+'"');
      }
    }
  }

  ws.close();
}

main().catch(e => console.error('Fatal:', e.message));
