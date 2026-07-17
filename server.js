const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const http2 = require('http2');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());

// ── UNIVERSAL LINKS (iOS) ──────────────────────────────────────────────────
// Apple's CDN fetches this at load time to decide which URLs on this domain
// should open the native app instead of Safari -- must be served with no
// redirects, as application/json, at exactly this path (no .json extension).
// Requires the "Associated Domains" capability (applinks:<this-domain>) to
// also be added to the iOS app in Xcode; the file alone isn't enough.
app.get('/.well-known/apple-app-site-association', (req, res) => {
  res.type('application/json').json({
    applinks: {
      details: [
        {
          appID: 'S78XGMW883.com.lukecollins.barpicker',
          paths: ['*'],
        },
      ],
    },
  });
});

// ── SUPPORT PAGE (App Store Connect "Support URL") ──────────────────────────
app.get('/support', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'support.html'));
});

// ── PRIVACY POLICY (App Store Connect "Privacy Policy URL") ─────────────────
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// ── FIND BARS (Google Places API) ────────────────────────────────────────
const PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const SEARCH_RADIUS_METERS = 8000; // ~5 miles
const FIND_BARS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const findBarsCache = new Map(); // cacheKey -> { expires, data }

function findBarsCacheKey(location, filters) {
  const normalizedFilters = [...filters].map(f => f.toLowerCase().trim()).sort().join(',');
  return `${location.toLowerCase().trim()}|${normalizedFilters}`;
}

