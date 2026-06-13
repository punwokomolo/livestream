'use strict';

/* ==========================================================================
   LiveStream — Frontend Application Logic
   Stack: Socket.IO (chat + signaling) + PeerJS (WebRTC media)

   WebRTC signaling flow (broadcaster-calls-viewer pattern):
   ─────────────────────────────────────────────────────────
   1. Broadcaster clicks "Start" → getUserMedia → peer.open
   2. Broadcaster emits  socket  'broadcaster-ready' (own peer ID)
   3. Server stores peer ID; forwards 'broadcaster-id' to current viewers
   4. Viewer receives 'broadcaster-id' → waits for own peer.open
      → emits socket 'viewer-joined' (own peer ID)
   5. Server forwards 'call-viewer' to the broadcaster
   6. Broadcaster calls viewer: peer.call(viewerPeerId, localStream)
   7. Viewer answers (no outbound media): call.answer()
   8. Viewer receives 'stream' event → plays video element
   ========================================================================== */

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------
const state = {
  socket:          null,
  peer:            null,
  localStream:     null,
  username:        null,
  role:            null,           // 'broadcaster' | 'viewer'
  token:           null,
  roomId:          'main-stream',  // single shared room for this prototype
  peerOpen:        false,          // true once PeerJS cloud handshake is done
  broadcastTimer:  null,
  broadcastSecs:   0,
};

// ---------------------------------------------------------------------------
// Cached DOM references
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const dom = {
  // Auth
  authOverlay:    $('auth-overlay'),
  loginForm:      $('login-form'),
  registerForm:   $('register-form'),
  loginUser:      $('login-username'),
  loginPass:      $('login-password'),
  loginRole:      $('login-role'),
  loginError:     $('login-error'),
  regUser:        $('reg-username'),
  regPass:        $('reg-password'),
  regRole:        $('reg-role'),
  regError:       $('reg-error'),
  loginSubmit:    $('login-submit-btn'),
  registerSubmit: $('register-submit-btn'),
  tabBtns:        document.querySelectorAll('.tab-btn'),

  // App shell
  app:            $('app'),
  userChip:       $('user-chip'),
  liveDot:        $('live-dot'),
  streamStatus:   $('stream-status'),
  logoutBtn:      $('logout-btn'),
  watchingBadge:  $('watching-badge'),

  // Video
  videoPlayer:    $('video-player'),
  videoOverlay:   $('video-overlay'),
  overlayMsg:     $('overlay-msg'),

  // Broadcaster controls
  broadcastCtrls: $('broadcast-controls'),
  startBtn:       $('start-btn'),
  stopBtn:        $('stop-btn'),
  broadcastStats: $('broadcast-stats'),
  statViewers:    $('stat-viewers'),
  statTimer:      $('stat-timer'),

  // Viewer bar
  viewerBar:      $('viewer-bar'),

  // Chat
  chatBox:        $('chat-box'),
  chatForm:       $('chat-form'),
  chatInput:      $('chat-input'),
};

// ---------------------------------------------------------------------------
// Username → consistent accent colour (for chat bubbles)
// ---------------------------------------------------------------------------
const USER_COLOURS = ['#fc8181', '#f6ad55', '#68d391', '#63b3ed', '#d6bcfa', '#fbd38d', '#76e4f7'];

