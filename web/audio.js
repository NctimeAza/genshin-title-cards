const buffers = new Map();
let context, sources = [];

export async function prepareAudio(scene) {
  if (!scene.audio?.length) return;
  context ||= new AudioContext();
  for (const track of scene.audio) {
    if (buffers.has(track.src)) continue;
    const response = await fetch(track.src);
    if (!response.ok) throw new Error(`音效加载失败：${track.src}`);
    buffers.set(track.src, await context.decodeAudioData(await response.arrayBuffer()));
  }
}

export function stopAudio() {
  for (const source of sources) source.stop();
  sources = [];
}

export async function playAudio(scene, time, enabled, volume) {
  stopAudio();
  if (!enabled || !scene.audio?.length) return;
  await prepareAudio(scene);
  await context.resume();
  for (const track of scene.audio) {
    const buffer = buffers.get(track.src), offset = track.offset ?? track.start ?? 0;
    const elapsed = Math.max(0, time - offset), start = (track.sourceStart || 0) + elapsed;
    const length = Math.min((track.duration ?? buffer.duration - (track.sourceStart || 0)) - elapsed,
      scene.duration - Math.max(time, offset));
    if (length <= 0) continue;
    const source = context.createBufferSource(), gain = context.createGain();
    const g = volume * (track.gain ?? 1), startAt = context.currentTime + Math.max(0, offset - time);
    source.buffer = buffer;
    gain.gain.setValueAtTime(g, startAt);
    if (track.fadeOut > 0 && length > 0.02) {
      const fade = Math.min(track.fadeOut, length);
      gain.gain.setValueAtTime(g, startAt + length - fade);
      gain.gain.linearRampToValueAtTime(0, startAt + length);
    }
    source.connect(gain).connect(context.destination);
    source.start(startAt, start, length);
    sources.push(source);
  }
}
