// Screen Mirror custom receiver — low-latency MediaSource playback.
//
// The sender no longer LOADs an HLS URL. Instead it runs a secure WebSocket
// server and pushes a fragmented-MP4 stream (init segment + moof/mdat
// fragments). This receiver opens that WebSocket, feeds the fragments into a
// MediaSource, and renders to a <video> element — giving ~1-2s latency instead
// of HLS's 10-30s. We still start the CAF context so the Cast session launches
// and stays alive (heartbeats), but we do playback ourselves rather than
// through CAF's HLS/DASH player.

// The sender tells us which host to open the WebSocket to — its own per-device
// hostname (<slug>.cast.badbackpackers.com) — via a custom Cast message sent
// right after launch (see HOST_NAMESPACE). Each phone thus points us back at
// itself specifically, so two phones never fight over one shared DNS record.
// Older senders don't send it, so we fall back to the shared legacy host.
const LEGACY_HOST = 'cast.badbackpackers.com';
const HOST_NAMESPACE = 'urn:x-cast:com.dnovakoff.screenmirror';
let wsHost = null; // resolved from the launch message (or the fallback below)

// Start CAF so the platform reports the app running to the sender (the sender's
// LAUNCH waits for that) and the session stays alive. We don't use its
// PlayerManager for media.
const context = cast.framework.CastReceiverContext.getInstance();
const options = new cast.framework.CastReceiverOptions();
options.maxInactivity = 3600; // don't idle-close while mirroring
// maxInactivity only covers "no sender connected." CAF has a *separate*
// IdleTimeoutManager that watches for actual PlayerManager/media-session
// activity and kills the whole app ~5 minutes in if it sees none — which is
// always, here, since we deliberately bypass PlayerManager and drive
// MediaSource ourselves for latency. Confirmed via CDP: receiver console
// logged "[IdleTimeoutManager] timer expired" at ~300s, at the same moment
// the sender's media socket got dropped/reset — this is what's been causing
// the ~5-minute mirroring drop, not a network or backpressure issue. Per
// Google's own docs, this flag is for exactly this case: a custom player
// that doesn't feed PlayerManager.
options.disableIdleTimeout = true;
// Declare + listen on the custom namespace BEFORE start() — the host message
// can arrive the instant the app reports running, so the listener must already
// be in place.
options.customNamespaces = Object.assign({}, options.customNamespaces);
options.customNamespaces[HOST_NAMESPACE] = cast.framework.system.MessageType.JSON;
context.addCustomMessageListener(HOST_NAMESPACE, function (event) {
  const host = event && event.data && event.data.host;
  if (typeof host === 'string' && host) {
    log('host from sender:', host);
    startConnection(host);
  }
});
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

// (Re)open the WebSocket to `host`. Safe to call again if the sender's real
// host arrives after we'd already fallen back to the legacy one — it tears the
// old socket down and reconnects to the right place.
function startConnection(host) {
  if (host === wsHost && ws) return; // already pointed there
  wsHost = host;
  if (ws) {
    try { ws.onclose = null; ws.close(); } catch (e) {}
    ws = null;
  }
  connect();
}

// --- Connection-failure diagnosis -------------------------------------------
// The TV resolves our hostname through its router, and many routers have
// "DNS rebind protection": they drop any public DNS answer that points at a
// private (LAN) address, which is exactly what our per-device hostname is.
// The browser only reports a generic WebSocket failure, so after a few
// consecutive failed attempts we ask Cloudflare's DNS-over-HTTPS (which
// bypasses the router) what the hostname really resolves to. If it resolves
// to a private address but we still can't connect, tell the user what to do
// right on the TV instead of leaving a silent spinner.
const FAILS_BEFORE_DIAGNOSIS = 3;
let failedAttempts = 0;
let diagnosing = false;

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254);
}

function showHint(text) {
  const el = document.getElementById('loading-hint');
  if (el) el.textContent = text || '';
}