async function geocodeLocation(location) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${PLACES_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding request failed (${res.status})`);
  const data = await res.json();
  if (data.status === 'ZERO_RESULTS') return null;
  if (data.status !== 'OK' || !data.results || !data.results.length) {
    throw new Error(`Geocoding API error: ${data.status}${data.error_message ? ' - ' + data.error_message : ''}`);
  }
  const { lat, lng } = data.results[0].geometry.location;
  return { lat, lng };
}

async function searchPlacesText(query, center) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': PLACES_API_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount',
    },
    body: JSON.stringify({
      textQuery: query,
      locationBias: {
        circle: {
          center: { latitude: center.lat, longitude: center.lng },
          radius: SEARCH_RADIUS_METERS,
        },
      },
      maxResultCount: 20,
    }),
  });
  if (!res.ok) {
    throw new Error(`Places API error (${res.status})`);
  }
  const data = await res.json();
  return Array.isArray(data.places) ? data.places : [];
}

app.post('/api/find-bars', async (req, res) => {
  try {
    if (!PLACES_API_KEY) {
      return res.status(500).json({ error: 'Server is not configured with a Google Places API key.' });
    }

    const location = String(req.body?.location || '').trim().slice(0, 100);
    const filters = Array.isArray(req.body?.filters)
      ? req.body.filters.map(f => String(f).trim().slice(0, 40)).filter(Boolean).slice(0, 8)
      : [];

    if (!location) {
      return res.status(400).json({ error: 'Please enter a city name or zip code.' });
    }

    const cacheKey = findBarsCacheKey(location, filters);
    const cached = findBarsCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return res.json(cached.data);
    }

    const center = await geocodeLocation(location);
    if (!center) {
      return res.status(404).json({ error: `Could not find "${location}". Try a different city or zip code.` });
    }

    const queries = filters.length > 0
      ? filters.map(f => `${f} near ${location}`)
      : [`bar near ${location}`];

    const resultsByPlaceId = new Map();
    for (const query of queries) {
      const places = await searchPlacesText(query, center);
      for (const place of places) {
        if (!place.id || resultsByPlaceId.has(place.id)) continue;
        resultsByPlaceId.set(place.id, {
          name: place.displayName?.text || 'Unknown',
          address: place.formattedAddress || '',
          rating: typeof place.rating === 'number' ? place.rating : 0,
          reviewCount: typeof place.userRatingCount === 'number' ? place.userRatingCount : 0,
          placeId: place.id,
        });
      }
    }

    const results = [...resultsByPlaceId.values()]
      .sort((a, b) => b.reviewCount - a.reviewCount)
      .slice(0, 30)
      .map(({ reviewCount, ...place }) => place);

    findBarsCache.set(cacheKey, { expires: Date.now() + FIND_BARS_CACHE_TTL_MS, data: results });

    res.json(results);
  } catch (err) {
    console.error('find-bars error:', err);
    res.status(502).json({ error: 'Something went wrong searching for bars. Please try again.' });
  }
});

const DEFAULT_BARS = [
  'Bulldog (Uptown)', 'BBG', 'Yacht Club', 'The Tchoup Yard', "Bruno's",
  'Bulldog (Mid City)', 'Urban South', 'Wrong Iron', 'Monkey Hill',
  'Rendezvous', "Mick's", "Fat Harry's", 'Parasols', 'Port Orleans',
  "Lucy's", 'Hog Alley', 'Finn McCools', 'Parlays', 'Cooter Browns',
  'The Basin', "Manning's", 'Abita', 'MRB'
];

// ── PUSH NOTIFICATIONS (APNs) ─────────────────────────────────────────────
// Local notifications triggered by client-side JS can't reliably fire once a
// backgrounded WKWebView is suspended by iOS (no background mode entitlement
// here), so turn alerts are sent as real push notifications instead: the
// server decides when a turn changes and pushes directly to Apple's servers,
// which deliver independent of whether the app's own process is running.
//
// Required env vars (all-or-nothing -- push sending is silently disabled,
// not an error, if any are missing):
//   APNS_KEY_ID        Key ID of the APNs Auth Key created in the Apple
//                       Developer portal (Certificates, IDs & Profiles > Keys)
//   APNS_TEAM_ID        Apple Developer Team ID
//   APNS_BUNDLE_ID      App's bundle identifier (capacitor.config.json's appId)
//   APNS_KEY_BASE64     The .p8 key file's contents, base64-encoded (avoids
//                       newline-escaping issues from pasting raw PEM into an
//                       env var) -- e.g. `base64 -i AuthKey_XXXX.p8`
//   APNS_PRODUCTION     Optional, "true" to use Apple's production APNs host
//                       instead of the sandbox host used by Xcode debug
//                       builds. Defaults to sandbox.
const APNS_KEY_ID = process.env.APNS_KEY_ID || null;
const APNS_TEAM_ID = process.env.APNS_TEAM_ID || null;
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || null;
const APNS_PRIVATE_KEY = process.env.APNS_KEY_BASE64
  ? Buffer.from(process.env.APNS_KEY_BASE64, 'base64').toString('utf8')
  : null;
const APNS_HOST = process.env.APNS_PRODUCTION === 'true'
  ? 'api.push.apple.com'
  : 'api.sandbox.push.apple.com';
const APNS_ENABLED = !!(APNS_KEY_ID && APNS_TEAM_ID && APNS_BUNDLE_ID && APNS_PRIVATE_KEY);

if (!APNS_ENABLED) {
  console.log('[apns] not configured (missing APNS_KEY_ID/APNS_TEAM_ID/APNS_BUNDLE_ID/APNS_KEY_BASE64) -- turn push notifications disabled');
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Apple's Provider Authentication Token (JWT, ES256) is valid up to 1 hour
// and Apple rate-limits how often you may generate a new one -- cache and
// reuse it rather than signing a fresh token per push.
let cachedApnsJwt = null;
let cachedApnsJwtIssuedAt = 0;
const APNS_JWT_MAX_AGE_MS = 55 * 60 * 1000;

function getApnsJwt() {
  const now = Date.now();
  if (cachedApnsJwt && now - cachedApnsJwtIssuedAt < APNS_JWT_MAX_AGE_MS) {
    return cachedApnsJwt;
  }
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: APNS_KEY_ID }));
  const claims = base64url(JSON.stringify({ iss: APNS_TEAM_ID, iat: Math.floor(now / 1000) }));
  const signingInput = `${header}.${claims}`;
  // ES256 JWT signatures need the raw (r || s) "JOSE" format, not the DER
  // encoding crypto.sign() produces by default for EC keys -- dsaEncoding
  // asks Node to produce JOSE directly instead of hand-parsing ASN.1 DER.
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: APNS_PRIVATE_KEY,
    dsaEncoding: 'ieee-p1363',
  });
  cachedApnsJwt = `${signingInput}.${base64url(signature)}`;
  cachedApnsJwtIssuedAt = now;
  return cachedApnsJwt;
}

function sendApnsPush(deviceToken, { title, body }) {
  if (!APNS_ENABLED) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${APNS_HOST}`);
    client.on('error', reject);

    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      'authorization': `bearer ${getApnsJwt()}`,
      'apns-topic': APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
      'content-type': 'application/json',
    });

    let statusCode = null;
    let responseBody = '';
    req.on('response', (headers) => { statusCode = headers[':status']; });
    req.setEncoding('utf8');
    req.on('data', (chunk) => { responseBody += chunk; });
    req.on('end', () => {
      client.close();
      if (statusCode === 200) resolve();
      else reject(new Error(`APNs error ${statusCode}: ${responseBody}`));
    });
    req.on('error', (err) => { client.close(); reject(err); });

    req.end(JSON.stringify({
      aps: { alert: { title, body }, sound: 'default' },
    }));
  });
}