function colourForUser(username) {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = (hash << 5) - hash + username.charCodeAt(i);
    hash |= 0;
  }
  return USER_COLOURS[Math.abs(hash) % USER_COLOURS.length];
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------
function timeLabel() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(secs) {
  const m = String(Math.floor(secs / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  return `${m}:${s}`;
}

// ---------------------------------------------------------------------------
// Chat helpers
// ---------------------------------------------------------------------------

/** Removes the empty-state placeholder on first real message. */
function removeChatPlaceholder() {
  const placeholder = dom.chatBox.querySelector('.chat-empty');
  if (placeholder) placeholder.remove();
}

/** Appends a user chat message bubble to the log. */
function appendMessage({ username, text, timestamp }) {
  removeChatPlaceholder();

  const isSelf = username === state.username;
  const el = document.createElement('div');
  el.className = `chat-msg${isSelf ? ' self' : ''}`;
  el.innerHTML = `
    <div class="msg-meta">
      <span class="msg-user" style="color:${colourForUser(username)}">${escapeHtml(username)}</span>
      <span class="msg-time">${timestamp ?? timeLabel()}</span>
    </div>
    <p class="msg-text">${escapeHtml(text)}</p>
  `;
  dom.chatBox.appendChild(el);
  dom.chatBox.scrollTop = dom.chatBox.scrollHeight;
}

/** Appends a grey italic system event line. */
function appendSystemMessage(text) {
  const el = document.createElement('div');
  el.className = 'chat-msg system';
  el.innerHTML = `<p class="msg-text sys">${escapeHtml(text)}</p>`;
  dom.chatBox.appendChild(el);
  dom.chatBox.scrollTop = dom.chatBox.scrollHeight;
}

/** Minimal HTML escaping to prevent XSS in chat messages. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Stream status UI helpers
// ---------------------------------------------------------------------------

function setLive(active) {
  dom.liveDot.classList.toggle('active', active);
  dom.streamStatus.classList.toggle('live', active);
  dom.watchingBadge.classList.toggle('live', active);
  dom.streamStatus.textContent = active ? '🔴 LIVE' : 'No active broadcast';
}

function showOverlay(msg = 'Waiting for broadcast…') {
  dom.overlayMsg.textContent = msg;
  dom.videoOverlay.classList.remove('hidden');
}

function hideOverlay() {
  dom.videoOverlay.classList.add('hidden');
}

function updateViewerCount(count) {
  dom.watchingBadge.textContent = `${count} watching`;
  dom.statViewers.textContent   = `${count} viewer${count !== 1 ? 's' : ''}`;
}

// ---------------------------------------------------------------------------
// Broadcast timer
// ---------------------------------------------------------------------------
function startTimer() {
  state.broadcastSecs = 0;
  state.broadcastTimer = setInterval(() => {
    state.broadcastSecs++;
    dom.statTimer.textContent = formatDuration(state.broadcastSecs);
  }, 1000);
}

function stopTimer() {
  clearInterval(state.broadcastTimer);
  state.broadcastTimer = null;
  state.broadcastSecs  = 0;
  dom.statTimer.textContent = '00:00';
}

// ---------------------------------------------------------------------------
// AUTH — tab switching
// ---------------------------------------------------------------------------
dom.tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    dom.tabBtns.forEach((b) => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');

    const target = btn.dataset.tab;
    dom.loginForm.classList.toggle('active',    target === 'login');
    dom.registerForm.classList.toggle('active', target === 'register');

    // Clear errors on tab switch
    dom.loginError.textContent = '';
    dom.regError.textContent   = '';
  });
});

// ---------------------------------------------------------------------------
// AUTH — form submissions
// ---------------------------------------------------------------------------
dom.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  dom.loginError.textContent = '';
  dom.loginSubmit.disabled   = true;
  dom.loginSubmit.textContent = 'Signing in…';

  const username = dom.loginUser.value.trim();
  const password = dom.loginPass.value;
  const role     = dom.loginRole.value;

  try {
    const res  = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed.');

    onAuthSuccess(data.username, role, data.token);
  } catch (err) {
    dom.loginError.textContent = err.message;
  } finally {
    dom.loginSubmit.disabled    = false;
    dom.loginSubmit.textContent = 'Enter Stream';
  }
});

dom.registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  dom.regError.textContent       = '';
  dom.registerSubmit.disabled    = true;
  dom.registerSubmit.textContent = 'Creating account…';

  const username = dom.regUser.value.trim();
  const password = dom.regPass.value;
  const role     = dom.regRole.value;

  try {
    const res  = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed.');

    onAuthSuccess(data.username, role, data.token);
  } catch (err) {
    dom.regError.textContent = err.message;
  } finally {
    dom.registerSubmit.disabled    = false;
    dom.registerSubmit.textContent = 'Create Account';
  }
});

// ---------------------------------------------------------------------------
// AUTH — success handler
// ---------------------------------------------------------------------------
function onAuthSuccess(username, role, token) {
  state.username = username;
  state.role     = role;
  state.token    = token;

  // Persist to sessionStorage so a page refresh keeps the session
  sessionStorage.setItem('ls_token',    token);
  sessionStorage.setItem('ls_username', username);
  sessionStorage.setItem('ls_role',     role);

  enterApp();
}

// ---------------------------------------------------------------------------
// App entry point — called after successful auth
// ---------------------------------------------------------------------------
function enterApp() {
  dom.authOverlay.classList.add('hidden');
  dom.app.classList.remove('hidden');

  // Update header UI
  dom.userChip.textContent = `${state.username}  ·  ${state.role}`;

  // Show role-specific controls
  if (state.role === 'broadcaster') {
    dom.broadcastCtrls.classList.remove('hidden');
    dom.viewerBar.classList.add('hidden');
  } else {
    dom.broadcastCtrls.classList.add('hidden');
    dom.viewerBar.classList.remove('hidden');
  }

  initSocket();
  initPeer();
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------
dom.logoutBtn.addEventListener('click', () => {
  // Stop any active broadcast first
  if (state.localStream) stopBroadcast();

  sessionStorage.clear();
  state.socket?.disconnect();
  state.peer?.destroy();

  // Reset UI
  dom.app.classList.add('hidden');
  dom.authOverlay.classList.remove('hidden');
  dom.loginUser.value = '';
  dom.loginPass.value = '';
  dom.chatBox.innerHTML = '<div class="chat-empty"><p>Be the first to say something! 👋</p></div>';
  showOverlay();
  setLive(false);
});

// ---------------------------------------------------------------------------
// SOCKET.IO — initialise and wire all server events
// ---------------------------------------------------------------------------
function initSocket() {
  state.socket = io({ auth: { token: state.token } });

  // Join the room once connected
  state.socket.on('connect', () => {
    state.socket.emit('join-room', {
      roomId:   state.roomId,
      username: state.username,
      role:     state.role,
    });
  });

  // ── WebRTC signaling ────────────────────────────────────────────────────

  // Viewer receives broadcaster's peer ID (either on join or when broadcast starts)
  state.socket.on('broadcaster-id', () => {
    if (state.role !== 'viewer') return;

    // Notify broadcaster of our peer ID so they can initiate the media call.
    // Must wait until PeerJS has finished its cloud handshake (peer.open event).
    const notifyBroadcaster = () => {
      state.socket.emit('viewer-joined', {
        roomId: state.roomId,
        peerId: state.peer.id,
      });
    };

    if (state.peerOpen) {
      notifyBroadcaster();
    } else {
      // Peer hasn't opened yet — wait for it, then send
      state.peer.once('open', notifyBroadcaster);
    }
  });

  // Broadcaster receives instruction to call a specific viewer
  state.socket.on('call-viewer', ({ peerId: viewerPeerId }) => {
    if (state.role === 'broadcaster' && state.localStream) {
      callViewer(viewerPeerId);
    }
  });

  // ── Chat ────────────────────────────────────────────────────────────────
  state.socket.on('chat-message', appendMessage);

  // ── Presence ────────────────────────────────────────────────────────────
  state.socket.on('user-joined', ({ username, role }) => {
    appendSystemMessage(`${username} joined as ${role}`);
  });

  state.socket.on('user-left', ({ username }) => {
    appendSystemMessage(`${username} left`);
  });

  state.socket.on('viewer-count', ({ count }) => {
    updateViewerCount(count);
  });

  // ── Broadcast lifecycle ──────────────────────────────────────────────────
  state.socket.on('broadcaster-disconnected', () => {
    if (state.role === 'viewer') {
      dom.videoPlayer.srcObject = null;
      showOverlay('Broadcast ended');
      setLive(false);
      appendSystemMessage('The broadcast has ended.');
    }
  });

  // ── Connection health ────────────────────────────────────────────────────
  state.socket.on('disconnect', (reason) => {
    appendSystemMessage(`Connection lost (${reason}). Reconnecting…`);
  });

  state.socket.on('reconnect', () => {
    appendSystemMessage('Reconnected to server.');
    // Re-join room after reconnect
    state.socket.emit('join-room', {
      roomId:   state.roomId,
      username: state.username,
      role:     state.role,
    });
  });
}

// ---------------------------------------------------------------------------
// PEERJS — create a new Peer instance and wire incoming call handler
// ---------------------------------------------------------------------------
function initPeer() {
  // Uses PeerJS public cloud TURN/STUN server by default.
  // For production, self-host a PeerServer and pass { host, port, path }.
  state.peer = new Peer(undefined, { debug: 1 });

  state.peer.on('open', (id) => {
    console.log('[PeerJS] Peer open, ID:', id);
    state.peerOpen = true;
  });

  // Viewers receive incoming calls from the broadcaster here.
  // The broadcaster never calls back to themselves, so this is viewer-only.
  state.peer.on('call', (call) => {
    if (state.role !== 'viewer') return;

    // Answer without sending a media stream back — viewers only receive
    call.answer();

    call.on('stream', (remoteStream) => {
      dom.videoPlayer.srcObject = remoteStream;
      dom.videoPlayer.muted     = false;

      // Some browsers block autoplay with audio; fall back to muted
      dom.videoPlayer.play().catch(() => {
        dom.videoPlayer.muted = true;
        dom.videoPlayer.play();
        appendSystemMessage('Autoplay blocked — video muted. Click the video to unmute.');
      });

      hideOverlay();
      setLive(true);
      appendSystemMessage('Stream connected.');
    });

    call.on('error', (err) => {
      console.error('[PeerJS] Incoming call error:', err);
      showOverlay('Stream connection error');
    });

    call.on('close', () => {
      showOverlay('Stream ended');
      setLive(false);
    });
  });

  state.peer.on('error', (err) => {
    console.error('[PeerJS] Peer error:', err.type, err);

    // Non-fatal: a viewer we tried to call may have already disconnected
    if (err.type === 'peer-unavailable') return;

    appendSystemMessage(`Connection error: ${err.type}`);
  });

  state.peer.on('disconnected', () => {
    console.warn('[PeerJS] Peer disconnected — attempting reconnect');
    state.peer.reconnect();
  });
}

// ---------------------------------------------------------------------------
// BROADCASTER — call a specific viewer with the local stream
// ---------------------------------------------------------------------------
function callViewer(viewerPeerId) {
  if (!state.localStream || !state.peer) return;

  console.log('[WebRTC] Calling viewer peer:', viewerPeerId);
  const call = state.peer.call(viewerPeerId, state.localStream);

  if (!call) {
    console.warn('[WebRTC] peer.call returned null for peer:', viewerPeerId);
    return;
  }

  call.on('error', (err) => {
    console.warn('[WebRTC] Call error with viewer', viewerPeerId, err);
  });
}

// ---------------------------------------------------------------------------
// BROADCASTER — start broadcast
// ---------------------------------------------------------------------------
dom.startBtn.addEventListener('click', startBroadcast);

async function startBroadcast() {
  dom.startBtn.disabled    = true;
  dom.startBtn.textContent = 'Starting…';

  try {
    // 1. Capture webcam + microphone
    state.localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    dom.startBtn.disabled    = false;
    dom.startBtn.innerHTML   = '<span class="btn-dot">●</span> Start Broadcasting';

    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      alert('Camera/microphone access was denied.\nPlease allow access in your browser settings and try again.');
    } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      alert('No camera or microphone detected.\nPlease connect a device and try again.');
    } else {
      alert(`Could not start broadcast: ${err.message}`);
    }
    return;
  }

  // 2. Play the stream locally (muted to prevent feedback)
  dom.videoPlayer.srcObject = state.localStream;
  dom.videoPlayer.muted     = true;
  dom.videoPlayer.play();

  // 3. Ensure PeerJS is ready before signaling
  if (!state.peerOpen) {
    await new Promise((resolve) => state.peer.once('open', resolve));
  }

  // 4. Register as broadcaster — server will forward peer ID to all viewers
  state.socket.emit('broadcaster-ready', {
    roomId: state.roomId,
    peerId: state.peer.id,
  });

  // 5. Update UI
  dom.startBtn.classList.add('hidden');
  dom.stopBtn.classList.remove('hidden');
  dom.broadcastStats.classList.remove('hidden');
  dom.startBtn.disabled  = false;
  dom.startBtn.innerHTML = '<span class="btn-dot">●</span> Start Broadcasting';

  hideOverlay();
  setLive(true);
  startTimer();
  appendSystemMessage('You are now broadcasting live.');
}

// ---------------------------------------------------------------------------
// BROADCASTER — stop broadcast
// ---------------------------------------------------------------------------
dom.stopBtn.addEventListener('click', stopBroadcast);

function stopBroadcast() {
  // Release all media tracks
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
  }

  dom.videoPlayer.srcObject = null;
  dom.startBtn.classList.remove('hidden');
  dom.stopBtn.classList.add('hidden');
  dom.broadcastStats.classList.add('hidden');

  stopTimer();
  showOverlay('Broadcast stopped');
  setLive(false);
  appendSystemMessage('You stopped the broadcast.');

  // Destroy and recreate the peer so a fresh ID is issued on next broadcast.
  // This ensures existing viewers get a clean 'broadcaster-disconnected' + new ID.
  state.peer.destroy();
  state.peerOpen = false;
  initPeer();
}

// ---------------------------------------------------------------------------
// CHAT — send messages
// ---------------------------------------------------------------------------
dom.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = dom.chatInput.value.trim();
  if (!text || !state.socket?.connected) return;

  state.socket.emit('chat-message', {
    roomId:    state.roomId,
    username:  state.username,
    text,
    timestamp: timeLabel(),
  });

  dom.chatInput.value = '';
});

// Allow Shift+Enter to be ignored (keeps single-line feel), Enter submits
dom.chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    dom.chatForm.dispatchEvent(new Event('submit'));
  }
});

// ---------------------------------------------------------------------------
// Restore session on page refresh (sessionStorage)
// ---------------------------------------------------------------------------
(function restoreSession() {
  const token    = sessionStorage.getItem('ls_token');
  const username = sessionStorage.getItem('ls_username');
  const role     = sessionStorage.getItem('ls_role');

  if (token && username && role) {
    state.username = username;
    state.role     = role;
    state.token    = token;
    enterApp();
  }
})();
