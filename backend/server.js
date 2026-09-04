// Call Break — multiplayer server (LAN party via QR code)
// Flow: Host taps "Create Game" -> Room ID + QR join link on the lobby screen.
// Friends scan QR (or open the link) -> pick name + avatar -> seat fills ->
// when 4/4 players are seated the host presses "Start Game" ->
// cards are dealt and every move syncs over WebSocket.
//
// The room + game logic lives in the shared RoomCore module
// (../frontend/roomcore.js) so this server and the offline WebRTC host
// (frontend/p2p.js) run the exact same engine.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { createRoomManager } = require('../frontend/roomcore.js');

const PORT = process.env.PORT || 3000;
const ROOM_TTL_MS = 10 * 60 * 1000; // empty rooms are swept after 10 minutes
// Delay before the server auto-plays for a disconnected seat. Shorter in tests.
const AUTO_DELAY_MS = parseInt(process.env.AUTO_DELAY_MS || '900', 10);

const mgr = createRoomManager({ autoDelayMs: AUTO_DELAY_MS });

// ---------- static file serving ----------
const ROOT = path.join(__dirname, '..', 'frontend');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};
const STATIC_FILES = new Set(['/game.html', '/net.js', '/roomcore.js', '/p2p.js', '/sw.js']);

function staticHandler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let urlPath = url.pathname;
  if (urlPath === '/' || urlPath === '/index.html') urlPath = '/game.html';
  if (!STATIC_FILES.has(urlPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const file = path.join(ROOT, urlPath);
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error');
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

// ---------- QR code proxy ----------
// Renders a QR code image. Uses the free qrserver.com API so the browser
// (especially mobile phones) never needs any external JS library.
function qrProxy(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const text = url.searchParams.get('text') || '';
  if (!text) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('missing text');
    return;
  }
  if (!/^https?:\/\//i.test(text)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('text must be a URL');
    return;
  }
  const api = 'https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=' + encodeURIComponent(text);
  fetch(api)
    .then((r) => {
      if (!r.ok) throw new Error('qr upstream ' + r.status);
      return r.arrayBuffer();
    })
    .then((buf) => {
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': buf.byteLength,
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(Buffer.from(buf));
    })
    .catch(() => {
      // QR API unreachable (no internet) — the client shows a plain join link instead.
      res.writeHead(302, { Location: '/game.html?noframe=1' });
      res.end();
    });
}

// ---------- HTTP + WebSocket plumbing ----------
function httpHandler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/qr') return qrProxy(req, res);
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  staticHandler(req, res);
}

const server = http.createServer(httpHandler);
const wss = new WebSocketServer({ server: server, path: '/ws' });
wss.on('connection', function (ws) {
  mgr.attach(ws);
  ws.on('message', function (raw) {
    mgr.parse(ws, raw.toString());
  });
  ws.on('close', function () {
    mgr.detach(ws);
  });
});
wss.on('error', function () {});

function lanIPHost() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of (ifaces[name] || [])) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return '127.0.0.1';
}

function startTunnel() {
  try {
    const localtunnel = require('localtunnel');
    localtunnel({ port: PORT })
      .then(function (tunnel) {
        console.log('');
        console.log('  🌍 Public (remote):    ' + tunnel.url);
        console.log('  Share this link with friends on different Wi-Fi networks!');
        console.log('  (WebSocket traffic tunnels automatically — scan the QR or paste the link.)');
        tunnel.on('close', function () { console.log('  Tunnel closed.'); });
      })
      .catch(function (err) {
        console.log('');
        console.log('  ⚠️  Tunnel failed: ' + (err && err.message ? err.message : err));
        console.log('  Falling back to local Wi-Fi only. Restart with TUNNEL=false or check your network.');
      });
  } catch (e) {
    console.log('');
    console.log('  ⚠️  localtunnel not installed. Run: npm install');
    console.log('  Falling back to local Wi-Fi only.');
  }
}

server.listen(PORT, function () {
  const host = lanIPHost();
  console.log('');
  console.log('Call Break multiplayer is running');
  console.log('  On this Mac: http://localhost:' + PORT + '/');
  console.log('  For friends (same Wi-Fi): http://' + host + ':' + PORT + '/');
  console.log('Create a game, then friends scan the QR code shown in the lobby to join.');
  if (process.env.TUNNEL === 'true') {
    startTunnel();
  } else {
    console.log('');
    console.log('  💡 Tip: Run with TUNNEL=true to play across different networks!');
    console.log('     e.g. TUNNEL=true npm start  OR  npm run start:public');
  }
});

// Sweep rooms with nobody connected for the TTL.
setInterval(function () {
  const now = Date.now();
  for (const [id, room] of mgr.rooms) {
    const anyConnected = room.players.some(function (p) { return p.connected; });
    if (!anyConnected && now - room.lastActive > ROOM_TTL_MS) {

      mgr.rooms.delete(id);
    }
  }
}, 60 * 1000);