// Pushes a "your turn" alert to whoever the current turn belongs to, if
// they've registered a device token. Fire-and-forget: push delivery must
// never block or fail game logic.
function notifyCurrentTurnPlayer(room) {
  if (!APNS_ENABLED || room.state !== 'playing') return;
  const playerId = currentTurnPlayerId(room);
  const player = room.players.find(p => p.id === playerId);
  if (!player || !player.pushToken) return;

  sendApnsPush(player.pushToken, {
    title: 'Your turn!',
    body: "It's your turn to eliminate a bar!",
  }).catch(err => console.log('[apns] push failed', err.message));
}

/*
  Room states:
    'lobby'   - waiting for players, anyone can join, bars can be added
    'playing' - game in progress, turn-based elimination
    'done'    - one bar left
*/

const rooms = new Map();
const DISCONNECT_GRACE_MS = 45 * 1000;

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      bars: [],
      players: [],      // [{ id, username, connected }]
      clients: new Map(), // playerId -> ws
      state: 'lobby',
      turnIndex: 0,
      host: null,       // first player id
      eliminationLog: [],
      disconnectTimers: new Map(), // playerId -> Timeout, pending grace-period removal
    });
  }
  return rooms.get(code);
}

// Removes a player entirely (post grace-period) and keeps turnIndex pointing
// at the correct player despite the array shrinking. If the removed player
// held the turn, this lands on whoever shifted into their old slot (their
// successor), so play advances instead of stalling on someone who's gone;
// otherwise the active player's index is only shifted down when the removal
// happened earlier in the array than them.
function removePlayer(room, playerId) {
  const idx = room.players.findIndex(p => p.id === playerId);
  if (idx === -1) return;

  const wasHost = room.host === playerId;
  const activeIdx = (room.state === 'playing' && room.players.length > 0)
    ? room.turnIndex % room.players.length
    : null;

  room.players.splice(idx, 1);
  room.clients.delete(playerId);

  if (room.players.length === 0) {
    room.turnIndex = 0;
  } else if (activeIdx !== null) {
    room.turnIndex = activeIdx > idx ? activeIdx - 1
      : activeIdx === idx ? idx % room.players.length
      : activeIdx;
  }

  if (wasHost) {
    room.host = room.players.length > 0 ? room.players[0].id : null;
  }
}

