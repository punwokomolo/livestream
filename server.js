'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const path       = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'livestream_dev_secret_change_in_production';

// ---------------------------------------------------------------------------
// Express + HTTP server
// ---------------------------------------------------------------------------
const app    = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------
const io = new Server(server, {
  cors: { origin: '*' },
});

// ---------------------------------------------------------------------------
// Supabase – hosted Postgres user store
// ---------------------------------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ---------------------------------------------------------------------------
// In-memory room state
//   roomBroadcasters : Map<roomId, broadcasterPeerId>
// ---------------------------------------------------------------------------
const roomBroadcasters = new Map();

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
}

// ---------------------------------------------------------------------------
// REST – /api/register
// ---------------------------------------------------------------------------
app.post('/api/register', async (req, res) => {
  const username = (req.body?.username ?? '').trim();
  const password = req.body?.password ?? '';

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  if (username.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const { data, error } = await supabase
      .from('app_users')
      .insert({ username, password: hash })
      .select('id, username')
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'That username is already taken.' });
      }
      console.error('[DB] insert error:', error);
      return res.status(500).json({ error: 'Registration failed. Please try again.' });
    }

    const token = signToken({ userId: data.id, username: data.username });
    return res.json({ token, username: data.username });
  } catch (err) {
    console.error('[Auth] register error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ---------------------------------------------------------------------------
// REST – /api/login
// ---------------------------------------------------------------------------
app.post('/api/login', async (req, res) => {
  const username = (req.body?.username ?? '').trim();
  const password = req.body?.password ?? '';

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    const { data: user, error } = await supabase
      .from('app_users')
      .select('id, username, password')
      .eq('username', username)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const token = signToken({ userId: user.id, username: user.username });
    return res.json({ token, username: user.username });
  } catch {
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ---------------------------------------------------------------------------
// Socket.IO – viewer-count helper
// Uses Socket.IO room introspection so the count is always authoritative.
// ---------------------------------------------------------------------------
async function getViewerCount(roomId) {
  const sockets = await io.in(roomId).fetchSockets();
  return sockets.filter((s) => s.data.role === 'viewer').length;
}

// ---------------------------------------------------------------------------
// Socket.IO – real-time events
//
// Signaling flow (broadcaster-calls-viewer pattern):
//   1. Broadcaster starts stream → peer.open → emit 'broadcaster-ready' (peer ID)
//   2. Server stores peer ID; forwards 'broadcaster-id' to all current viewers
//   3. Viewer receives 'broadcaster-id' → waits for own peer.open
//      → emits 'viewer-joined' (own peer ID)
//   4. Server forwards 'call-viewer' to the broadcaster
//   5. Broadcaster calls viewer: peer.call(viewerPeerId, localStream)
//   6. Viewer answers (no outbound stream): call.answer()
//   7. Viewer receives 'stream' event → plays video
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  console.log(`[Socket] Connected  : ${socket.id}`);

  // --- join-room -----------------------------------------------------------
  // Ties a socket to a room; roles: 'broadcaster' | 'viewer'
  socket.on('join-room', async ({ roomId, username, role }) => {
    socket.join(roomId);
    socket.data.roomId   = roomId;
    socket.data.username = username;
    socket.data.role     = role;

    console.log(`[Room] ${username} (${role}) → "${roomId}"`);

    // Notify everyone else in the room
    socket.to(roomId).emit('user-joined', { username, role });

    // If a viewer joins while a broadcast is already live, hand them the peer ID
    // immediately so they can start the call handshake without waiting for an event.
    if (role === 'viewer' && roomBroadcasters.has(roomId)) {
      socket.emit('broadcaster-id', { peerId: roomBroadcasters.get(roomId) });
    }

    const count = await getViewerCount(roomId);
    io.to(roomId).emit('viewer-count', { count });
  });

  // --- broadcaster-ready ---------------------------------------------------
  // Broadcaster is live; registers their PeerJS ID with the server.
  socket.on('broadcaster-ready', ({ roomId, peerId }) => {
    roomBroadcasters.set(roomId, peerId);
    console.log(`[WebRTC] Broadcaster in "${roomId}" → peer ${peerId}`);

    // Tell any viewers already in the room about the broadcaster's peer ID
    socket.to(roomId).emit('broadcaster-id', { peerId });
  });

  // --- viewer-joined -------------------------------------------------------
  // Viewer's PeerJS peer is open; shares their peer ID so the broadcaster
  // can initiate the media call (avoids the need for viewers to send a stream).
  socket.on('viewer-joined', ({ roomId, peerId }) => {
    console.log(`[WebRTC] Viewer peer ${peerId} ready in "${roomId}"`);
    // Forward to the broadcaster only
    socket.to(roomId).emit('call-viewer', { peerId });
  });

  // --- chat-message --------------------------------------------------------
  // Relays a chat message to every socket in the room (including the sender).
  socket.on('chat-message', ({ roomId, username, text, timestamp }) => {
    if (!text?.trim()) return;
    io.to(roomId).emit('chat-message', {
      username,
      text: text.trim(),
      timestamp,
    });
  });

  // --- disconnect ----------------------------------------------------------
  socket.on('disconnect', async () => {
    const { roomId, username, role } = socket.data;
    if (!roomId) return;

    if (role === 'broadcaster') {
      roomBroadcasters.delete(roomId);
      // Notify viewers so they can show the "stream ended" UI
      io.to(roomId).emit('broadcaster-disconnected');
      console.log(`[Room] Broadcaster "${username}" left "${roomId}"`);
    } else if (role === 'viewer') {
      socket.to(roomId).emit('user-left', { username });
    }

    const count = await getViewerCount(roomId);
    io.to(roomId).emit('viewer-count', { count });

    console.log(`[Socket] Disconnected: ${socket.id} (${username ?? 'unknown'})`);
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`\n🎬  LiveStream Platform  →  http://localhost:${PORT}\n`);
});
