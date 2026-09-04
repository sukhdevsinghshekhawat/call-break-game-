// Validates: net.js parses; game.html inline script parses; every id net.js
// references via $('...') exists in game.html.
const fs = require('fs');
const path = require('path');
let ok = true;

const FRONTEND = path.join(__dirname, '..', 'frontend');

function checkParse(file) {
  try {
    new Function(fs.readFileSync(path.join(FRONTEND, file), 'utf8'));
    console.log(file + ': parse OK');
  } catch (e) {
    ok = false;
    console.log(file + ': PARSE FAIL —', e.message);
  }
}

// 1) all three JS modules parse
['net.js', 'p2p.js', 'roomcore.js'].forEach(checkParse);

// 2) game.html inline script parses + collect ids
const html = fs.readFileSync(path.join(FRONTEND, 'game.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.log('game.html: no inline script found'); ok = false; }
else {
  try {
    new Function(m[1]);
    console.log('game.html inline script: parse OK');
  } catch (e) {
    ok = false;
    console.log('game.html inline script: PARSE FAIL —', e.message);
  }
}

// 3) id cross-check across net.js AND p2p.js
var ids = new Set();
['net.js', 'p2p.js'].forEach(function (file) {
  var src = fs.readFileSync(path.join(FRONTEND, file), 'utf8');
  var re = /\$\('([^']+)'\)/g, hit;
  while ((hit = re.exec(src)) !== null) ids.add(hit[1]);
});
var missing = [];
ids.forEach(function (id) {
  if (!html.includes('id="' + id + '"')) missing.push(id);
});
if (missing.length) {
  ok = false;
  console.log('MISSING IDS in game.html:', missing.join(', '));
} else {
  console.log('id cross-check: all ' + ids.size + ' ids present');
}

// 4) ick scan — backend scripts + frontend modules
var scanFiles = [
  { f: 'server.js', dir: __dirname },
  { f: 'smoke.js', dir: __dirname },
  { f: 'roomcore.test.js', dir: __dirname },
  { f: 'net.js', dir: FRONTEND },
  { f: 'p2p.js', dir: FRONTEND },
  { f: 'roomcore.js', dir: FRONTEND },
];
scanFiles.forEach(function (entry) {
  var src = fs.readFileSync(path.join(entry.dir, entry.f), 'utf8');
  var bad = src.split('\n').filter(function (l, i) {
    return /\bick[0-9]?\b(?![a-z])/.test(l.replace(/trick|pick|click/g, ''));
  });
  if (bad.length) { ok = false; console.log(entry.f, ': suspicious lines:', bad.length); }
  else console.log(entry.f, ': clean');
});

console.log(ok ? 'ALL CHECKS PASSED' : 'CHECKS FAILED');
process.exit(ok ? 0 : 1);