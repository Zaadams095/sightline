/**
 * Minimal go2rtc MSE client (same protocol as go2rtc's video-rtc.js / Frigate's MsePlayer).
 * Runs inside a WKWebView whose origin is the loopback gateway, so the WebSocket is
 * same-origin and authenticated by the gateway. Uses ManagedMediaSource on iOS 17.1+.
 *
 * Posts {type:'state', value:'connecting'|'playing'|'stalled'|'error', detail?} to RN.
 */
export function msePlayerHtml(wsPath: string, opts: { muted: boolean; fit: 'contain' | 'cover' }) {
  return `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
  html,body{margin:0;height:100%;background:#000;overflow:hidden}
  video{width:100%;height:100%;object-fit:${opts.fit};background:#000}
</style></head>
<body>
<video id="v" playsinline autoplay ${opts.muted ? 'muted' : ''} disableremoteplayback></video>
<script>
(function(){
  var t0 = Date.now(), marks = {};
  // Startup timing (ms since the page loaded), reported once playback starts.
  var mark = function(name){ if (marks[name] == null) marks[name] = Date.now() - t0; };
  var post = function(type, value, detail){
    try { window.ReactNativeWebView.postMessage(JSON.stringify({type:type, value:value, detail:detail})); } catch(e){}
  };
  var video = document.getElementById('v');
  var MS = window.ManagedMediaSource || window.MediaSource;
  if (!MS) { post('state','error','MSE not supported on this device'); return; }

  var CODECS = ['avc1.640029','avc1.64002A','avc1.640033','hvc1.1.6.L153.B0','mp4a.40.2','mp4a.40.5','flac','opus'];
  var ws, ms, sb, queue = [], retry = 0, lastProgress = Date.now(), closed = false;
  // Until the first video arrives the camera may still be starting or waiting for a keyframe
  // (several seconds, longer over VPN or cellular); restarting then only starts the wait over.
  var gotData = false, FIRST_DATA_MS = 20000, STALL_MS = 8000;
  // Single-flight reconnects: the watchdog, onclose and onerror can all fire for one failure.
  var reconnectTimer = null, generation = 0;

  function supported(){
    return CODECS.filter(function(c){ return MS.isTypeSupported('video/mp4; codecs="' + c + '"'); }).join(',');
  }

  function connect(){
    var gen = ++generation;
    post('state','connecting');
    queue = []; sb = null; gotData = false;
    lastProgress = Date.now();
    var src = ms = new MS();
    if (window.ManagedMediaSource && MS === window.ManagedMediaSource) {
      video.disableRemotePlayback = true;
      video.srcObject = ms;
    } else {
      video.src = URL.createObjectURL(ms);
    }
    ms.addEventListener('sourceopen', function(){
      // A newer attempt (or stop) replaced this one before it opened.
      if (closed || gen !== generation) return;
      var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + ${JSON.stringify(wsPath)};
      var sock = ws = new WebSocket(url);
      sock.binaryType = 'arraybuffer';
      sock.onopen = function(){ mark('wsOpen'); sock.send(JSON.stringify({type:'mse', value: supported()})); };
      sock.onmessage = function(ev){
        if (sock !== ws) return;
        if (typeof ev.data === 'string') {
          var msg = JSON.parse(ev.data);
          if (msg.type === 'mse') {
            mark('codecs');
            sb = src.addSourceBuffer(msg.value);
            sb.mode = 'segments';
            sb.addEventListener('updateend', pump);
          } else if (msg.type === 'error') {
            post('state','error', msg.value);
          }
          return;
        }
        if (!gotData) { gotData = true; retry = 0; lastProgress = Date.now(); }
        mark('firstData');
        queue.push(ev.data);
        pump();
      };
      sock.onclose = function(){ if (!closed && sock === ws) reconnect(); };
      sock.onerror = function(){ if (sock === ws) post('state','stalled','connection lost'); };
    }, {once:true});
  }

  function pump(){
    if (!sb || sb.updating || queue.length === 0) return;
    try {
      var buf = queue.length === 1 ? queue[0] : concat(queue);
      queue = [];
      sb.appendBuffer(buf);
      lastProgress = Date.now();
    } catch (e) {
      // QuotaExceeded: drop old media and retry.
      trim(0);
    }
    var b = video.buffered;
    if (b.length) {
      var end = b.end(b.length - 1);
      // Stay at the live edge: jump if we drift more than 1.5 s behind.
      if (end - video.currentTime > 1.5) video.currentTime = end - 0.3;
      if (video.paused) video.play().catch(function(){});
      if (end - b.start(0) > 30) trim(end - 10);
    }
  }

  function trim(before){
    if (!sb || sb.updating) return;
    try {
      var b = video.buffered;
      if (b.length) sb.remove(b.start(0), before > 0 ? before : b.end(b.length - 1) - 2);
    } catch(e){}
  }

  function concat(list){
    var len = 0, i, off = 0;
    for (i = 0; i < list.length; i++) len += list[i].byteLength;
    var out = new Uint8Array(len);
    for (i = 0; i < list.length; i++) { out.set(new Uint8Array(list[i]), off); off += list[i].byteLength; }
    return out.buffer;
  }

  function reconnect(){
    if (closed || reconnectTimer) return;
    post('state','stalled','reconnecting');
    // Detach first so closing the old socket doesn't schedule a second reconnect.
    var old = ws; ws = null;
    try { old && old.close(); } catch(e){}
    var delay = Math.min(1000 * Math.pow(2, retry++), 8000);
    reconnectTimer = setTimeout(function(){ reconnectTimer = null; if (!closed) connect(); }, delay);
  }

  video.addEventListener('playing', function(){
    mark('playing');
    marks.t0 = t0;
    post('timing', JSON.stringify(marks));
    post('state','playing');
  });
  setInterval(function(){
    if (!closed && !reconnectTimer && Date.now() - lastProgress > (gotData ? STALL_MS : FIRST_DATA_MS)) { lastProgress = Date.now(); reconnect(); }
  }, 2000);

  window.__setMuted = function(m){ video.muted = m; if (!m) video.play().catch(function(){}); };
  window.__stop = function(){
    closed = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    try { ws && ws.close(); } catch(e){}
  };
  connect();
})();
</script>
</body></html>`;
}
