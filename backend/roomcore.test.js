// Headless test for the shared RoomCore manager — this is EXACTLY the code path
// the offline WebRTC host (frontend/p2p.js) uses: 4 in-memory conns, full game.
// Run: node backend/roomcore.test.js
const assert = require('assert');
const { createRoomManager } = require('../frontend/roomcore.js');

function makeConn(label) {
  const conn = {
    label: label,
    readyState: 'open',
    inbox: [],
    seatIdx: -1,
    session: '',
    state: null,
    send: function (str) {
      const m = JSON.parse(str);
      conn.inbox.push(m);
      if (m.t === 'joined') {
        conn.seatIdx = m.seatIdx;
        conn.session = m.session;
      } else if (m.t === 'state') {
        conn.state = m;
      }
    },
    last: function () { return conn.inbox[conn.inbox.length - 1] || null; },
  };
  return conn;
}

function legalMoves(hand, trick) {
  if (trick.length === 0) return hand.slice();
  const lead = trick[0].card.suit;
  const follow = hand.filter((c) => c.suit === lead);
  return follow.length ? follow : hand.slice();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async function () {
  const mgr = createRoomManager({ autoDelayMs: 10 });

  // ---- create + 3 joins (in-page conns, like the offline host) ----
  const host = makeConn('host');
  mgr.attach(host);
  mgr.parse(host, JSON.stringify({ t: 'create', name: 'Host', avatar: '🎩' }));
  const joined = host.inbox.find((m) => m.t === 'joined');
  assert.ok(joined, 'host got joined');
  assert.strictEqual(joined.seatIdx, 0);
  const roomId = joined.roomId;

  const guests = ['A', 'B', 'C'].map((n) => {
    const c = makeConn(n);
    mgr.attach(c);
    mgr.parse(c, JSON.stringify({ t: 'join', roomId: roomId, name: n, avatar: '🦊' }));
    assert.strictEqual(c.seatIdx > 0, true, n + ' seated');
    return c;
  });

  assert.strictEqual(host.state.canStart, true, '4/4 ready');
  assert.strictEqual(host.state.phase, 'lobby');

  // ---- start → 5 full deals driven by the client conns ----
  mgr.parse(host, JSON.stringify({ t: 'start' }));
  assert.strictEqual(host.state.phase, 'bidding', 'bidding started');

  const leader = host.state.leaderIdx;
  const expectedOrder = [leader, (leader + 1) % 4, (leader + 2) % 4, (leader + 3) % 4];
  assert.deepStrictEqual(host.state.biddingOrder, expectedOrder, 'bidding order should move anti-clockwise');

  const conns = [host].concat(guests);
  let deals = 0;
  let guard = 0;
  while (deals < 5) {
    if (++guard > 20000) throw new Error('runaway loop');
    let acted = false;
    for (const c of conns) {
      const s = c.state;
      if (!s) continue;
      if (s.phase === 'bidding' && s.awaitingSeat === c.seatIdx && s.bids[c.seatIdx] === null) {
        mgr.parse(c, JSON.stringify({ t: 'bid', v: 4 }));
        acted = true;
      } else if (s.phase === 'playing' && s.awaitingSeat === c.seatIdx && !s.trickLocked) {
        const moves = legalMoves(s.myHand, s.currentTrick);
        if (moves.length > 0) {
          mgr.parse(c, JSON.stringify({ t: 'play', card: moves[0] }));
          acted = true;
        }
      }
    }
    if (host.state.phase === 'summary') {
      deals++;
      if (deals < 5) mgr.parse(host, JSON.stringify({ t: 'next' }));
      acted = true;
    }
    if (!acted) await sleep(5);
  }

  const finals = host.state.summaryRows;
  assert.ok(finals && finals.length === 4, 'final summary present');
  assert.strictEqual(host.state.isFinal, true, 'marked final');
  console.log('— roomcore: 5-deal game PASSED — totals:', finals.map((r) => r.total.toFixed(1)).join(' / '));

  // ---- auto-play for a dropped seat (mgr.detach = dc.onclose) ----
  const mgr2 = createRoomManager({ autoDelayMs: 10 });
  const h2 = makeConn('host2');
  mgr2.attach(h2);
  mgr2.parse(h2, JSON.stringify({ t: 'create', name: 'Host', avatar: '🎩' }));
  const room2 = h2.inbox.find((m) => m.t === 'joined').roomId;
  const g2 = ['A', 'B', 'C'].map((n) => {
    const c = makeConn(n);
    mgr2.attach(c);
    mgr2.parse(c, JSON.stringify({ t: 'join', roomId: room2, name: n, avatar: '🦊' }));
    return c;
  });
  mgr2.parse(h2, JSON.stringify({ t: 'start' }));
  // drop guest C right after the deal begins; the host must auto-bid and auto-play for them
  const dropped = g2[2];
  mgr2.detach(dropped);
  await sleep(300);

  let d2guard = 0;
  while (h2.state.phase !== 'summary') {
    if (++d2guard > 5000) throw new Error('auto-play stalled in phase ' + h2.state.phase);
    let acted = false;
    for (const c of [h2].concat(g2.slice(0, 2))) {
      const s = c.state;
      if (!s) continue;
      if (s.phase === 'bidding' && s.awaitingSeat === c.seatIdx && s.bids[c.seatIdx] === null) {
        mgr2.parse(c, JSON.stringify({ t: 'bid', v: 4 }));
        acted = true;
      } else if (s.phase === 'playing' && s.awaitingSeat === c.seatIdx && !s.trickLocked) {
        const moves = legalMoves(s.myHand, s.currentTrick);
        if (moves.length > 0) {
          mgr2.parse(c, JSON.stringify({ t: 'play', card: moves[0] }));
          acted = true;
        }
      }
    }
    if (!acted) await sleep(5);
  }
  const droppedRow = h2.state.summaryRows.find((r) => r.seatIdx === dropped.seatIdx);
  assert.ok(droppedRow, 'dropped seat has a scored row (auto-played)');
  console.log('— roomcore: dropped-seat auto-play PASSED —');

  // ---- reject bogus room code ----
  const stranger = makeConn('stranger');
  mgr.attach(stranger);
  mgr.parse(stranger, JSON.stringify({ t: 'join', roomId: 'ZZZZZZ', name: 'X', avatar: '🦄' }));
  assert.strictEqual(stranger.last().t, 'error', 'bogus room rejected');
  console.log('— roomcore: bad-room rejection PASSED —');

  console.log('ALL ROOMCORE TESTS PASSED');
  process.exit(0);
})().catch(function (err) {
  console.error('ROOMCORE TEST FAILED —', err.message || err);
  process.exit(1);
});
