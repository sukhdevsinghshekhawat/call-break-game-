# Call Break — Multiplayer Table for Four

Spades trump, five deals, four friends. Play over your local Wi-Fi: one player
creates the game, everyone else **scans the QR code with their phone camera**
and joins instantly.

## Project Structure

```
callbreak-multiplayer/
├── frontend/                    # Static files (deploy to Netlify/Vercel)
│   ├── game.html               # Single-page UI
│   └── net.js                  # Client-side networking & rendering
├── backend/                     # Server (deploy to Render/Railway/Fly.io)
│   ├── server.js              # HTTP server, QR proxy, WebSocket, game engine
│   ├── smoke.js               # Headless integration test
│   ├── validate.js            # Static checks
│   ├── package.json           # Backend dependencies & scripts
│   └── node_modules/
├── README.md
└── package.json               # Root workspace package.json
```

## Quick Start (Same Wi-Fi / LAN)

```bash
# From the backend folder
cd backend
npm install          # one-time
npm start            # starts server on localhost:3000
```

Then open the printed URL:

- **On the host's Mac:** http://localhost:3000
- **On friends' phones (same Wi-Fi):** http://<host-ip>:3000 — the exact
  address is printed when the server starts, e.g. `http://192.168.1.5:3000`.

Friends scan the QR code or type the room code to join instantly!

## Offline 4-Phone Mode (No Server, No Internet)

Play with four friends on four different phones **without any server and without
internet** — just a shared Wi-Fi network or a phone hotspot. One phone acts as
the host and runs the game engine in the browser; the other three join over
**WebRTC DataChannels** by exchanging short connection codes.

> **How it works:** the host creates an "invite code" (a blob of text). A friend
> pastes it, gets a "reply code" back, and sends that to the host. The two
> phones connect directly. Repeat for players 3 and 4. No data leaves the local
> network — the codes are just a manual substitute for a signaling server.

### Step by step

1. **All four phones** open the game page once while they have *any* network
   (e.g. the LAN URL above, or a deployed URL). A service worker caches the
   page so it loads fully offline afterwards. (First visit needs a network;
   every later visit works with zero connectivity.)
2. Connect all four phones to the **same Wi-Fi** — or turn on one phone's
   hotspot and have the other three join it (mobile data can stay OFF).
3. On the **host's** phone tap **📡 Offline 4-Phone (no server / no internet)**
   → **🏠 Host**. The lobby appears with an "Add Player" panel instead of a QR
   code.
4. For each friend:
   - Host taps **➕ Add Player N** → an **invite code** appears. Copy it and
     send it to that friend (WhatsApp, notes app, or read it out loud).
   - The friend taps **🤝 Join a friend's offline room**, enters their name,
     pastes the invite code, and taps **🔗 Connect**. A **reply code**
     appears — they copy it and send it back to the host.
   - Host pastes the reply code and taps **✅ Complete connection**. The
     friend's seat fills in the lobby.
5. When all 4 seats are filled, the host presses **Start Game** — play proceeds
   exactly like the online mode, synced phone-to-phone.

### Notes

- The connection codes are base64-encoded WebRTC session descriptions. They are
  only meaningful between the two phones that exchange them.
- **Different locations too:** because the connection uses public STUN servers,
  friends can join from different cities / different Wi-Fi networks — not just
  the same hotspot. (The STUN servers only help the phones find each other; the
  actual game data flows peer-to-peer, so it stays private and needs no central
  server. A one-time outbound internet connection for the STUN lookup is required.)
- If a player drops mid-game, the host auto-plays for that seat (same AI as the
  online server) until they reconnect.
- This mode needs a browser with WebRTC support (all modern phones). It does
  **not** work from `file://` — open it from a `http://` / `https://` URL.

---

## Deployment (Different Wi-Fi Networks)

For players on **different networks**, deploy the backend and frontend separately:

### Deploy Backend (Render.com)

