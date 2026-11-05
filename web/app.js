import {prepareScene, prepareFrame, render} from "./render.js?v=1";
import {prepareAudio, playAudio, stopAudio} from "./audio.js?v=1";

const $ = id => document.getElementById(id);
const canvas = $("canvas"), output = document.createElement("canvas");
output.width = 1920; output.height = 1080;
const scenes = (await fetch("scenes.json", {cache: "no-store"}).then(r => r.json())).scenes;
let scene, texts = {}, time = 0, playing = false, previous = 0, exporting = false, cancelled = false;
let frameBusy = false, sceneVersion = 0, updateVersion = 0, sceneReady = false, displayedTime = 0;
const status = message => { $("status").textContent = message; };
const frameBlob = target => new Promise((resolve, reject) => target.toBlob(blob => blob ? resolve(blob) : reject(new Error("无法生成 PNG 帧")), "image/png"));
const saveBlob = (blob, name) => {
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
};
async function post(path, body, binary = false) {
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(path, {method: "POST", headers: {"Content-Type": binary ? "image/png" : "application/json"}, body: binary ? body : JSON.stringify(body)});
      break;
    } catch (error) {
      if (!binary || attempt === 2 || !(error instanceof TypeError)) throw error;
      await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`);
  return data;
}
async function update() {
  const selected = scene, at = time, version = sceneVersion;
  const updateId = ++updateVersion;
  try {
    await prepareFrame(selected, at);
    if (version !== sceneVersion || updateId !== updateVersion) return false;
    render(canvas, selected, at, {texts, background: $("background").value});
    displayedTime = at;
    $("timeline").value = at;
    $("time").textContent = `${at.toFixed(2)} / ${Number(selected.duration).toFixed(2)} s`;
    return true;
  } catch (error) { playing = false; stopAudio(); status(`预览失败：${error.message}`); return false; }
}
function controls() {
  for (const id of ["play", "export", "export-mov", "png"]) $(id).disabled = !scene.available || exporting || !sceneReady;
  for (const id of ["scene", "timeline", "background", "png-background", "fps", "load", "save"]) $(id).disabled = exporting || (id !== "scene" && !sceneReady);
  for (const id of ["include-audio", "volume", "listen-audio"]) $(id).disabled = exporting || !scene.audio?.length || !sceneReady;
  document.querySelectorAll("#text-fields textarea").forEach(input => input.disabled = exporting || !sceneReady);
  $("cancel").hidden = !exporting; $("progress").hidden = !exporting;
  const background = $("background").value;
  $("volume-label").textContent = `音效音量 ${Math.round(Number($("volume").value) * 100)}%`;
  $("fps-note").textContent = scene.layers.some(layer => layer.type === "sequence") ? "特效序列为 30 fps。导出 60 fps 会复用特效帧，文字仍逐帧计算。" : "";
  $("export").textContent = background === "black" ? "导出黑底 MP4" : "导出绿幕 MP4";
}
async function selectScene(id, savedTexts) {
  playing = false; stopAudio(); sceneReady = false; const version = ++sceneVersion; $("play").textContent = "▶"; time = 0;
  scene = scenes.find(item => item.id === id); texts = {};
  $("scene").value = id; $("text-fields").replaceChildren();
  for (const field of scene.textFields || []) {
    texts[field.id] = savedTexts?.[field.id] ?? field.default;
    const label = document.createElement("label"), input = document.createElement("textarea");
    input.rows = String(texts[field.id]).includes("\n") ? 2 : 1;
    input.value = texts[field.id];
    input.addEventListener("input", () => { texts[field.id] = input.value; update(); });
    input.id = `text-${field.id}`; label.htmlFor = input.id; label.textContent = field.label;
    $("text-fields").append(label, input);
  }
  $("timeline").max = scene.duration; $("scene-note").textContent = scene.note || "";
  $("ready").textContent = scene.available ? (scene.statusLabel || "验证版") : "未就绪";
  $("ready").classList.toggle("ready", !!scene.available); $("empty").hidden = !!scene.available;
  $("reference").hidden = !scene.reference;
  if (scene.reference) $("reference").src = scene.reference;
  $("audio-note").textContent = scene.audioNote || (scene.audio?.length ? "使用本地提取的原始音效。" : "独立音效尚未确认，当前模板导出静音。");
  $("download").hidden = true; controls(); status("正在载入模板素材…");
  try {
    await Promise.all([prepareScene(scene), prepareAudio(scene)]);
    if (version !== sceneVersion) return;
    sceneReady = await update(); controls();
    if (sceneReady) status(scene.available ? (scene.note || "预览已就绪，可修改文字并逐帧导出。") : "该模板仍在核对原始素材，暂不开放导出。");
  } catch (error) { scene.available = false; controls(); $("empty").hidden = false; status(`素材加载失败：${error.message}`); }
}
const groups = new Map();
scenes.forEach(item => {
  const g = item.group || "角色身份牌";
  if (!groups.has(g)) { const og = document.createElement("optgroup"); og.label = g; groups.set(g, og); $("scene").append(og); }
  const option = document.createElement("option"); option.value = item.id; option.textContent = item.name;
  groups.get(g).append(option);
});
$("scene").addEventListener("change", () => selectScene($("scene").value));
$("background").addEventListener("change", () => { controls(); update(); });
$("timeline").addEventListener("input", () => { playing = false; stopAudio(); $("play").textContent = "▶"; time = Number($("timeline").value); update(); });
$("play").addEventListener("click", async () => {
  if (playing) { playing = false; stopAudio(); $("play").textContent = "▶"; return; }
  if (time >= scene.duration) time = 0;
  try {
    await prepareFrame(scene, time);
    await playAudio(scene, time, $("include-audio").checked, Number($("volume").value));
    previous = performance.now(); playing = true; $("play").textContent = "Ⅱ";
  } catch (error) { status(`播放失败：${error.message}`); }
});
for (const id of ["include-audio", "volume"]) $(id).addEventListener("input", () => {
  $("volume-label").textContent = `音效音量 ${Math.round(Number($("volume").value) * 100)}%`;
  if (playing) playAudio(scene, time, $("include-audio").checked, Number($("volume").value)).catch(error => status(error.message));
});
$("listen-audio").addEventListener("click", async () => {
  playing = false; $("play").textContent = "▶";
  try { await playAudio(scene, 0, true, Number($("volume").value)); status("正在试听原始出场音效。"); }
  catch (error) { status(`试听失败：${error.message}`); }
});
function animate(now) {
  if (playing && !exporting) {
    time += (now - previous) / 1000;
    if (time >= scene.duration) { time = scene.duration; playing = false; stopAudio(); $("play").textContent = "▶"; }
    if (!frameBusy) { frameBusy = true; update().finally(() => frameBusy = false); }
  }
  previous = now; requestAnimationFrame(animate);
}
$("png").addEventListener("click", async () => {
  playing = false; ++updateVersion; stopAudio(); $("play").textContent = "▶";
  const selected = scene, at = displayedTime, values = {...texts}, background = $("png-background").value;
  time = at;
  try {
    await prepareFrame(selected, at);
    const frame = document.createElement("canvas"); frame.width = output.width; frame.height = output.height;
    render(frame, selected, at, {texts: values, background});
    saveBlob(await frameBlob(frame), `${selected.id}_${at.toFixed(3)}s_${background}.png`);
    status(`已导出当前帧${{transparent: "透明", green: "绿幕", black: "黑底"}[background]} PNG。`);
  } catch (error) { status(`导出失败：${error.message}`); }
});
async function exportVideo(format = "mp4") {
  exporting = true; cancelled = false; playing = false; stopAudio(); $("play").textContent = "▶"; controls(); $("download").hidden = true;
  let task, stage = "启动编码器";
  try {
    const fps = Number($("fps").value), background = format === "prores" ? "transparent" : $("background").value === "black" ? "black" : "green";
    task = await post("/api/export/start", {sceneId: scene.id, fps, background, format, texts, scene, includeAudio: $("include-audio").checked, volume: Number($("volume").value)});
    $("progress").max = task.frames; $("progress").value = 0;
    for (let index = 0; index < task.frames; index++) {
      if (cancelled) throw new Error("已取消导出");
      stage = `读取第 ${index + 1} / ${task.frames} 帧`;
      await prepareFrame(scene, index / fps);
      render(output, scene, index / fps, {texts, background});
      stage = `提交第 ${index + 1} / ${task.frames} 帧`;
      await post(`/api/export/frame?id=${task.taskId}&index=${index}`, await frameBlob(output), true);
      $("progress").value = index + 1; status(`正在渲染 ${index + 1} / ${task.frames} 帧`);
    }
    status(`正在完成 ${format === "prores" ? "透明 MOV" : "MP4"} 编码…`);
    stage = "完成编码";
    const result = await post(`/api/export/finish?id=${task.taskId}`, {}); task = null;
    $("download").href = result.url; $("download").textContent = `下载完成的 ${result.format === "prores" ? "透明 MOV" : "MP4"}`; $("download").hidden = false;
    status(`已保存：${result.path}`);
  } catch (error) {
    if (task) try { await post(`/api/export/abort?id=${task.taskId}`, {}); } catch {}
    console.error(stage, error);
    status(`导出未完成（${stage}）：${error.message}`);
  } finally { exporting = false; controls(); update(); }
}
$("export").addEventListener("click", () => exportVideo());
$("export-mov").addEventListener("click", () => exportVideo("prores"));
$("cancel").addEventListener("click", () => { cancelled = true; status("正在结束当前帧并取消…"); });
$("save").addEventListener("click", () => saveBlob(new Blob([JSON.stringify({sceneId: scene.id, texts, background: $("background").value, pngBackground: $("png-background").value, fps: Number($("fps").value), includeAudio: $("include-audio").checked, volume: Number($("volume").value)}, null, 2)], {type: "application/json"}), `${scene.id}_文字配置.json`));
$("load").addEventListener("change", async event => {
  try {
    const value = JSON.parse(await event.target.files[0].text());
    if (!scenes.some(s => s.id === value.sceneId)) throw new Error("配置引用的模板不存在");
    if (["green", "black", "transparent"].includes(value.background)) $("background").value = value.background;
    if (["green", "black", "transparent"].includes(value.pngBackground)) $("png-background").value = value.pngBackground;
    if ([30, 60].includes(value.fps)) $("fps").value = value.fps;
    $("include-audio").checked = value.includeAudio !== false;
    if (value.volume >= 0 && value.volume <= 1) $("volume").value = value.volume;
    await selectScene(value.sceneId, value.texts); status("已载入文字配置。");
  } catch (error) { status(`加载失败：${error.message}`); }
  event.target.value = "";
});
const initialScene = new URLSearchParams(location.search).get("scene");
await selectScene(scenes.some(s => s.id === initialScene) ? initialScene : scenes[0].id);
requestAnimationFrame(animate);
