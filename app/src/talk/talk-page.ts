import { TALK_SAMPLE_RATE } from './talk-core';

/**
 * The microphone page: an invisible WKWebView whose origin is the tunnel library's loopback
 * talk endpoint (http://127.0.0.1:<port>, a secure context, so getUserMedia works). It captures
 * the mic with echo cancellation, downsamples to 8 kHz 16-bit mono PCM and streams it over
 * ws://127.0.0.1:<port>/api/talk (tunnel/wgtunnel/talk.go), which encodes it for the camera.
 *
 * RN calls window.__start() / window.__stop(). The page posts JSON to RN:
 *   {type:'loaded'} · {type:'state', value:'idle'|'connecting'|'talking', detail?: codec}
 *   {type:'error', value: 'mic-denied'|'mic-failed'|'closed'|<plain-language reason>}
 * The microphone is only open between __start and __stop (iOS shows its indicator meanwhile).
 */
export function talkPageHtml(): string {
  return `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:transparent">
<script>
(function(){
  var RATE = ${TALK_SAMPLE_RATE};
  var ws = null, stream = null, ctx = null, src = null, proc = null, sink = null, active = false, gen = 0;
  function post(type, value, detail){
    try { window.ReactNativeWebView.postMessage(JSON.stringify({type: type, value: value, detail: detail})); } catch (e) {}
  }

  // Box-filter decimation from the hardware rate (44.1/48 kHz) to 8 kHz, carried across buffers.
  function downsampler(inRate){
    var ratio = inRate / RATE, pos = 0, acc = 0, n = 0;
    return function(input){
      var out = new DataView(new ArrayBuffer(Math.ceil(input.length / ratio + 1) * 2)), o = 0;
      for (var i = 0; i < input.length; i++) {
        acc += input[i]; n++; pos += 1;
        if (pos >= ratio) {
          var s = acc / n;
          s = s < -1 ? -1 : s > 1 ? 1 : s;
          out.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
          o += 2; acc = 0; n = 0; pos -= ratio;
        }
      }
      return out.buffer.slice(0, o);
    };
  }

  function release(){
    try { proc && (proc.onaudioprocess = null, proc.disconnect()); } catch (e) {}
    try { src && src.disconnect(); } catch (e) {}
    try { sink && sink.disconnect(); } catch (e) {}
    try { ctx && ctx.close(); } catch (e) {}
    try { stream && stream.getTracks().forEach(function(t){ t.stop(); }); } catch (e) {}
    var w = ws; ws = null;
    try { w && w.close(); } catch (e) {}
    proc = src = sink = ctx = stream = null;
  }

  function stop(){
    gen++;
    var was = active;
    active = false;
    release();
    if (was) post('state', 'idle');
  }

  function fail(code){
    if (!active) return;
    active = false;
    gen++;
    release();
    post('error', code);
    post('state', 'idle');
  }

  function capture(){
    var AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    src = ctx.createMediaStreamSource(stream);
    proc = ctx.createScriptProcessor(2048, 1, 1);
    var down = downsampler(ctx.sampleRate);
    proc.onaudioprocess = function(e){
      if (!ws || ws.readyState !== 1) return;
      // Drop audio rather than build up a delay if the network falls behind.
      if (ws.bufferedAmount > 32768) return;
      var pcm = down(e.inputBuffer.getChannelData(0));
      if (pcm.byteLength) ws.send(pcm);
    };
    // A silent sink keeps the processor running without playing the mic back.
    sink = ctx.createGain();
    sink.gain.value = 0;
    src.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
  }

  function connect(my){
    var sock = ws = new WebSocket('ws://' + location.host + '/api/talk');
    sock.binaryType = 'arraybuffer';
    sock.onmessage = function(ev){
      if (my !== gen || typeof ev.data !== 'string') return;
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'talk') {
        try { capture(); } catch (e) { fail('mic-failed'); return; }
        post('state', 'talking', m.value);
      } else if (m.type === 'error') {
        fail(m.value || 'closed');
      }
    };
    sock.onclose = function(){ if (my === gen) fail('closed'); };
  }

  window.__start = function(){
    if (active) return;
    active = true;
    var my = ++gen;
    post('state', 'connecting');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { fail('mic-failed'); return; }
    navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1}, video: false})
      .then(function(s){
        if (my !== gen) { s.getTracks().forEach(function(t){ t.stop(); }); return; }
        stream = s;
        connect(my);
      })
      .catch(function(e){ fail(e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'mic-denied' : 'mic-failed'); });
  };
  window.__stop = stop;
  window.addEventListener('pagehide', stop);
  post('loaded');
})();
</script>
</body></html>`;
}
