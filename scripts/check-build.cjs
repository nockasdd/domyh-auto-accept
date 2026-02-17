// Check if the extension is using the latest engine code
// by examining the compiled output
const fs = require('fs');
const path = require('path');

// Check for compiled output
const possiblePaths = [
  path.join(__dirname, '..', 'out', 'application', 'engine.js'),
  path.join(__dirname, '..', 'dist', 'application', 'engine.js'),
  path.join(__dirname, '..', 'out', 'engine.js'),
  path.join(__dirname, '..', 'dist', 'engine.js'),
  path.join(__dirname, '..', 'out', 'extension.js'),
  path.join(__dirname, '..', 'dist', 'extension.js'),
];

console.log('=== Build Output Check ===\n');

let found = false;
for (const p of possiblePaths) {
  if (fs.existsSync(p)) {
    const stat = fs.statSync(p);
    const content = fs.readFileSync(p, 'utf-8');
    console.log('FOUND: ' + p);
    console.log('  Size: ' + stat.size + ' bytes');
    console.log('  Modified: ' + stat.mtime.toISOString());
    console.log();

    // Check for Round 2 markers
    const hasGracePoll = content.includes('startupGracePollsRemaining');
    const hasAntigravityContextual = content.includes('antigravity.command.');
    const hasChatEditingOnly = content.includes('chatEditingOnly') || content.includes('chatEditing.');
    const hasStartupGrace = content.includes('STARTUP_GRACE_POLLS') || content.includes('Startup grace');

    console.log('  [Round 2 markers]');
    console.log('    startupGracePollsRemaining: ' + (hasGracePoll ? 'YES' : '*** MISSING ***'));
    console.log('    antigravity.command. in contextual: ' + (hasAntigravityContextual ? 'YES' : '*** MISSING ***'));
    console.log('    chatEditingOnly filter: ' + (hasChatEditingOnly ? 'YES' : '*** MISSING ***'));
    console.log('    STARTUP_GRACE_POLLS: ' + (hasStartupGrace ? 'YES' : '*** MISSING ***'));
    console.log();

    found = true;
  }
}

// Also check the dist directory listing
const distDirs = [
  path.join(__dirname, '..', 'out'),
  path.join(__dirname, '..', 'dist'),
];

for (const d of distDirs) {
  if (fs.existsSync(d)) {
    console.log('Directory: ' + d);
    function listRecursive(dir, indent) {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const full = path.join(dir, item);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          console.log(indent + item + '/');
          if (indent.length < 8) listRecursive(full, indent + '  ');
        } else {
          console.log(indent + item + ' (' + stat.size + 'b, ' + stat.mtime.toISOString().substring(0,19) + ')');
        }
      }
    }
    listRecursive(d, '  ');
    console.log();
  }
}

if (!found) {
  console.log('No compiled output found! The extension may need to be rebuilt.');
  console.log('Run: npm run compile  OR  npm run build');
}

// Check package.json for build scripts
const pkgPath = path.join(__dirname, '..', 'package.json');
if (fs.existsSync(pkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  console.log('\n=== Build Scripts ===');
  if (pkg.scripts) {
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      if (name.includes('build') || name.includes('compile') || name.includes('watch') || name.includes('package')) {
        console.log('  ' + name + ': ' + cmd);
      }
    }
  }
  console.log('  main: ' + (pkg.main || 'not set'));
}