function broadcastAll(room, message) {
  const data = JSON.stringify(message);
  for (const [, ws] of room.clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

function roomSummary(room) {
  return {
    type: 'room_state',
    state: room.state,
    bars: room.bars,
    players: room.players.map(p => ({ id: p.id, username: p.username, connected: p.connected })),
    turnIndex: room.turnIndex,
    host: room.host,
    eliminationLog: room.eliminationLog,
  };
}

function currentTurnPlayerId(room) {
  const len = room.players.length;
  if (len === 0) return null;
  return room.players[room.turnIndex % len].id;
}

wss.on('connection', (ws) => {
  let currentRoom = null;
  let myPlayerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── JOIN ──────────────────────────────────────────────────────────────
    if (msg.type === 'join') {
      const code = (msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      const username = (msg.username || '').trim().slice(0, 20);
      if (!code || !username) return;

      currentRoom = getRoom(code);

      // Check if reconnecting (same username)
      let player = currentRoom.players.find(p => p.username.toLowerCase() === username.toLowerCase());
      if (player) {
        // Reconnect
        player.connected = true;
        myPlayerId = player.id;
        // Cancel any pending grace-period removal from a prior disconnect
        const pendingRemoval = currentRoom.disconnectTimers.get(player.id);
        if (pendingRemoval) {
          clearTimeout(pendingRemoval);
          currentRoom.disconnectTimers.delete(player.id);
        }
        // If old ws exists, close it silently
        const oldWs = currentRoom.clients.get(player.id);
        if (oldWs && oldWs !== ws) oldWs.terminate();
      } else {
        // New player — joins as a full participant even if the game is
        // already in progress, appended to the end of the turn order.
        const duplicate = currentRoom.players.find(p => p.username.toLowerCase() === username.toLowerCase());
        if (duplicate) {
          ws.send(JSON.stringify({ type: 'error', message: 'Username taken in this room.' }));
          return;
        }
        myPlayerId = crypto.randomBytes(4).toString('hex');
        player = { id: myPlayerId, username, connected: true };
        const priorPlayerCount = currentRoom.players.length;
        currentRoom.players.push(player);
        if (currentRoom.state === 'playing' && priorPlayerCount > 0) {
          // room.turnIndex % players.length picks the active player; growing
          // players.length changes that result unless turnIndex is first
          // collapsed to its effective value under the OLD length, which is
          // always < priorPlayerCount <= the new length (so re-modulo by the
          // new length is a no-op) — keeps the current turn unchanged and
          // just extends the rotation for future turns.
          currentRoom.turnIndex = currentRoom.turnIndex % priorPlayerCount;
        }
        if (!currentRoom.host) currentRoom.host = myPlayerId;
      }

      currentRoom.clients.set(myPlayerId, ws);

      // Send this player their identity + full room state
      ws.send(JSON.stringify({ type: 'you', playerId: myPlayerId, isHost: myPlayerId === currentRoom.host }));
      ws.send(JSON.stringify(roomSummary(currentRoom)));

      // Broadcast updated player list to everyone
      broadcastAll(currentRoom, roomSummary(currentRoom));
    }

    if (!currentRoom || !myPlayerId) return;

    // ── REGISTER PUSH TOKEN ──────────────────────────────────────────────
    if (msg.type === 'register_push_token') {
      const token = (msg.token || '').trim();
      if (!token) return;
      const player = currentRoom.players.find(p => p.id === myPlayerId);
      if (player) player.pushToken = token;
    }

    // ── START GAME ────────────────────────────────────────────────────────
    if (msg.type === 'start_game') {
      if (myPlayerId !== currentRoom.host) return;
      if (currentRoom.players.length < 1) return;
      if (currentRoom.bars.length < 2) return;
      // Shuffle player order
      for (let i = currentRoom.players.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [currentRoom.players[i], currentRoom.players[j]] = [currentRoom.players[j], currentRoom.players[i]];
      }
      currentRoom.state = 'playing';
      currentRoom.turnIndex = 0;
      broadcastAll(currentRoom, roomSummary(currentRoom));
      notifyCurrentTurnPlayer(currentRoom);
    }

    // ── LOAD DEFAULTS ─────────────────────────────────────────────────────
    if (msg.type === 'load_defaults') {
      if (currentRoom.state !== 'lobby') return;
      const selected = Array.isArray(msg.selected) ? msg.selected : DEFAULT_BARS;
      const validNames = selected
        .map(n => String(n).trim().slice(0, 60))
        .filter(n => n.length > 0);
      currentRoom.bars = validNames.map(name => ({
        id: crypto.randomBytes(4).toString('hex'), name, eliminated: false
      }));
      broadcastAll(currentRoom, roomSummary(currentRoom));
    }

    // ── CLEAR BARS ────────────────────────────────────────────────────────
    if (msg.type === 'clear_bars') {
      if (currentRoom.state !== 'lobby') return;
      currentRoom.bars = [];
      broadcastAll(currentRoom, roomSummary(currentRoom));
    }

    // ── ADD BAR ───────────────────────────────────────────────────────────
    if (msg.type === 'add') {
      if (currentRoom.state === 'playing') return; // no adding during game
      const name = (msg.name || '').trim().slice(0, 60);
      if (!name) return;
      if (currentRoom.bars.find(b => b.name.toLowerCase() === name.toLowerCase())) return;
      const bar = { id: crypto.randomBytes(4).toString('hex'), name, eliminated: false };
      currentRoom.bars.push(bar);
      broadcastAll(currentRoom, { type: 'add', bar });
    }

    // ── ELIMINATE ─────────────────────────────────────────────────────────
    if (msg.type === 'eliminate') {
      if (currentRoom.state !== 'playing') return;
      // Enforce turn
      if (currentTurnPlayerId(currentRoom) !== myPlayerId) return;
      const bar = currentRoom.bars.find(b => b.id === msg.id && !b.eliminated);
      if (!bar) return;
      bar.eliminated = true;
      const eliminator = currentRoom.players.find(p => p.id === myPlayerId);
      currentRoom.eliminationLog.push({
        barId: bar.id,
        barName: bar.name,
        byPlayerId: myPlayerId,
        byUsername: eliminator ? eliminator.username : '?',
      });

      // Advance turn
      currentRoom.turnIndex = (currentRoom.turnIndex + 1) % currentRoom.players.length;

      // Check win condition
      const remaining = currentRoom.bars.filter(b => !b.eliminated);
      if (remaining.length === 1) {
        currentRoom.state = 'done';
      }

      broadcastAll(currentRoom, roomSummary(currentRoom));
      notifyCurrentTurnPlayer(currentRoom); // no-op if the game just ended (state !== 'playing')
    }

    // ── DELETE BAR (lobby only) ───────────────────────────────────────────
    if (msg.type === 'delete') {
      if (currentRoom.state !== 'lobby') return;
      currentRoom.bars = currentRoom.bars.filter(b => b.id !== msg.id);
      broadcastAll(currentRoom, roomSummary(currentRoom));
    }

    // ── RESTORE ALL ───────────────────────────────────────────────────────
    if (msg.type === 'restore_all') {
      if (myPlayerId !== currentRoom.host) return;
      currentRoom.bars.forEach(b => b.eliminated = false);
      currentRoom.state = 'lobby';
      currentRoom.turnIndex = 0;
      currentRoom.eliminationLog = [];
      broadcastAll(currentRoom, roomSummary(currentRoom));
    }

    // ── CLEAR ALL ─────────────────────────────────────────────────────────
    if (msg.type === 'clear_all') {
      if (myPlayerId !== currentRoom.host) return;
      currentRoom.bars = [];
      currentRoom.state = 'lobby';
      currentRoom.turnIndex = 0;
      currentRoom.eliminationLog = [];
      broadcastAll(currentRoom, roomSummary(currentRoom));
    }

    // ── PLAY AGAIN ────────────────────────────────────────────────────────
    if (msg.type === 'play_again') {
      if (myPlayerId !== currentRoom.host) return;
      currentRoom.bars.forEach(b => b.eliminated = false);
      currentRoom.state = 'lobby';
      currentRoom.turnIndex = 0;
      currentRoom.eliminationLog = [];
      broadcastAll(currentRoom, roomSummary(currentRoom));
    }
  });

  ws.on('close', () => {
    if (currentRoom && myPlayerId) {
      // A newer connection may have already replaced this one (e.g. a fast
      // reconnect that terminated this stale socket) -- that player is still
      // genuinely connected, so don't mark them disconnected or schedule a
      // removal for them based on this now-superseded socket closing.
      if (currentRoom.clients.get(myPlayerId) !== ws) return;

      const room = currentRoom;
      const playerId = myPlayerId;
      const player = room.players.find(p => p.id === playerId);
      if (player) {
        player.connected = false;
        broadcastAll(room, roomSummary(room));

        // Grace period before actually removing them, so a brief network
        // drop doesn't instantly boot someone out of the game.
        const timer = setTimeout(() => {
          room.disconnectTimers.delete(playerId);
          const p = room.players.find(pl => pl.id === playerId);
          if (!p || p.connected) return; // reconnected in the meantime
          removePlayer(room, playerId);
          broadcastAll(room, roomSummary(room));
          notifyCurrentTurnPlayer(room); // in case removal auto-advanced the turn
        }, DISCONNECT_GRACE_MS);
        room.disconnectTimers.set(playerId, timer);
      }
      // Clean up if empty
      const anyConnected = room.players.some(p => p.connected);
      if (!anyConnected) {
        setTimeout(() => {
          const r = rooms.get(room.code);
          if (r && !r.players.some(p => p.connected)) rooms.delete(room.code);
        }, 30 * 60 * 1000);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Bar Picker running at http://localhost:${PORT}`));
