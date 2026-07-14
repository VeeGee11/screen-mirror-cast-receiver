// Screen Mirror custom receiver — low-latency MediaSource playback.
//
// The sender no longer LOADs an HLS URL. Instead it runs a secure WebSocket
// server and pushes a fragmented-MP4 stream (init segment + moof/mdat
// fragments). This receiver opens that WebSocket, feeds the fragments into a
// MediaSource, and renders to a <video> element — giving ~1-2s latency instead
// of HLS's 10-30s. We still start the CAF context so the Cast session launches
// and stays alive (heartbeats), but we do playback ourselves rather than
// through CAF's HLS/DASH player.

const WS_URL = 'wss://cast.badbackpackers.com:8080';

// Start CAF so the platform reports the app running to the sender (the sender's
// LAUNCH waits for that) and the session stays alive. We don't use its
// PlayerManager for media.
const context = cast.framework.CastReceiverContext.getInstance();
const options = new cast.framework.CastReceiverOptions();
options.maxInactivity = 3600; // don't idle-close while mirroring
context.start(options);

const video = document.getElementById('video');
const loading = document.getElementById('loading');
let mediaSource = null;
let sourceBuffer = null;
let queue = [];
let ws = null;

function log() {
  console.log.apply(console, ['[Receiver]'].concat([].slice.call(arguments)));
}

// The #loading spinner is visible by default in the HTML (covers the ~5-8s
// between the Cast session launching and the first real frame decoding), and
// re-shown on stop/disconnect. Only 'playing' hides it — not 'waiting', so a
// brief mid-stream stall/live-edge correction doesn't flicker the overlay in
// and out; this is deliberately scoped to the connect/reconnect black screen.
function showLoading() { if (loading) loading.style.display = 'flex'; }
function hideLoading() { if (loading) loading.style.display = 'none'; }
video.addEventListener('playing', hideLoading);

function setupMediaSource(codecString) {
  const type = 'video/mp4; codecs="' + codecString + '"';
  if (!MediaSource.isTypeSupported(type)) {
    log('codec NOT supported:', type);
    return;
  }
  // Tear down any previous session so a new start rebuilds cleanly.
  teardownPlayback();
  mediaSource = new MediaSource();
  video.src = URL.createObjectURL(mediaSource);
  video.style.visibility = 'visible';
  mediaSource.addEventListener('sourceopen', function () {
    sourceBuffer = mediaSource.addSourceBuffer(type);
    // 'sequence' mode makes each appended fragment play back-to-back regardless
    // of absolute timestamps — the right mode for a continuous live push.
    sourceBuffer.mode = 'sequence';
    sourceBuffer.addEventListener('updateend', pump);
    sourceBuffer.addEventListener('error', function (e) { log('SourceBuffer error', e); });
    log('MediaSource ready:', type);
    pump();
  });
}

// Blank the screen and drop the current MediaSource — used when the sender
// stops mirroring (but stays connected).
function teardownPlayback() {
  queue = [];
  sourceBuffer = null;
  mediaSource = null;
  try { video.removeAttribute('src'); video.load(); } catch (e) {}
  video.style.visibility = 'hidden';
  showLoading();
}

// Append the next queued fragment when the SourceBuffer is idle.
function pump() {
  if (!sourceBuffer || sourceBuffer.updating || queue.length === 0) return;
  const chunk = queue.shift();
  try {
    sourceBuffer.appendBuffer(chunk);
  } catch (e) {
    log('appendBuffer threw', e.name, e.message);
    if (e.name === 'QuotaExceededError') {
      trimBuffer(true);
      queue.unshift(chunk); // retry after trim frees space
    }
  }
}

// Drop buffered data well behind the playhead so memory/latency don't grow
// unbounded. force=true trims aggressively to recover from a quota error.
function trimBuffer(force) {
  if (!sourceBuffer || sourceBuffer.updating || !sourceBuffer.buffered.length) return;
  const start = sourceBuffer.buffered.start(0);
  const cutoff = force ? (video.currentTime - 1) : (video.currentTime - 4);
  if (cutoff > start + 0.5) {
    try { sourceBuffer.remove(start, cutoff); } catch (e) {}
  }
}

function connect() {
  ws = new WebSocket(WS_URL);
  ws.binaryType = 'arraybuffer';
  ws.onopen = function () { log('WebSocket open'); };
  ws.onerror = function () { log('WebSocket error'); };
  ws.onclose = function () { log('WebSocket closed — reconnecting'); showLoading(); setTimeout(connect, 1000); };
  ws.onmessage = function (e) {
    if (typeof e.data === 'string') {
      // Control messages are JSON: {"t":"init","codec":"..."} starts a stream,
      // {"t":"stop"} blanks the screen when the sender stops mirroring.
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { log('bad control msg', e.data); return; }
      if (msg.t === 'init') {
        log('init, codec:', msg.codec);
        setupMediaSource(msg.codec);
      } else if (msg.t === 'stop') {
        log('stop — blanking');
        teardownPlayback();
      }
      return;
    }
    queue.push(new Uint8Array(e.data));
    // Guard against unbounded backlog if appends can't keep up.
    if (queue.length > 300) queue.splice(0, queue.length - 300);
    pump();
  };
}
connect();

// Stay near the live edge and keep playing. Because fragments arrive
// continuously in real time, a small buffer is stable (unlike HLS, seeking to
// near-live here doesn't starve the player — new data is always incoming).
setInterval(function () {
  if (sourceBuffer && !sourceBuffer.updating && sourceBuffer.buffered.length) {
    const end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
    if (end - video.currentTime > 1.4) {
      // Drifted behind — jump forward to ~0.4s behind live. Fragments arrive
      // continuously, so a small cushion stays stable while keeping latency low.
      video.currentTime = end - 0.4;
    }
    trimBuffer(false);
  }
  if (video.paused && video.readyState >= 2) {
    video.play().catch(function () {});
  }
}, 500);

log('Started, connecting to', WS_URL);