function diagnoseConnectionFailure(host) {
  if (diagnosing) return;
  diagnosing = true;
  const url = 'https://cloudflare-dns.com/dns-query?type=A&name=' + encodeURIComponent(host);
  fetch(url, { headers: { accept: 'application/dns-json' } })
    .then(function (r) { return r.json(); })
    .then(function (json) {
      const answers = (json.Answer || []).filter(function (a) { return a.type === 1; });
      if (answers.length === 0) {
        log('diagnosis: public DNS has no record for', host);
        showHint('Can\u2019t find your phone yet. Stop and start mirroring again.');
      } else if (isPrivateIPv4(answers[0].data)) {
        log('diagnosis: public DNS resolves', host, 'to', answers[0].data, '\u2014 router may be blocking it');
        showHint('Can\u2019t reach your phone. Your Wi-Fi router may be blocking local addresses in DNS. ' +
          'On this Chromecast: Settings \u2192 Network & Internet \u2192 Advanced \u2192 Private DNS \u2192 ' +
          'enter one.one.one.one, then start mirroring again.');
      } else {
        showHint('Can\u2019t reach your phone. Make sure it is on the same Wi-Fi as this Chromecast.');
      }
    })
    .catch(function (e) { log('diagnosis failed', e && e.message); })
    .then(function () { diagnosing = false; });
}

function connect() {
  if (!wsHost) return; // nothing to connect to yet
  const openedAt = Date.now();
  let didOpen = false;
  ws = new WebSocket('wss://' + wsHost + ':8080');
  ws.binaryType = 'arraybuffer';
  ws.onopen = function () {
    log('WebSocket open');
    didOpen = true;
    failedAttempts = 0;
    showHint('');
  };
  ws.onerror = function () { log('WebSocket error'); };
  // code/reason distinguish a graceful sender-side close (1000/1001 with our
  // own reason string) from the platform/browser tearing the socket down on
  // us (1006 abnormal closure, no reason) — logged with uptime so repeated
  // fixed-duration drops show up as a pattern instead of a mystery.
  ws.onclose = function (event) {
    log('WebSocket closed — reconnecting', 'code:', event.code, 'reason:', event.reason || '(none)', 'uptimeMs:', Date.now() - openedAt);
    showLoading();
    if (!didOpen && ++failedAttempts >= FAILS_BEFORE_DIAGNOSIS) diagnoseConnectionFailure(wsHost);
    setTimeout(connect, 1000);
  };
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

// If the sender never identifies its host (older app build that predates the
// per-device hostname handoff), fall back to the shared legacy record so those
// installs keep working through the rollout.
setTimeout(function () {
  if (!wsHost) {
    log('no host message — falling back to', LEGACY_HOST);
    startConnection(LEGACY_HOST);
  }
}, 3000);

// Stay near the live edge without visible jumps. The previous approach did a
// hard seek to end-0.4s whenever drift exceeded 1.4s — but this pipeline's
// real end-to-end latency (capture/encode/network) is consistently more than
// that, so right after the seek there was almost no buffer ahead of the
// playhead. Playback immediately caught up to the buffered edge and stalled
// waiting for the next fragment (~2s), and during that stall the backlog
// grew again, drift exceeded 1.4s again, and it seeked again — a
// self-sustaining play/stall oscillation, seen as a repeating "jump 2s, pause
// 2s" pattern. Nudging playbackRate instead closes the gap gradually with no
// visible jump or stall — the standard technique for low-latency live
// players. A hard seek is kept only as a one-time recovery for drift large
// enough that playbackRate alone would take too long to close (e.g. right
// after a stall or reconnect), and lands with real cushion instead of
// end-0.4 so it doesn't immediately re-trigger the same stall.
setInterval(function () {
  if (sourceBuffer && !sourceBuffer.updating && sourceBuffer.buffered.length) {
    const end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
    const drift = end - video.currentTime;
    if (drift > 4) {
      video.currentTime = end - 1.5;
      video.playbackRate = 1.0;
    } else if (drift > 0.8) {
      // Lower trigger (was 1.4) + faster catch-up rate (was 1.15) tighten the
      // steady-state gap the oscillation used to settle around — still well
      // within the range players like YouTube/Twitch use for live catch-up
      // without being noticeable.
      video.playbackRate = 1.25;
    } else {
      video.playbackRate = 1.0;
    }
    trimBuffer(false);
  }
  if (video.paused && video.readyState >= 2) {
    video.play().catch(function () {});
  }
}, 500);

log('Started; awaiting host from sender (fallback:', LEGACY_HOST + ')');