1. Push `backend/` folder to a Git repo → connect to [Render.com](https://render.com)
2. Create a **Web Service** with:
   - Build command: `npm install`
   - Start command: `node server.js`
   - Add environment variable: `PORT = 10000` (Render assigns this automatically)

### Deploy Frontend (Netlify)

1. Push `frontend/` folder to a Git repo → connect to [Netlify](https://netlify.com)
2. In `frontend/game.html`, uncomment and edit the WebSocket URL:
   ```html
   <script>window.__WS_URL__ = 'wss://your-backend.onrender.com/ws';</script>
   ```
3. That's it! Friends open your Netlify URL from any network, scan/create rooms, and play live.

---

## Game Flow

1. **Host** taps **🎮 Create Game** → a room is created with a unique
   6-character **Room ID** and a **QR code** on the lobby screen.
2. **Friends** point their phone camera at the QR → it opens the join page
   directly (or they type the room code / open the shared link).
3. Each friend picks a **name + avatar** and takes a seat — the lobby fills
   1/4 → 2/4 → 3/4 → 4/4 live.
4. When 4/4 are seated the **host presses Start Game** — cards are dealt
   server-side and every play syncs to all four phones in real time.
5. Bidding (1–13), trick play, and scoring all follow standard Call Break
   rules; five deals decide the table.

## Rules (as Implemented)

- 52-card deck, 13 cards each; **spades are always trump**.
- Bidding starts with the holder of the 2 of clubs, proceeding clockwise.
- You must follow suit if you can; highest spade (or highest card of the led
  suit) takes the trick.
- Made your call: `+bid + (won − bid) × 0.1`. Missed it: `−bid`.
- Five deals; highest total wins.

## Extras

- **Offline 4-Phone mode** — play with four friends on four phones, no server and
  no internet needed (WebRTC DataChannels over a shared Wi-Fi / hotspot). Tap
  **📡 Offline 4-Phone** on the home screen. See the section above for the
  step-by-step.
- **Practice offline vs bots** — the original single-player build is still
  available from the home screen.
- **Dropped player?** The server (or the offline host) auto-plays for any
  disconnected seat (same brain as the offline bots) until they return.
- **Reconnect** — a player who reloads or drops off gets reconnected to their
  seat automatically (via the Resume chip on the home screen).
- **Play across networks** — use `npm run start:public` (backend) with localtunnel,
  or deploy to Render + Netlify as described above.
- If the QR service is unreachable, the lobby still shows the plain join link.

## Project Layout

| Folder      | File         | Purpose                                             |
| ----------- | ------------ | --------------------------------------------------- |
| `backend/`  | `server.js`  | HTTP server, QR proxy, WebSocket room sync (uses RoomCore) |
| `backend/`  | `roomcore.test.js` | Headless test: shared engine, 4 conns, 5 deals + auto-play |
| `backend/`  | `smoke.js`   | Headless integration test: 4 WS clients, 5 full deals   |
| `backend/`  | `validate.js`| Static checks: scripts parse, DOM IDs exist            |
| `frontend/` | `game.html`  | Single-page UI: screens, table layout, cards            |
| `frontend/` | `net.js`     | Client networking + screens (home / join / lobby / table / offline) |
| `frontend/` | `roomcore.js`| **Shared** game engine + room model (UMD: Node + browser) |
| `frontend/` | `p2p.js`     | Offline WebRTC DataChannel networking (no server)       |
| `frontend/` | `sw.js`      | Service worker — offline app-shell cache                |

## Testing

```bash
# terminal 1 — start the server
cd backend
npm start

# terminal 2 — full game simulation (bidding, tricks, scoring, auto-play)
cd backend
node smoke.js

# static checks only (no server needed)
cd backend
node validate.js
```

`smoke.js` simulates the complete flow: create → 3 joins → start → 5 deals of
bidding and trick play → and verifies a dropped player's seat is auto-played.

## Cross-Network Play (Tunnel Mode)

To play across different Wi-Fi networks without deploying to a cloud service:

```bash
# In the backend folder, use tunnel mode:
cd backend
npm run start:public
# OR:
TUNNEL=true node server.js
```

The server will start a **localtunnel** public URL. Share this URL with friends —
they open it on their phones (even on different networks), scan the QR code,
and join the room!

**Note:** The WebSocket URL is automatically derived from the page URL, so
tunnel connections work out of the box.
# call-break-game-
