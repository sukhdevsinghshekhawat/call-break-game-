// Client networking layer for Call Break multiplayer.
// Handles: home / join / lobby screens, WebSocket sync, and rendering the
// shared table from the server's authoritative snapshots.
(function () {
  'use strict';

  // ---------- constants ----------
  var SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
  var SUIT_COLOR = { S: 'black', H: 'red', D: 'red', C: 'black' };
  var RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  // displayPos 0=south(bottom, me) 1=west(left) 2=north(top) 3=east(right)
  var AVATARS = ['🎩', '🦊', '🐼', '🦁', '🐸', '🦄', '🐧', '🦉', '🐯', '🦋', '🐨', '🐺'];

  // ---------- client state ----------
  var you = -1;            // my seatIdx
  var hostSeat = -1;
  var roomId = null;
  var mySession = '';
  var state = null;        // latest snapshot from the server
  var socket = null;
  var reconnectTimer = null;
  var intentionallyClosed = false;
  var onlineTableLive = false; // true while an online game is on screen
  var p2pActive = false;       // true in offline WebRTC mode (transport = DataChannel)

  function $(id) { return document.getElementById(id); }

  // ---------- storage ----------
  function loadName() { try { return localStorage.getItem('cbName') || ''; } catch (e) { return ''; } }
  function saveName(n) { try { localStorage.setItem('cbName', n); } catch (e) {} }
  function loadAvatar() { try { return localStorage.getItem('cbAvatar') || ''; } catch (e) { return ''; } }
  function saveAvatar(a) { try { localStorage.setItem('cbAvatar', a); } catch (e) {} }
  function loadSession() {
    try { return JSON.parse(localStorage.getItem('cbSession') || 'null'); } catch (e) { return null; }
  }
  function saveSession(s) {
    try {
      if (s) localStorage.setItem('cbSession', JSON.stringify(s));
      else localStorage.removeItem('cbSession');
    } catch (e) {}
  }

  // ---------- tiny helpers ----------
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function rankLabel(r) { return RANK_LABEL[r] || String(r); }
  function showToast(msg) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () { el.classList.add('hidden'); }, 3200);
  }
  function showScreen(name) {
    var ids = { home: 'screenHome', join: 'screenJoin', lobby: 'screenLobby', table: 'screenTable', p2p: 'screenP2P' };
    Object.keys(ids).forEach(function (k) {
      var el = $(ids[k]);
      if (el) el.classList.toggle('active', k === name);
    });
    document.body.classList.remove('mode-home', 'mode-join', 'mode-lobby', 'mode-table');
    document.body.classList.add('mode-' + name);
  }

  // ---------- avatar picker ----------
  function buildAvatarPicker(containerId, initial) {
    var picked = initial || AVATARS[0];
    var box = $(containerId);
    box.innerHTML = '';
    AVATARS.forEach(function (av) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'avatar-btn' + (av === picked ? ' sel' : '');
      b.textContent = av;
      b.addEventListener('click', function () {
        picked = av;
        var all = box.querySelectorAll('.avatar-btn');
        for (var j = 0; j < all.length; j++) all[j].classList.remove('sel');
        b.classList.add('sel');
      });
      box.appendChild(b);
    });
    return { get: function () { return picked; } };
  }

  // ---------- connection ----------
  var pendingMode = 'create'; // 'create' | 'join' | 'resume'
  function wsUrl() {
    // If backend is hosted separately (e.g., Netlify frontend + Render backend),
    // set window.__WS_URL__ in game.html to the public WS endpoint.
    if (typeof window !== 'undefined' && window.__WS_URL__) return window.__WS_URL__;
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    return proto + location.host + '/ws';
  }
  function send(obj) {
    if (p2pActive && window.__cbP2P) { window.__cbP2P.clientSend(obj); return; }
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(obj));
  }
  function clearReconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }
  function scheduleReconnect() {
    clearReconnect();
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect('resume');
    }, 1500);
  }
  function connect(mode) {
    pendingMode = mode;
    clearReconnect();
    try {
      socket = new WebSocket(wsUrl());
    } catch (e) {
      showToast('Could not connect to the game server.');
      return;
    }
    socket.onopen = function () {
      if (pendingMode === 'resume') {
        send({ t: 'resume', roomId: roomId, session: mySession });
      } else if (pendingMode === 'join') {
        send({ t: 'join', roomId: roomId, name: loadName() || 'Player', avatar: loadAvatar() || AVATARS[0] });
      } else {
        send({ t: 'create', name: loadName() || 'Host', avatar: loadAvatar() || AVATARS[0] });
      }
    };
    socket.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      handleServerMessage(m);
    };
    socket.onclose = function () {
      socket = null;
      if (intentionallyClosed) return;
      if (roomId && mySession) {
        showToast('Connection lost — reconnecting…');
        scheduleReconnect();
      }
    };
  }

  // ---------- message handling (transport-agnostic) ----------
  // Delivers a server message (parsed object). Used by both WS and P2P paths.
  function handleServerMessage(m) {
    if (m.t === 'joined') {
      you = m.seatIdx;
      hostSeat = m.hostSeat;
      roomId = m.roomId;
      mySession = m.session;
      saveSession({ roomId: roomId, session: mySession, seatIdx: you });
    } else if (m.t === 'state') {
      state = m;
      applyState(m);
    } else if (m.t === 'error') {
      showToast(m.msg || 'Something went wrong.');
      if (/expired|not found|full|already started/i.test(m.msg || '')) {
        // dead session — stop reconnecting, go home
        intentionallyClosed = true;
        clearReconnect();
        if (socket) { try { socket.close(); } catch (e) {} socket = null; }
        saveSession(null);
        mySession = '';
        showScreen('home');
        renderHome();
      }
    }
  }

  // ---------- state routing ----------

  function leaveRoom() {
    if (p2pActive && window.__cbP2P) { window.__cbP2P.teardownAll(); }
    p2pActive = false;
    intentionallyClosed = true;
    clearReconnect();
    if (socket) { try { socket.close(); } catch (e) {} socket = null; }
    you = -1; hostSeat = -1; roomId = null; mySession = ''; state = null;
    saveSession(null);
    onlineTableLive = false;
    document.body.classList.remove('online');
    $('bidOverlay').classList.add('hidden');
    $('roundOverlay').classList.add('hidden');
    showScreen('home');
    renderHome();
  }

  // ---------- state routing ----------
  function applyState(s) {
    state = s;
    if (s.phase === 'lobby') {
      onlineTableLive = false;
      document.body.classList.remove('online');
      renderLobby();
      showScreen('lobby');
    } else {
      onlineTableLive = true;
      document.body.classList.add('online');
      showScreen('table');
      renderTable();
    }
  }

  // ---------- lobby ----------
  function joinUrlFor(code) {
    return location.origin + '/?join=' + encodeURIComponent(code);
  }
  function renderLobby() {
    $('lobbyRoomCode').textContent = state.roomId;
    var grid = $('lobbySeats');
    grid.innerHTML = '';
    for (var i = 0; i < 4; i++) {
      var p = state.players[i];
      var d = document.createElement('div');
      d.className = 'lobby-seat' + (i === you ? ' me' : '');
      var inner = '';
      if (p.name) {
        inner += '<div class="lobby-avatar">' + escapeHtml(p.avatar || '🎩') + '</div>';
        inner += '<div class="lobby-name">' + escapeHtml(p.name) + '</div>';
        if (i === state.hostSeat) inner += '<div class="lobby-tag">HOST</div>';
        if (!p.connected) inner += '<div class="lobby-tag off">reconnecting…</div>';
      } else {
        inner += '<div class="lobby-avatar empty">＋</div>';
        inner += '<div class="lobby-name empty">Waiting…</div>';
      }
      d.innerHTML = inner;
      grid.appendChild(d);
    }

    // Offline (P2P) mode hides the QR box and shows the "Add Player" panel.
    var offline = p2pActive && window.__cbP2P && window.__cbP2P.isActive();
    $('qrBox').classList.toggle('hidden', offline);
    $('p2pLobbyPanel').classList.toggle('hidden', !offline);
    if (offline) {
      if (window.__cbP2P) window.__cbP2P.renderLobbyPanel();
    } else {
      var url = joinUrlFor(state.roomId);
      var img = $('qrImg');
      img.src = '/qr?text=' + encodeURIComponent(url);
      img.classList.remove('hidden');
      $('joinUrl').textContent = url;
    }

    var seated = state.players.filter(function (p) { return p.name; }).length;
    var connected = state.players.filter(function (p) { return p.name && p.connected; }).length;
    var startBtn = $('btnStart');
    var amHost = you === state.hostSeat;
    startBtn.disabled = !(amHost && state.canStart);
    if (amHost) {
      startBtn.textContent = state.canStart ? 'Start Game' : 'Waiting for players (' + connected + '/4)…';
      $('lobbyStatus').textContent = seated < 4
        ? 'Share the QR code — friends scan it and join instantly.'
        : 'Everyone is in. Deal the cards!';
    } else {
      startBtn.textContent = 'Waiting for host…';
      $('lobbyStatus').textContent = 'You are seated. Waiting for the host to start.';
    }
  }

  // ---------- table rendering ----------
  function displayPos(seatIdx) { return (seatIdx - you + 4) % 4; } // 0 bottom … 3 right
  function posSeat(pos) { return (pos + you) % 4; }
  function nameOf(seatIdx) {
    var p = state.players[seatIdx];
    return (p && p.name) ? p.name : 'Player ' + (seatIdx + 1);
  }
  function cardEl(card, extra) {
    var d = document.createElement('div');
    d.className = 'card ' + SUIT_COLOR[card.suit] + (extra ? ' ' + extra : '');
    var lab = rankLabel(card.rank);
    var sym = SUIT_SYMBOL[card.suit];
    d.innerHTML = '<div class="bl">' + lab + '<br>' + sym + '</div>' +
      '<div class="suit-mid">' + sym + '</div>' +
      '<div class="tr">' + lab + '<br>' + sym + '</div>';
    return d;
  }
  function legalMovesFor(hand) {
    if (!state.currentTrick || state.currentTrick.length === 0) return hand.slice();
    var lead = state.currentTrick[0].card.suit;
    var follow = hand.filter(function (c) { return c.suit === lead; });
    return follow.length > 0 ? follow : hand.slice();
  }
  function isMyTurn() {
    return state.phase === 'playing' && state.awaitingSeat === you && !state.trickLocked;
  }

  function renderTable() {
    $('roundPill').textContent = 'Deal ' + state.dealNum + ' / ' + state.totalDeals;
    renderScoreboard();
    renderLabels();
    renderBacks();
    renderMyHand();
    renderTrick();
    renderStatus();
    renderBidOverlay();
    renderSummary();
    $('newGameBtn').classList.add('hidden');
    $('btnLeave').classList.remove('hidden');
  }

  function renderTable() {
    $('roundPill').textContent = 'Deal ' + state.dealNum + ' / ' + state.totalDeals;
    renderScoreboard();
    renderLabels();
    renderBacks();
    renderMyHand();
    renderTrick();
    renderStatus();
    renderBidOverlay();
    renderSummary();
    $('newGameBtn').classList.add('hidden');
    $('btnLeave').classList.remove('hidden');
  }

  function renderScoreboard() {
    var el = $('scoreboard');
    el.innerHTML = '';
    // rotated order: me first, then left/top/right
    for (var pos = 0; pos < 4; pos++) {
      var seatIdx = posSeat(pos);
      var p = state.players[seatIdx];
      var chip = document.createElement('div');
      chip.className = 'score-chip';
      chip.innerHTML = '<div class="who">' + escapeHtml(p.avatar || '') + ' ' + escapeHtml(nameOf(seatIdx)) + '</div>' +
        '<div class="val">' + (state.totalScores[seatIdx] || 0).toFixed(1) + '</div>';
      el.appendChild(chip);
    }
  }

  function renderLabels() {
    for (var pos = 0; pos < 4; pos++) {
      var seatIdx = posSeat(pos);
      var posName = ['south', 'west', 'north', 'east'][pos];
      var lbl = $('label-' + posName);
      if (!lbl) continue;
      var p = state.players[seatIdx];
      var active = state.phase === 'playing' && state.awaitingSeat === seatIdx;
      lbl.classList.toggle('active', active);
      var nm = (posName === 'south') ? 'You' : escapeHtml(nameOf(seatIdx));
      var bidHtml = state.bids[seatIdx] === null ? '' : '<span class="bid">call ' + state.bids[seatIdx] + '</span>';
      var tricksHtml = state.bids[seatIdx] === null ? '' : '<span class="tricks">won ' + state.tricksWon[seatIdx] + '</span>';
      lbl.innerHTML = '<span class="name">' + nm + '</span>' + bidHtml + tricksHtml;
    }
  }

  function renderBacks() {
    for (var pos = 1; pos < 4; pos++) {
      var seatIdx = posSeat(pos);
      var posName = ['south', 'west', 'north', 'east'][pos];
      var el = $('hand-' + posName);
      if (!el) continue;
      el.innerHTML = '';
      var n = state.handCounts[seatIdx] || 0;
      for (var i = 0; i < n; i++) {
        var d = document.createElement('div');
        d.className = 'cardback';
        el.appendChild(d);
      }
    }
  }

  function renderMyHand() {
    var el = $('hand-south');
    el.innerHTML = '';
    var hand = state.myHand || [];
    var myTurn = isMyTurn();
    var legal = myTurn ? legalMovesFor(hand) : [];
    hand.forEach(function (card) {
      var isLegal = legal.some(function (m) { return m.suit === card.suit && m.rank === card.rank; });
      var disabled = !myTurn || !isLegal;
      var d = cardEl(card, disabled ? 'disabled' : '');
      if (!disabled) {
        d.addEventListener('click', function () {
          send({ t: 'play', card: { suit: card.suit, rank: card.rank } });
        });
      }
      el.appendChild(d);
    });
  }

  function renderTrick() {
    var area = $('trickArea');
    area.innerHTML = '';
    (state.currentTrick || []).forEach(function (entry) {
      var slot = document.createElement('div');
      slot.className = 'trick-slot pos-' + ['south', 'west', 'north', 'east'][displayPos(entry.seatIdx)];
      slot.appendChild(cardEl(entry.card));
      area.appendChild(slot);
    });
  }

  function renderStatus() {
    var el = $('statusLine');
    if (state.phase === 'bidding') {
      el.textContent = state.awaitingSeat === you
        ? 'Your call — how many tricks will you win?'
        : 'Waiting for ' + escapeHtml(nameOf(state.awaitingSeat)) + ' to call…';
    } else if (state.phase === 'playing') {
      if (state.awaitingSeat === you) {
        el.textContent = state.currentTrick.length === 0 ? 'Your lead — play a card' : 'Your turn — pick a card';
      } else {
        el.textContent = escapeHtml(nameOf(state.awaitingSeat)) +
          (state.currentTrick.length === 0 ? ' is leading…' : ' is thinking…');
      }
    } else if (state.phase === 'summary') {
      el.textContent = 'Deal complete — scores below';
    }
  }

  // ---------- overlays ----------
  function renderBidOverlay() {
    var overlay = $('bidOverlay');
    var myTurnToBid = state.phase === 'bidding' && state.awaitingSeat === you;
    if (!myTurnToBid) {
      overlay.classList.add('hidden');
      return;
    }
    if (!overlay.classList.contains('hidden')) return; // already shown
    var grid = $('bidGrid');
    grid.innerHTML = '';
    for (var i = 1; i <= 13; i++) {
      var b = document.createElement('button');
      b.className = 'bid-btn';
      b.textContent = String(i);
      b.addEventListener('click', function (v) {
        return function () {
          overlay.classList.add('hidden');
          send({ t: 'bid', v: v });
        };
      }(i));
      grid.appendChild(b);
    }
    overlay.classList.remove('hidden');
  }

  function renderSummary() {
    var overlay = $('roundOverlay');
    if (state.phase !== 'summary' || !state.summaryRows) {
      overlay.classList.add('hidden');
      return;
    }
    var isFinal = state.isFinal;
    $('roundOverlayTitle').textContent = isFinal ? 'Final results' : 'Deal ' + state.dealNum + ' complete';
    var table = $('roundTable');
    var html = '<tr><th class="name-col">Player</th><th>Call</th><th>Won</th><th>Deal</th><th>Total</th></tr>';
    state.summaryRows.forEach(function (r) {
      html += '<tr><td class="name-col">' + escapeHtml(nameOf(r.seatIdx)) + '</td>' +
        '<td>' + r.bid + '</td><td>' + r.won + '</td>' +
        '<td>' + (r.roundScore >= 0 ? '+' : '') + r.roundScore.toFixed(1) + '</td>' +
        '<td>' + r.total.toFixed(1) + '</td></tr>';
    });
    table.innerHTML = html;
    var btn = $('continueBtn');
    var amHost = you === state.hostSeat;
    btn.disabled = !amHost;
    btn.textContent = amHost ? (isFinal ? 'New Game' : 'Next Deal') : 'Waiting for host…';
    overlay.classList.remove('hidden');
  }

  // ---------- home / join flow ----------
  var homeAvatars = null;
  var joinAvatars = null;

  function renderHome() {
    var sess = loadSession();
    var chip = $('homeResume');
    if (sess && sess.roomId && sess.session) {
      chip.classList.remove('hidden');
      chip.innerHTML = 'Resume room <b>' + escapeHtml(sess.roomId) + '</b> ↻';
    } else {
      chip.classList.add('hidden');
    }
  }

  function startPractice() {
    showScreen('table');
    document.body.classList.remove('online');
    $('newGameBtn').classList.remove('hidden');
    $('btnLeave').classList.add('hidden');
    $('roundPill').textContent = 'Practice';
    if (window.__cbStartOffline) window.__cbStartOffline();
  }

  function joinWithCode(code) {
    var name = ($('joinName').value || '').trim();
    if (!name) { showToast('Enter your name first.'); return; }
    var avatar = joinAvatars.get();
    saveName(name);
    saveAvatar(avatar);
    mySession = '';           // fresh join
    roomId = String(code || '').trim().toUpperCase();
    intentionallyClosed = false;
    you = -1;
    connect('join');
    // show lobby immediately; the joined+state messages will fill it in
    $('lobbyRoomCode').textContent = roomId;
    $('lobbyStatus').textContent = 'Joining…';
    $('lobbySeats').innerHTML = '';
    showScreen('lobby');
  }

  function wireUp() {
    homeAvatars = buildAvatarPicker('homeAvatars', loadAvatar() || AVATARS[0]);
    joinAvatars = buildAvatarPicker('joinAvatars', loadAvatar() || AVATARS[0]);
    $('homeName').value = loadName();

    $('btnCreate').addEventListener('click', function () {
      var name = ($('homeName').value || '').trim();
      if (!name) { showToast('Enter your name first.'); return; }
      saveName(name);
      saveAvatar(homeAvatars.get());
      mySession = '';
      roomId = null;
      intentionallyClosed = false;

      connect('create');
      $('lobbyStatus').textContent = 'Creating room…';
      showScreen('lobby');
    });

    $('btnJoinCode').addEventListener('click', function () {
      var code = ($('homeRoomCode').value || '').trim().toUpperCase();
      if (!code) { showToast('Enter the room code your friend shared.'); return; }
      openJoin(code);
    });
    $('homeRoomCode').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('btnJoinCode').click();
    });

    $('btnJoinConfirm').addEventListener('click', function () {
      joinWithCode($('joinRoomTitle').textContent);
    });
    $('btnJoinBack').addEventListener('click', function () { showScreen('home'); renderHome(); });

    $('btnPractice').addEventListener('click', startPractice);

    $('btnP2P').addEventListener('click', function () {
      showScreen('p2p');
    });

    $('btnStart').addEventListener('click', function () { send({ t: 'start' }); });
    $('btnLeave').addEventListener('click', leaveRoom);
    $('btnCopyLink').addEventListener('click', function () {
      var url = joinUrlFor(state ? state.roomId : roomId);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () { showToast('Link copied!'); });
      } else {
        showToast(url);
      }
    });
    $('continueBtn').addEventListener('click', function () {
      if (!onlineTableLive || !state) return; // offline mode has its own handler
      if (you === state.hostSeat) send({ t: 'next' });
    });

    $('homeResume').addEventListener('click', function () {
      var sess = loadSession();
      if (!sess) return;
      roomId = sess.roomId;
      mySession = sess.session;
      intentionallyClosed = false;
      connect('resume');
      $('lobbyStatus').textContent = 'Reconnecting…';
      showScreen('lobby');
    });

    renderHome();

    // Exports for the offline P2P module (p2p.js).
    window.__cbNet = {
      deliver: handleServerMessage,
      getState: function () { return state; },
      enterP2P: function (asHost) { p2pActive = true; },
      exitP2POnly: function () { p2pActive = false; },
      leave: leaveRoom,
      buildAvatarPicker: buildAvatarPicker,
      showHome: function () { showScreen('home'); renderHome(); },
    };
  }

  function openJoin(code) {
    $('joinRoomTitle').textContent = code;
    $('joinName').value = loadName();
    showScreen('join');
  }

  // ---------- boot ----------
  function boot() {
    wireUp();
    // QR scan / shared link: ?join=CODE — jump straight to the join screen
    var params = new URLSearchParams(location.search);
    var code = (params.get('join') || params.get('j') || '').trim().toUpperCase();
    if (code) {
      openJoin(code);
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, '', '/');
      }
      return;
    }
    showScreen('home');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();