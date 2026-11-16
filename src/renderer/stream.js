// The hidden stream window: opens the video and audio inputs, hands their frames to the encoder
// thread (stream-worker.mjs), and passes what it encodes to the main process, which sends it.
'use strict';

const api = window.shotready;
const worker = new Worker('stream-worker.mjs', { type: 'module' });
let media = null, live = false;

const report = (m) => api.call('streamReport', m).catch(() => {});

worker.onmessage = (e) => { if (live || e.data.type === 'failed') report(e.data); };
worker.onerror = (e) => { e.preventDefault?.(); report({ type: 'failed', message: e.message || 'the stream thread stopped' }); };

function stop() {
  live = false;
  worker.postMessage({ type: 'stop' });
  media?.getTracks().forEach((t) => t.stop());
  media = null;
}

// The saved device: by its id, else by its name (ids change when Windows forgets a device).
function find(devices, kind, want) {
  if (!want) return null;
  const all = devices.filter((d) => d.kind === kind);
  return all.find((d) => d.deviceId === want.id) || all.find((d) => d.label && d.label === want.label) || null;
}

async function start(cfg) {
  stop();
  live = true;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cam = find(devices, 'videoinput', cfg.video);
    if (cfg.video && !cam) throw new Error(`${cfg.video.label || 'The video device'} is not connected`);
    const video = { ...(cam ? { deviceId: { exact: cam.deviceId } } : {}), width: { ideal: cfg.width }, height: { ideal: cfg.height }, frameRate: { ideal: cfg.fps } };
    let mic = null, soundNote = null;
    if (cfg.audio.mode === 'device') {
      mic = find(devices, 'audioinput', cfg.audio);
      if (!mic) soundNote = `${cfg.audio.label || 'The audio input'} is not connected: no sound`;
    } else if (cfg.audio.mode === 'same') {
      // The sound that belongs to the video device (a capture box or the switcher's USB output).
      const group = cam?.groupId || devices.find((d) => d.kind === 'videoinput')?.groupId;
      mic = devices.find((d) => d.kind === 'audioinput' && d.groupId && d.groupId === group && d.deviceId !== 'default' && d.deviceId !== 'communications') || null;
      if (!mic) soundNote = 'The video device has no sound of its own here, so the computer\'s default audio input is used';
    }
    const wantSound = cfg.audio.mode !== 'none' && (mic || cfg.audio.mode === 'same');
    const audio = wantSound ? { ...(mic ? { deviceId: { exact: mic.deviceId } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 } } : false;
    try {
      media = await navigator.mediaDevices.getUserMedia({ video, audio });
    } catch (e) {
      if (!audio) throw e;
      // The picture matters most: without the audio input the stream still goes out.
      media = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      soundNote = `The audio input could not be opened (${e.message}): no sound`;
    }
    if (!live) { media.getTracks().forEach((t) => t.stop()); media = null; return; }
    const vt = media.getVideoTracks()[0], at = media.getAudioTracks()[0];
    vt.onended = () => { if (live) report({ type: 'failed', message: `${vt.label || 'The video device'} was disconnected` }); };
    if (soundNote) report({ type: 'note', text: soundNote });
    report({ type: 'devices', video: vt.label, audio: at?.label || null });
    const vs = new MediaStreamTrackProcessor({ track: vt }).readable;
    const as = at ? new MediaStreamTrackProcessor({ track: at }).readable : null;
    worker.postMessage({ type: 'start', cfg: { ...cfg.encode, audioWanted: cfg.audio.mode !== 'none' }, video: vs, audio: as },
      [vs, ...(as ? [as] : []), ...(cfg.encode.lut?.data?.buffer ? [cfg.encode.lut.data.buffer] : [])]);
  } catch (e) {
    const why = e.name === 'NotReadableError' ? 'the video device is in use by another program' : e.name === 'NotFoundError' || e.name === 'OverconstrainedError' ? 'no video device was found' : e.name === 'NotAllowedError' ? 'Windows does not let apps use the camera (Settings > Privacy & security > Camera)' : e.message;
    report({ type: 'failed', message: why });
    stop();
  }
}

api.on('stream', (m) => {
  if (m.type === 'start') start(m.cfg);
  else if (m.type === 'stop') stop();
  else if (m.type === 'keyframe') worker.postMessage({ type: 'keyframe' });
});
api.call('streamReady').catch(() => {});
