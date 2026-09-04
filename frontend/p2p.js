// Offline P2P mode — WebRTC DataChannels, no server, no internet.
// One phone (the host) runs the shared RoomCore engine in-page; the other
// three join over the same Wi-Fi / hotspot by exchanging short connection
// codes (invite → reply) via any chat or notes app. No signaling server.
//
// Requires: roomcore.js (window.RoomCore) and net.js (window.__cbNet).
(function () {
  'use strict';

  // Public STUN servers — let peers discover their real (public) IP so the
  // connection works across different networks, not just the same LAN.
  // They only assist NAT traversal; all game data still flows P2P phone-to-phone.
  var ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ];



  function $(id) { return document.getElementById(id); }

  function toast(msg) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.add('hidden'); }, 3600);
  }

  // ---------- invite / reply codes ----------
  // "CB1."-prefixed base64 JSON carrying the SDP (offer or answer).
  function enc(obj) {
    return 'CB1.' + btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
  }
  function dec(str) {
    str = String(str || '').trim();
    if (str.indexOf('CB1.') !== 0) throw new Error('Not a Call Break connection code.');
    return JSON.parse(decodeURIComponent(escape(atob(str.slice(4)))));
  }

  // Wait until ICE gathering finishes (or ~4s cap) so the code is complete.
  function gatherDone(pc) {
    return new Promise(function (resolve) {
      if (pc.iceGatheringState === 'complete') { resolve(); return; }
      var timer = setTimeout(function () { resolve(); }, 4000);
      function check() {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      }
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  // ---------- state ----------
  var mgr = null;        // RoomCore manager (host only)
  var localConn = null;  // host's own client connection (in-page loopback)
  var isHost = false;
  var active = false;    // true while an offline P2P session is in use
  var pending = null;    // host: connection being set up { pc, dc, roomId, wrap }
  var guest = { pc: null, dc: null, roomId: '', name: '', avatar: '' };

  function clientSend(obj) {
    var s = JSON.stringify(obj);
    if (isHost && mgr) mgr.parse(localConn, s);
    else if (!isHost && guest.dc && guest.dc.readyState === 'open') guest.dc.send(s);
  }

  function newWrap(sendFn) {
    return { readyState: 'open', send: sendFn };
  }

  // ---------- HOST ----------
  function startHost() {
    var name = '';
    var avatar = '🎩';
    try {
      name = (localStorage.getItem('cbName') || '').trim() || 'Host';
      avatar = localStorage.getItem('cbAvatar') || '🎩';
    } catch (e) {
      name = 'Host';
    }
    mgr = RoomCore.createRoomManager({ autoDelayMs: 900 });
    localConn = newWrap(function (str) {
      var m;
      try { m = JSON.parse(str); } catch (e) { return; }
      window.__cbNet.deliver(m);
    });
    mgr.attach(localConn);
    isHost = true;
    active = true;
    window.__cbNet.enterP2P(true);
    clientSend({ t: 'create', name: name, avatar: avatar });
    // 'joined' + 'state' now arrive via __cbNet.deliver → the lobby screen
    // renders automatically with the offline "Add Player" panel.
  }

  function addPlayer() {
    if (!isHost || !mgr) return;
    if (pending) { toast('Finish the current connection first.'); return; }
    var st = window.__cbNet.getState();
    if (!st || !st.roomId) { toast('Room is not ready yet.'); return; }
    var pc;
    try {
      // Public STUN servers let peers discover their real (public) IP so the
      // connection also works across different networks — not just same LAN.
      // (These only help with NAT traversal; game data still flows P2P.)
      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    } catch (e) {
      toast('WebRTC is not available in this browser.');
      return;
    }
    var dc = pc.createDataChannel('cb');
    pending = { pc: pc, dc: dc, roomId: st.roomId, wrap: null };

    dc.onopen = function () {
      if (!pending || pending.dc !== dc) return;
      var p = pending;
      p.wrap = newWrap(function (s) { if (dc.readyState === 'open') dc.send(s); });
      mgr.attach(p.wrap);
      dc.onmessage = function (ev) { mgr.parse(p.wrap, ev.data); };
      dc.onclose = function () {
        mgr.detach(p.wrap);
        renderLobbyPanel();
      };
      renderLobbyPanel();
    };

    pc.createOffer()
      .then(function (offer) { return pc.setLocalDescription(offer); })
      .then(function () { return gatherDone(pc); })
      .then(function () {
        if (!pending || pending.pc !== pc) return;
        $('p2pOfferOut').value = enc({ t: 'o', room: pending.roomId, sdp: pc.localDescription.sdp });
        renderLobbyPanel();
      })
      .catch(function (e) {
        toast('Could not create the invite: ' + (e.message || e));
        pending = null;
        renderLobbyPanel();
      });
  }

  function acceptReply() {
    if (!pending) { toast('Tap "Add Player" first.'); return; }
    var ans;
    try {
      ans = dec($('p2pAnswerIn').value);
    } catch (e) {
      toast(e.message);
      return;
    }
    if (ans.t !== 'a' || !ans.sdp) { toast('That is an invite code, not a reply code.'); return; }
    pending.pc.setRemoteDescription({ type: 'answer', sdp: ans.sdp })
      .then(function () {
        toast('Connecting — the player will appear in the seats…');
        pending = null;
        $('p2pAnswerIn').value = '';
        $('p2pOfferOut').value = '';
        renderLobbyPanel();
      })
      .catch(function (e) {
        toast('Reply code did not match: ' + (e.message || e));
      });
  }

  // ---------- GUEST ----------
  function guestConnect() {
    var inv;
    try {
      inv = dec($('p2pInviteIn').value);
    } catch (e) {
      toast(e.message);
      return;
    }
    if (inv.t !== 'o' || !inv.sdp) { toast('That is not a valid invite code.'); return; }
    var name = ($('p2pGuestName').value || '').trim();
    if (!name) { toast('Enter your name first.'); return; }
    var avatar = guestAvatars ? guestAvatars.get() : '🎩';
    try {
      localStorage.setItem('cbName', name);
      localStorage.setItem('cbAvatar', avatar);
    } catch (e) {}

    guest.roomId = inv.room || '';
    guest.name = name;
    guest.avatar = avatar;

    var pc;
    try {
      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    } catch (e) {
      toast('WebRTC is not available in this browser.');
      return;
    }
    guest.pc = pc;

    pc.ondatachannel = function (ev) {
      var dc = ev.channel;
      guest.dc = dc;
      dc.onopen = function () {
        active = true;
        isHost = false;
        window.__cbNet.enterP2P(false);
        clientSend({ t: 'join', roomId: guest.roomId, name: guest.name, avatar: guest.avatar });
        // 'joined' + 'state' arrive via __cbNet.deliver → lobby screen shows up.
      };
      dc.onmessage = function (e2) {
        var m;
        try { m = JSON.parse(e2.data); } catch (err) { return; }
        window.__cbNet.deliver(m);
      };
      dc.onclose = function () {
        if (active && !isHost) {
          toast('Host connection lost.');
          window.__cbNet.leave();
        }
      };
    };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'failed') {
        toast('Connection failed — check both phones are on the same Wi-Fi / hotspot.');
      }
    };

    pc.setRemoteDescription({ type: 'offer', sdp: inv.sdp })
      .then(function () { return pc.createAnswer(); })
      .then(function (ans) { return pc.setLocalDescription(ans); })
      .then(function () { return gatherDone(pc); })
      .then(function () {
        $('p2pAnswerOut').value = enc({ t: 'a', sdp: pc.localDescription.sdp });
        $('p2pAnswerBox').classList.remove('hidden');
        $('p2pGuestStatus').textContent = 'Almost there — send the reply code back to the host…';
        $('p2pInviteIn').value = '';
      })
      .catch(function (e) {
        toast('Connection failed: ' + (e.message || e));
        teardownAll();
        window.__cbNet.exitP2POnly();
      });
  }

  // ---------- teardown ----------
  function teardownAll() {
    active = false;
    isHost = false;
    pending = null;
    if (guest.pc) { try { guest.pc.close(); } catch (e) {} }
    guest = { pc: null, dc: null, roomId: '', name: '', avatar: '' };
    if (localConn && mgr) mgr.detach(localConn);
    localConn = null;
    mgr = null;
  }

  // ---------- offline lobby panel ----------
  function renderLobbyPanel() {
    var panel = $('p2pLobbyPanel');
    if (!panel || !active) return;
    var st = window.__cbNet.getState();
    if (!st) return;
    var seated = st.players.filter(function (p) { return p.name; }).length;
    if (isHost) {
      var addBox = $('p2pAddBox');
      var waiting = !!pending;
      $('btnP2PAdd').classList.toggle('hidden', seated >= 4 || waiting);
      addBox.classList.toggle('hidden', seated >= 4);
      if (!waiting && seated < 4) {
        $('btnP2PAdd').textContent = '➕ Add Player ' + (seated + 1);
        $('p2pOfferRow').classList.add('hidden');
        $('p2pAnswerRow').classList.add('hidden');
      } else if (waiting) {
        $('p2pOfferRow').classList.remove('hidden');
        $('p2pAnswerRow').classList.remove('hidden');
      }
      var status = $('p2pLobbyStatus');
      if (waiting) {
        status.textContent = 'Waiting for the reply code from Player ' + (seated + 1) + '…';
      } else if (seated >= 4) {
        status.textContent = 'All four connected! Deal the cards — press Start Game.';
      } else {
        status.textContent = seated + '/4 connected. Add the next player.';
      }
    } else {
      $('p2pAddBox').classList.add('hidden');
      $('p2pLobbyStatus').textContent = 'Connected to host ✓ — waiting for everyone to join.';
    }
  }

  // ---------- screen helpers ----------
  function showChooser() {
    $('p2pChooser').classList.remove('hidden');
    $('p2pJoinSetup').classList.add('hidden');
    $('btnP2PModeBack').classList.add('hidden');
  }

  function copyText(ta) {
    var v = ta.value;
    if (!v) { toast('Nothing to copy yet.'); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(v).then(function () { toast('Copied! Send it to the other phone.'); });
    } else {
      ta.select();
      try { document.execCommand('copy'); toast('Copied! Send it to the other phone.'); }
      catch (e) { toast('Select and copy manually.'); }
    }
  }

  // ---------- wiring ----------
  var guestAvatars = null;

  function wireUp() {
    $('btnP2PHost').addEventListener('click', function () {
      startHost();
    });

    $('btnP2PJoin').addEventListener('click', function () {
      $('p2pChooser').classList.add('hidden');
      $('p2pJoinSetup').classList.remove('hidden');
      $('btnP2PModeBack').classList.remove('hidden');
      $('p2pGuestName').value = '';
      $('p2pInviteIn').value = '';
      $('p2pAnswerOut').value = '';
      $('p2pAnswerBox').classList.add('hidden');
      $('p2pGuestStatus').textContent = '';
      try { $('p2pGuestName').value = localStorage.getItem('cbName') || ''; } catch (e) {}
      guestAvatars = window.__cbNet.buildAvatarPicker('p2pGuestAvatars', null);
    });

    $('btnP2PBack').addEventListener('click', function () {
      window.__cbNet.showHome();
    });
    $('btnP2PModeBack').addEventListener('click', function () {
      showChooser();
    });
    $('btnP2PGuestBack').addEventListener('click', function () {
      showChooser();
    });

    $('btnP2PGuestConnect').addEventListener('click', guestConnect);
    $('btnP2PCopyAnswer').addEventListener('click', function () { copyText($('p2pAnswerOut')); });

    $('btnP2PAdd').addEventListener('click', addPlayer);
    $('btnP2PCopyOffer').addEventListener('click', function () { copyText($('p2pOfferOut')); });
    $('btnP2PAccept').addEventListener('click', acceptReply);
  }

  // ---------- exports for net.js ----------
  window.__cbP2P = {
    isActive: function () { return active; },
    clientSend: clientSend,
    renderLobbyPanel: renderLobbyPanel,
    teardownAll: teardownAll,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireUp);
  } else {
    wireUp();
  }
})();
