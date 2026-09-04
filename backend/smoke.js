// Headless smoke test for the multiplayer server — boots 4 WS clients and plays a full flow:
// create -> 3 joins -> start -> bidding -> play -> summary -> next -> auto-play on drop.
const assert = require('assert');

function connectAnd(room, session, name, avatar, isResume) {
  return new Promise(function (resolve, reject) {
    var ws = new WebSocket(process.env.WS_URL || 'ws://localhost:3000/ws');
    var client = { seatIdx: -1, session: '', state: null, ws: ws };
    var timer = setTimeout(function () { reject(new Error('join timeout')); }, 8000);
    ws.onopen = function () {
      if (isResume) {
        ws.send(JSON.stringify({ t: 'resume', roomId: room, session: session }));
      } else if (room) {
        ws.send(JSON.stringify({ t: 'join', roomId: room, name: name, avatar: avatar }));
      } else {
        ws.send(JSON.stringify({ t: 'create', name: name, avatar: avatar }));
      }
    };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'joined') {
        client.seatIdx = m.seatIdx;
        client.session = m.session;
        resolve(client);
      } else if (m.t === 'error') {
        clearTimeout(timer);
        reject(new Error(m.msg));
      } else if (m.t === 'state') {
        client.state = m;
      }
    };
    ws.onerror = function () {
      clearTimeout(timer);
      reject(new Error('ws error'));
    };
  });
}

function send(ws, obj) {
  ws.send(JSON.stringify(obj));
}

function legalMoves(hand, trick) {
  if (trick.length === 0) return hand.slice();
  var lead = trick[0].card.suit;
  var follow = hand.filter(function (c) { return c.suit === lead; });
  return follow.length ? follow : hand.slice();
}

function waitFor(condFn, timeoutMs, label) {
  return new Promise(function (resolve, reject) {

    var t0 = Date.now();
    var iv = setInterval(function () {
      var v = false;
      try { v = condFn(); } catch (e) { v = false; }
      if (v) {
        clearInterval(iv);
        resolve(v);
      } else if (Date.now() - t0 > (timeoutMs || 10000)) {
        clearInterval(iv);
        reject(new Error((label || 'condition') + ': timeout'));
      }
    }, 100);
  });
}

(async function () {
  // global watchdog: if the game doesn't finish within 25s, fail loudly.
  var watchdog = setTimeout(function () {
    console.error('— smoke FAILED — global watchdog (25s) hit');
    process.exit(1);
  }, 25000);

  console.log('— smoke: creating host —');
  var c1 = await connectAnd(null, '', 'Host', '🎩', false);
  var roomId = await waitFor(function () { return c1.state ? c1.state.roomId : null; }, 5000, 'roomId');
  console.log('— room created —', roomId, 'host seat:', c1.seatIdx);

  var c2 = await connectAnd(roomId, '', 'A', '🦊', false);
  var c3 = await connectAnd(roomId, '', 'B', '🐼', false);
  var c4 = await connectAnd(roomId, '', 'C', '🐸', false);
  await waitFor(function () { return c1.state && c1.state.canStart === true; }, 8000, '4/4 ready');
  console.log('— 4/4 seated — phase:', c1.state.phase);

  assert.strictEqual(c1.state.phase, 'lobby');
  send(c1.ws, { t: 'start' });
  await waitFor(function () { return c1.state && c1.state.phase === 'bidding'; }, 8000, 'bidding started');
  console.log('— game started — bidding order:', c1.state.biddingOrder);

  var clients = [c1, c2, c3, c4];
  var dealt =0;
  var playCount = 0;
  var t0 = Date.now();
  var lastProgress = Date.now();

  while (dealt < 5) {
    // each connected client plays its role: bid when asked, play when asked.
    var acted = false;
    for (var i =0; i<4; i++) {
      var c = clients[i];
      if (!c.state) continue;
      var s = c.state;
      if (s.phase === 'bidding' && s.awaitingSeat === c.seatIdx && s.bids[c.seatIdx] === null) {
        console.log('  bid from seat', c.seatIdx, 'v=4');
        send(c.ws, { t: 'bid', v: 4 });
        acted = true;
      } else if (s.phase === 'playing' && s.awaitingSeat === c.seatIdx && !s.trickLocked) {
        var moves = legalMoves(s.myHand, s.currentTrick);
        if (moves.length > 0) {
          playCount++;
          if (playCount % 13 === 0) console.log('  [t+' + Math.round(Date.now() - t0) + 'ms] plays=' + playCount + ' dealt=' + dealt);
          send(c.ws, { t: 'play', card: moves[0] });
          acted = true;
        }
      }
    }
    if (c1.state && c1.state.phase === 'summary' && !c1.state.summaryHandled) {

c1.state.summaryHandled = true;
      dealt++;
      if (dealt < 5) {
        if (dealt === 1) {
          console.log('— deal 1 done — dropping one player to test auto-play —');
          c4.ws.close();
        }
        send(c1.ws, { t: 'next' });
      } else {
        console.log('— smoke PASSED — 5 deals complete —');
        process.exit(0);
      }
      acted = true;
    }
    if (!acted) {
      if (Date.now() - lastProgress > 3000) {
        console.log('— STALL DUMP @t+' + Math.round(Date.now() - t0) + ' —');
        clients.forEach(function (c) {
          var s = c.state;
          console.log('  seat', c.seatIdx, s ? ('phase=' + s.phase + ' await=' + s.awaitingSeat + ' bids=' + s.bids + ' trickLen=' + (s.currentTrick ? s.currentTrick.length : '?') + ' lock=' + s.trickLocked + ' deal=' + s.dealNum) : 'nostate');
        });
        lastProgress = Date.now() + 1e9; // dump once per stall
      }
      await new Promise(function (r) { setTimeout(r, 20); });
    } else {
      // yield to the event loop so incoming state broadcasts can update
      // client.state before the next decision.
      lastProgress = Date.now();
      await new Promise(function (r) { setTimeout(r, 20); });
    }
  }
  console.log('— smoke FAILED — loop exited unexpectedly —');
  process.exit(1);
})().catch(function (err) {
  console.error('— smoke FAILED —', err.message || err);
  process.exit(1);
});
