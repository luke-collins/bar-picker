const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
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

/*
  Room states:
    'lobby'   - waiting for players, anyone can join, bars can be added
    'playing' - game in progress, turn-based elimination
    'done'    - one bar left
*/

const rooms = new Map();

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
    });
  }
  return rooms.get(code);
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
      const player = currentRoom.players.find(p => p.id === myPlayerId);
      if (player) {
        player.connected = false;
        broadcastAll(currentRoom, roomSummary(currentRoom));
      }
      // Clean up if empty
      const anyConnected = currentRoom.players.some(p => p.connected);
      if (!anyConnected) {
        setTimeout(() => {
          const r = rooms.get(currentRoom.code);
          if (r && !r.players.some(p => p.connected)) rooms.delete(currentRoom.code);
        }, 30 * 60 * 1000);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Bar Picker running at http://localhost:${PORT}`));
