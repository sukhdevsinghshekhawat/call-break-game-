// RoomCore — shared Call Break room + game engine (single source of truth).
// Used by two transports:
//   - backend/server.js  → Node + WebSocket (LAN / deployed mode)
//   - frontend/p2p.js    → browser + WebRTC DataChannels (offline mode, no server)
// UMD wrapper: works with require() and as the window.RoomCore global.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoomCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- game core (ported from the hotseat build) ----------
  const SUITS = ['S', 'H', 'D', 'C'];
  const SEAT_NAMES = ['South', 'West', 'North', 'East'];


  // Simple human-ish bid estimate for a seat that temporarily drops off.
  function estimateAIBid(hand) {
    let score = 0;
    const bySuit = { S: [], H: [], D: [], C: [] };
    hand.forEach((c) => bySuit[c.suit].push(c));
    const spades = bySuit.S.slice().sort((a, b) => b.rank - a.rank);
    spades.forEach((c) => {
      if (c.rank === 14) score += 1.0;
      else if (c.rank === 13) score += 0.85;
      else if (c.rank === 12) score += 0.6;
      else if (c.rank === 11) score += 0.35;
    });
    if (spades.length > 5) score += (spades.length - 5) * 0.75;
    else if (spades.length === 0) score -= 0.3;
    ['H', 'D', 'C'].forEach((s) => {
      const cards = bySuit[s];
      if (cards.length === 0) {
        score += 0.5;
        return;
      }
      cards.forEach((c) => {
        if (c.rank === 14) score += 0.85;
        else if (c.rank === 13 && cards.length <= 4) score += 0.45;
        else if (c.rank === 12 && cards.length <= 3) score += 0.2;
      });
    });
    let bid = Math.round(score);
    if (bid < 1) bid = 1;
    if (bid > 13) bid = 13;
    return bid;
  }

  function findTwoOfClubsHolder(game) {
    for (let i = 0; i < 4; i++) {
      if (game.hands[i].some((c) => c.suit === 'C' && c.rank === 2)) return i;
    }
    return 0;
  }

  function legalMoves(game, pIdx) {
    const hand = game.hands[pIdx];
    if (game.currentTrick.length === 0) return hand.slice();
    const leadSuit = game.currentTrick[0].card.suit;
    const follow = hand.filter((c) => c.suit === leadSuit);
    return follow.length > 0 ? follow : hand.slice();
  }

  function trickWinner(game) {
    const leadSuit = game.currentTrick[0].card.suit;
    const spadesPlayed = game.currentTrick.filter((t) => t.card.suit === 'S');
    const pool = spadesPlayed.length > 0
      ? spadesPlayed
      : game.currentTrick.filter((t) => t.card.suit === leadSuit);
    let best = pool[0];
    pool.forEach((t) => {
      if (t.card.rank > best.card.rank) best = t;
    });
    return best.seatIdx;
  }

  // Fallback auto-play brain for a seat whose player temporarily dropped off.
  function aiChooseCard(pIdx, moves, game) {
    const playerHand = game.hands[pIdx];
    const needsTricks = game.tricksWon[pIdx] < game.bids[pIdx];
    const inTrick = game.currentTrick.length;

    if (inTrick === 0) {
      // leading — prefer aces, otherwise lowest from the longest non-spade suit.
      const nonSpade = moves.filter((c) => c.suit !== 'S');
      const aces = nonSpade.filter((c) => c.rank === 14);
      if (aces.length > 0) return aces[0];
      if (nonSpade.length > 0) {
        const bySuit = {};
        nonSpade.forEach((c) => {
          if (!bySuit[c.suit]) bySuit[c.suit] = [];
          bySuit[c.suit].push(c);
        });
        let bestSuit = null;
        let bestLen = -1;
        Object.keys(bySuit).forEach((s) => {
          if (bySuit[s].length > bestLen) {
            bestLen = bySuit[s].length;
            bestSuit = s;
          }
        });
        const arr = bySuit[bestSuit].slice().sort((a, b) => a.rank - b.rank);
        return arr[0];
      }
      const spades = moves.slice().sort((a, b) => a.rank - b.rank);
      return spades[0];
    }

    const leadSuit = game.currentTrick[0].card.suit;
    const spadesPlayed = game.currentTrick.some((t) => t.card.suit === 'S');
    let winningCards = [];
    if (moves[0] && moves[0].suit === leadSuit) {

      if (leadSuit === 'S') {
        const highest = Math.max(...game.currentTrick.filter((t) => t.card.suit === 'S').map((t) => t.card.rank));
        winningCards = moves.filter((c) => c.rank > highest);
      } else if (!spadesPlayed) {
        const highest = Math.max(...game.currentTrick.map((t) => t.card.rank));
        winningCards = moves.filter((c) => c.rank > highest);
      }
      const sorted = moves.slice().sort((a, b) => a.rank - b.rank);
      if (winningCards.length > 0 && needsTricks) return winningCards.sort((a, b) => a.rank - b.rank)[0];
      return sorted[0];
    }

    const spadesInHand = moves.filter((c) => c.suit === 'S');
    const nonSpadeInHand = moves.filter((c) => c.suit !== 'S');
    if (spadesInHand.length > 0) {
      const spadesPlayedInTrick = game.currentTrick.filter((t) => t.card.suit === 'S');
      if (spadesPlayedInTrick.length === 0) {
        if (needsTricks) return spadesInHand.slice().sort((a, b) => a.rank - b.rank)[0];
        if (nonSpadeInHand.length > 0) return nonSpadeInHand.slice().sort((a, b) => a.rank - b.rank)[0];
        return spadesInHand.slice().sort((a, b) => a.rank - b.rank)[0];
      }
      const highest = Math.max(...spadesPlayedInTrick.map((t) => t.card.rank));
      const winning = spadesInHand.filter((c) => c.rank > highest);
      if (winning.length > 0 && needsTricks) return winning.sort((a, b) => a.rank - b.rank)[0];
      if (nonSpadeInHand.length > 0) return nonSpadeInHand.slice().sort((a, b) => a.rank - b.rank)[0];
      return spadesInHand.slice().sort((a, b) => a.rank - b.rank)[0];
    }
    return nonSpadeInHand.slice().sort((a, b) => a.rank - b.rank)[0];
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  function sortHand(hand) {
    const order = { S: 0, H: 1, D: 2, C: 3 };
    return hand.slice().sort((a, b) => {
      if (order[a.suit] !== order[b.suit]) return order[a.suit] - order[b.suit];
      return b.rank - a.rank;
    });
  }

  function makeDeck() {
    const deck = [];
    for (const s of SUITS) {
      for (let r = 2; r <= 14; r++) deck.push({ suit: s, rank: r });
    }
    return deck;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  function sortHand(hand) {
    const order = { S: 0, H: 1, D: 2, C: 3 };
    return hand.slice().sort((a, b) => {
      if (order[a.suit] !== order[b.suit]) return order[a.suit] - order[b.suit];
      return b.rank - a.rank;
    });
  }

  function dealCards(game) {
    const deck = shuffle(makeDeck());
    game.hands = [[], [], [], []];
    for (let i = 0; i < 52; i++) game.hands[i % 4].push(deck[i]);
    game.hands = game.hands.map(sortHand);
  }


  // ---------- room model ----------
  function newGame() {
    return {
      phase: 'lobby',
      dealNum: 1,
      totalDeals: 5,
      hands: [[], [], [], []],
      bids: [null, null, null, null],
      tricksWon: [0, 0, 0, 0],
      totalScores: [0, 0, 0, 0],
      leaderIdx: 0,
      biddingOrder: [],
      biddingPos: 0,
      currentTrick: [],
      awaitingSeat: null,
      trickLocked: false,
      summaryRows: null,
      isFinal: false,
    };
  }

  function newRoom(roomId) {
    return {
      id: roomId,
      hostSeat: 0,
      players: [
        { seatIdx: 0, name: null, avatar: null, connected: false, session: null },
        { seatIdx: 1, name: null, avatar: null, connected: false, session: null },
        { seatIdx: 2, name: null, avatar: null, connected: false, session: null },
        { seatIdx: 3, name: null, avatar: null, connected: false, session: null },
      ],
      seatsBySession: new Map(),
      game: newGame(),
      started: false,
      lastActive: Date.now(),
    };
  }

  function makeSessionId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 24; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
  }

  function makeRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id = '';
    for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
  }

  function normalizeRoomId(raw) {
    return String(raw || '').trim().toUpperCase();
  }

  // ---------- room manager (transport-agnostic) ----------
  // A "conn" is any object with: readyState (1 or 'open'), send(str), and an
  // optional close event the owner reports via manager.detach(conn).
  function createRoomManager(opts) {
    opts = opts || {};
    const AUTO_DELAY_MS = opts.autoDelayMs != null ? opts.autoDelayMs : 900;
    const rooms = new Map();
    const conns = new Map(); // conn -> { room, session, seatIdx }

    function isOpen(conn) {
      return conn && (conn.readyState === 1 || conn.readyState === 'open');
    }

    function roomPublic(room, seatIdx) {
      return {
        t: 'state',
        roomId: room.id,
        you: seatIdx,
        hostSeat: room.hostSeat,
        phase: room.game.phase,
        dealNum: room.game.dealNum,
        totalDeals: room.game.totalDeals,
        started: room.started,
        canStart: !room.started && room.players.every((p) => p.name && p.connected),
        players: room.players.map((p) => ({
          seatIdx: p.seatIdx,
          name: p.name,
          avatar: p.avatar || '',
          connected: p.connected,
        })),
        bids: room.game.bids,
        tricksWon: room.game.tricksWon,
        totalScores: room.game.totalScores,
        handCounts: room.game.hands.map(function (h) { return h.length; }),
        leaderIdx: room.game.leaderIdx,
        biddingOrder: room.game.biddingOrder,
        biddingPos: room.game.biddingPos,
        currentTrick: room.game.currentTrick,
        awaitingSeat: room.game.awaitingSeat,
        trickLocked: room.game.trickLocked,
        summaryRows: room.game.summaryRows,
        isFinal: room.game.isFinal,
      };
    }

    function snapshotFor(conn) {
      const info = conns.get(conn);
      const room = info.room;
      const pub = roomPublic(room, info.seatIdx);
      pub.myHand = room.game.phase === 'lobby' ? [] : (room.game.hands[info.seatIdx] || []);
      return JSON.stringify(pub);
    }

    function broadcast(room) {
      room.lastActive = Date.now();
      for (const [conn, info] of conns) {
        if (info.room !== room) continue;
        if (isOpen(conn)) conn.send(snapshotFor(conn));
      }
    }

    function sendTo(conn, obj) {
      if (isOpen(conn)) conn.send(JSON.stringify(obj));
    }

    function sendError(conn, msg) {
      if (isOpen(conn)) conn.send(JSON.stringify({ t: 'error', msg }));
    }

    function occupiedCount(room) {
      return room.players.filter((p) => p.name).length;
    }

    function isFull(room) {
      return occupiedCount(room) >= 4;
    }

    // ---------- game flow ----------
    function beginDeal(room) {
      const g = room.game;
      dealCards(g);
      g.bids = [null, null, null, null];
      g.tricksWon = [0, 0, 0, 0];
      g.leaderIdx = findTwoOfClubsHolder(g);
      g.biddingOrder = [];
      for (let i = 0; i < 4; i++) {
        g.biddingOrder.push((g.leaderIdx + 4 - i) % 4);
      }
      g.biddingPos = 0;
      g.currentTrick = [];
      g.trickLocked = false;
      g.phase = 'bidding';
      g.awaitingSeat = g.biddingOrder[0];
    }

    function afterAdvanceBid(room) {
      const g = room.game;
      if (g.biddingPos >= g.biddingOrder.length) {

        g.phase = 'playing';
        g.currentTrick = [];
        g.trickLocked = false;
        g.leaderIdx = g.biddingOrder[0];
        g.awaitingSeat = g.leaderIdx;
        broadcast(room);
        maybeAutoAct(room);
        return;
      }
      g.awaitingSeat = g.biddingOrder[g.biddingPos];
      broadcast(room);
      maybeAutoAct(room);
    }

    function applyPlay(room, seat, card) {
      const g = room.game;
      const hand = g.hands[seat];
      const idx = hand.findIndex((c) => c.suit === card.suit && c.rank === card.rank);
      if (idx === -1) return;
      hand.splice(idx, 1);
      g.currentTrick.push({ seatIdx: seat, card: { suit: card.suit, rank: card.rank } });
      if (g.currentTrick.length < 4) {
        g.awaitingSeat = (seat + 3) % 4;
        g.trickLocked = false;
      } else {
        g.trickLocked = true;
        g.awaitingSeat = null;
        const winner = trickWinner(g);
        g.tricksWon[winner]++;
        g.currentTrick = [];
        if (g.hands.every((h) => h.length === 0)) {
          finishDeal(room);
          return;
        }
        g.leaderIdx = winner;
        g.awaitingSeat = winner;
        g.trickLocked = false;
      }
    }

    function finishDeal(room) {
      const g = room.game;

      const rows = [0, 1, 2, 3].map(seatIdx => {
        let roundScore;
        if (g.tricksWon[seatIdx] >= g.bids[seatIdx]) {

          roundScore = g.bids[seatIdx] + (g.tricksWon[seatIdx] - g.bids[seatIdx]) * 0.1;
        } else {
          roundScore = -g.bids[seatIdx];
        }
        g.totalScores[seatIdx] += roundScore;
        return { seatIdx: seatIdx, bid: g.bids[seatIdx], won: g.tricksWon[seatIdx], roundScore: roundScore, total: g.totalScores[seatIdx] };
      });
      rows.sort((a, b) => b.total - a.total);
      g.summaryRows = rows;
      g.isFinal = g.dealNum >= g.totalDeals;

      g.phase = 'summary';
      g.awaitingSeat = null;

      broadcast(room);
    }

    function nextDeal(room) {
      const g = room.game;

      if (g.isFinal) {
        g.dealNum = 1;
        g.totalScores = [0, 0, 0, 0];
      } else {
        g.dealNum++;
      }
      g.leaderIdx = findTwoOfClubsHolder(g);
      dealCards(g);
      g.bids = [null, null, null, null];
      g.tricksWon = [0, 0, 0, 0];
      g.summaryRows = null;
      g.isFinal = false;
      g.biddingOrder = [];
      for (let i = 0; i < 4; i++) {
        g.biddingOrder.push((g.leaderIdx + i) % 4);
      }
      g.biddingPos = 0;
      g.currentTrick = [];
      g.trickLocked = false;
      g.phase = 'bidding';
      g.awaitingSeat = g.biddingOrder[0];
      broadcast(room);
      maybeAutoAct(room);
    }

    // If the seat whose turn it is has dropped off, the host autoplays for them
    // (same brain as the original hotseat build) after a short delay.
    function maybeAutoAct(room) {
      const g = room.game;

      if (g.phase !== 'bidding' && g.phase !== 'playing') return;
      const seat = g.awaitingSeat;

      if (seat === null) return;
      if (room.players[seat].connected) return;
      setTimeout(() => {
        const g2 = room.game;
        if (g2.awaitingSeat !== seat) return;
        if (room.players[seat].connected) return;
        if (g2.phase === 'bidding') {
          const bid = estimateAIBid(g2.hands[seat]);
          g2.bids[seat] = bid;
          g2.biddingPos++;
          g2.awaitingSeat = null;
          afterAdvanceBid(room);
          broadcast(room);
        } else if (g2.phase === 'playing') {
          if (g2.currentTrick.length >= 4) return;
          const moves = legalMoves(g2, seat);
          const card = aiChooseCard(seat, moves, g2);
          applyPlay(room, seat, card);
          broadcast(room);
          // the auto-played card may have won the trick, putting this seat on lead
          // again — keep the chain going while the awaiting seat is disconnected.
          maybeAutoAct(room);
        }
      }, AUTO_DELAY_MS);
    }

    function firstFreeSeat(room) {
      for (let i = 0; i < 4; i++) {
        if (!room.players[i].name) return i;
      }
      return -1;
    }

    // ---------- connection lifecycle ----------
    function attach(conn) {
      conns.set(conn, { room: null, session: null, seatIdx: -1 });
    }

    function detach(conn) {
      const info = conns.get(conn);
      if (info && info.room && info.seatIdx >= 0) {
        const room = info.room;
        const p = room.players[info.seatIdx];
        if (!room.started) {
          room.players[info.seatIdx].name = null;
          room.players[info.seatIdx].avatar = null;
          room.players[info.seatIdx].session = null;
          room.seatsBySession.delete(info.session);
        }
        p.connected = false;
        if (room.game.phase === 'bidding' || room.game.phase === 'playing') {
          maybeAutoAct(room);
        }
        broadcast(room);
      }
      conns.delete(conn);
    }

    // Incoming client message (already-parsed object). Mirrors the WS handler.
    function message(conn, msg) {
      const info = conns.get(conn);
      if (!info || typeof msg !== 'object' || msg === null) return;

      const t = msg.t || '';
      if (t === 'create' && !info.room) {

        const name = String(msg.name || '').trim().slice(0, 20);
        const avatar = String(msg.avatar || '🎩').slice(0, 4);
        if (!name) {
          sendError(conn, 'Enter your name first.');
          return;
        }
        const roomId = makeRoomId();
        const room = newRoom(roomId);
        const session = makeSessionId();
        room.players[0].name = name;
        room.players[0].avatar = avatar;
        room.players[0].connected = true;
        room.players[0].session = session;
        room.seatsBySession.set(session, 0);
        rooms.set(roomId, room);
        info.room = room;
        info.session = session;
        info.seatIdx = 0;
        sendTo(conn, { t: 'joined', roomId: roomId, seatIdx: 0, hostSeat: 0, session: session, isHost: true });
        broadcast(room);
        return;
      }

      if (t === 'join' && !info.room) {
        const roomId = normalizeRoomId(msg.roomId);
        const room = rooms.get(roomId);
        if (!room) {
          sendError(conn, 'Room not found. Check the code and try again.');
          return;
        }
        if (room.started) {
          sendError(conn, 'Game already started. Ask the host to start a fresh room.');
          return;
        }
        const name = String(msg.name || '').trim().slice(0, 20);
        const avatar = String(msg.avatar || '🎩').slice(0, 4);
        if (!name) {
          sendError(conn, 'Enter your name first.');
          return;
        }
        const seatIdx = firstFreeSeat(room);
        if (seatIdx === -1) {
          sendError(conn, 'Room is full (4/4).');
          return;
        }
        const session = makeSessionId();
        room.players[seatIdx].name = name;
        room.players[seatIdx].avatar = avatar;
        room.players[seatIdx].connected = true;
        room.players[seatIdx].session = session;
        room.seatsBySession.set(session, seatIdx);
        info.room = room;
        info.session = session;
        info.seatIdx = seatIdx;
        sendTo(conn, { t: 'joined', roomId: roomId, seatIdx: seatIdx, hostSeat: room.hostSeat, session: session, isHost: false });
        broadcast(room);
        return;
      }

      if (t === 'resume' && !info.room) {
        const roomId = normalizeRoomId(msg.roomId);
        const session = String(msg.session || '');
        const room = rooms.get(roomId);
        if (!room || !session) {
          sendError(conn, 'Session expired — join again on a fresh link.');
          return;
        }
        const seatIdx = room.seatsBySession.get(session);
        if (seatIdx === undefined || seatIdx === -1) {
          sendError(conn, 'Session expired — join again on a fresh link.');
          return;
        }
        room.players[seatIdx].connected = true;
        info.room = room;
        info.session = session;
        info.seatIdx = seatIdx;
        sendTo(conn, { t: 'joined', roomId: roomId, seatIdx: seatIdx, hostSeat: room.hostSeat, session: session, isHost: seatIdx === room.hostSeat });
        broadcast(room);
        if (room.game.phase === 'bidding' || room.game.phase === 'playing') maybeAutoAct(room);
        return;
      }

      if (t === 'start') {
        const room = info.room;
        if (!room || info.seatIdx !== room.hostSeat) return;
        if (room.started) return;
        if (!room.players.every(function (p) { return p.name && p.connected; })) {
          sendError(conn, 'Waiting for 4/4 players to sit down.');
          return;
        }
        room.started = true;
        beginDeal(room);
        broadcast(room);
        maybeAutoAct(room);
        return;
      }

      if (t === 'bid') {
        const room = info.room;
        if (!room || room.game.phase !== 'bidding') return;
        if (info.seatIdx !== room.game.awaitingSeat) return;
        if (room.game.bids[info.seatIdx] !== null) return;
        const rawV = Number(msg.v);
        const v = Math.floor(rawV);
        if (!(v >= 1 && v <= 13)) return;
        room.game.bids[info.seatIdx] = v;
        room.game.biddingPos++;
        room.game.awaitingSeat = null;
        broadcast(room);
        afterAdvanceBid(room);
        return;
      }

      if (t === 'play') {
        const room = info.room;
        if (!room || room.game.phase !== 'playing') return;
        if (info.seatIdx !== room.game.awaitingSeat) return;
        if (room.game.trickLocked) return;
        const card = msg.card;
        if (!card || typeof card.suit !== 'string' || typeof card.rank !== 'number') return;
        const moves = legalMoves(room.game, info.seatIdx);
        const ok = moves.some(function (c) { return c.suit === card.suit && c.rank === card.rank; });
        if (!ok) return;
        applyPlay(room, info.seatIdx, card);
        broadcast(room);
        maybeAutoAct(room);
        return;
      }

      if (t === 'next') {
        const room = info.room;
        if (!room || room.game.phase !== 'summary') return;
        if (info.seatIdx !== room.hostSeat) return;
        nextDeal(room);
        return;
      }
    }

    // Incoming raw string (convenience wrapper).
    function parse(conn, raw) {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        return;
      }
      message(conn, msg);
    }

    return {
      attach: attach,
      detach: detach,
      message: message,
      parse: parse,
      rooms: rooms,
    };
  }

  return {
    createRoomManager: createRoomManager,
    makeRoomId: makeRoomId,
    estimateAIBid: estimateAIBid,
    legalMoves: legalMoves,
  };
});
