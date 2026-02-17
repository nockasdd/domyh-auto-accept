// Parse diagnostic report and output accept buttons
const data = require('./diagnostic-report.json');
const fs = require('fs');

const accept = data.buttons.filter(b => b.accept);
const output = {
  summary: {
    totalButtons: data.totalBtns,
    acceptButtons: accept.length,
    diffContainers: data.diffContainers.length,
    title: data.title,
    isTop: data.isTop,
  },
  diffContainers: data.diffContainers,
  acceptButtons: accept.map(b => ({
    index: b.i,
    tag: b.tag,
    text: b.text,
    visible: b.visible,
    rect: b.rect,
    cls: b.cls,
    id: b.id,
    parentChain: b.chain,
  })),
};

fs.writeFileSync('accept-analysis.json', JSON.stringify(output, null, 2));
console.log('Total buttons:', data.totalBtns);
console.log('Accept buttons:', accept.length);
console.log('Diff containers:', data.diffContainers.length);
console.log('Written to scripts/accept-analysis.json');
