const images = new Map();
const frameImages = new Map();
const loadingFrames = new Map();

const tintSurfaces = new WeakMap();
const flowSurfaces = new WeakMap();

function flowImage(mask, texture, layer, time) {
  let entry = flowSurfaces.get(layer);
  if (!entry) {
    const canvas = document.createElement("canvas");
    canvas.width = mask.width; canvas.height = mask.height;
    const context = canvas.getContext("2d", {willReadFrequently: true});
    context.drawImage(mask, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const source = document.createElement("canvas");
    source.width = texture.width; source.height = texture.height;
    const sourceContext = source.getContext("2d", {willReadFrequently: true});
    sourceContext.drawImage(texture, 0, 0);
    const raw = sourceContext.getImageData(0, 0, source.width, source.height).data;
    const samples = new Float32Array(source.width * source.height), channel = layer.flowChannel;
    const linear = value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    const srgb = value => value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
    for (let i = 0; i < samples.length; i++) {
      const value = raw[i * 4 + channel] / 255;
      samples[i] = layer.flowColorSpace === 1 && channel < 3 ? linear(value) : value;
    }
    const palette = new Uint8ClampedArray(4096 * 3);
    for (let i = 0; i < 4096; i++)
      for (let c = 0; c < 3; c++)
        palette[i * 3 + c] = Math.round(255 * srgb(i / 4095 * layer.flowColor[c] * layer.flowGain));
    entry = {canvas, context, pixels, samples, palette, tw: source.width, th: source.height, time: null};
    flowSurfaces.set(layer, entry);
  }
  if (entry.time === time) return entry.canvas;
  const {canvas, pixels, samples, palette, tw, th} = entry, w = canvas.width, h = canvas.height;
  const scale = layer.flowScale, offset = layer.flowOffset, speed = layer.flowSpeed;
  const wrap = (value, size) => ((value % size) + size) % size;
  const xs = Array.from({length: w}, (_, x) => {
    const u = ((x + 0.5) / w * scale[0] + offset[0] + time * speed[0]) * tw - 0.5;
    const ix = Math.floor(u);
    return [wrap(ix, tw), wrap(ix + 1, tw), u - ix];
  });
  for (let y = 0; y < h; y++) {
    const v = (1 - ((1 - (y + 0.5) / h) * scale[1] + offset[1] + time * speed[1])) * th - 0.5;
    const iy = Math.floor(v), y0 = wrap(iy, th) * tw, y1 = wrap(iy + 1, th) * tw, fy = v - iy;
    for (let x = 0; x < w; x++) {
      const [x0, x1, fx] = xs[x];
      const value = (samples[y0 + x0] * (1 - fx) + samples[y0 + x1] * fx) * (1 - fy)
                  + (samples[y1 + x0] * (1 - fx) + samples[y1 + x1] * fx) * fy;
      const lut = Math.min(4095, Math.max(0, Math.round(value * 4095))) * 3, index = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) pixels.data[index + c] = palette[lut + c];
    }
  }
  entry.context.putImageData(pixels, 0, 0);
  entry.time = time;
  return canvas;
}

function tintedImage(image, color) {
  const rgb = color.slice(0, 3).map(value => Math.max(0, Math.min(1, value)));
  if (rgb.every(value => value === 1)) return image;
  let entry = tintSurfaces.get(image);
  if (!entry) {
    const canvas = document.createElement("canvas");
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d", {willReadFrequently: true});
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    entry = {canvas, context, pixels, original: pixels.data.slice(), key: null};
    tintSurfaces.set(image, entry);
  }
  const key = rgb.join(",");
  if (key !== entry.key) {
    // 保留原 alpha，只乘顶点 RGB，避免合成模式污染半透明边缘。
    for (let i = 0; i < entry.original.length; i += 4)
      for (let channel = 0; channel < 3; channel++)
        entry.pixels.data[i + channel] = Math.round(entry.original[i + channel] * rgb[channel]);
    entry.context.putImageData(entry.pixels, 0, 0);
    entry.key = key;
  }
  return entry.canvas;
}

async function loadImage(src) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const image = new Image();
    image.src = attempt ? `${src}${src.includes("?") ? "&" : "?"}retry=${Date.now()}` : src;
    try {
      await image.decode();
      return image;
    } catch (error) {
      if (attempt === 2) throw new Error(`图片载入失败：${src}；${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}

function sequenceSource(layer, time) {
  const frame = Math.floor((time - (layer.start || 0)) * layer.fps + 1e-6);
  if (frame < 0 || (frame >= layer.frames && !layer.holdLast)) return null;
  const src = layer.pattern.replace("{frame}", String(Math.min(frame, layer.frames - 1)).padStart(layer.digits ?? 4, "0"));
  return layer.cacheKey ? `${src}?v=${layer.cacheKey}` : src;
}

export async function prepareFrame(scene, time) {
  const visit = async layers => Promise.all((layers || []).map(async layer => {
    if (layer.type === "sequence") {
      const src = sequenceSource(layer, time);
      if (src && !frameImages.has(src)) {
        if (!loadingFrames.has(src)) loadingFrames.set(src, (async () => {
          try {
            frameImages.set(src, await loadImage(src));
            while (frameImages.size > 12) frameImages.delete(frameImages.keys().next().value);
          } finally {
            loadingFrames.delete(src);
          }
        })());
        await loadingFrames.get(src);
      }
    }
    await visit(layer.children);
  }));
  await visit(scene.layers);
}

export async function prepareScene(scene) {
  await document.fonts.load('32px "GameCN"');
  const visit = async layers => Promise.all((layers || []).map(async layer => {
    if (layer.src && !images.has(layer.src)) images.set(layer.src, await loadImage(layer.src));
    if (layer.flowSrc && !images.has(layer.flowSrc)) images.set(layer.flowSrc, await loadImage(layer.flowSrc));
    await visit(layer.children);
  }));
  await visit(scene.layers);
}

export function sample(keys, time, fallback) {
  if (!keys?.length) return fallback;
  if (time <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (time >= last.time) return last.value;
  const index = keys.findIndex(key => key.time > time);
  const a = keys[index - 1], b = keys[index], span = b.time - a.time;
  if (a.coeff) {
    const dt = time - a.time, c = a.coeff;
    return ((c[0] * dt + c[1]) * dt + c[2]) * dt + c[3];
  }
  const t = (time - a.time) / span;
  if (a.interpolation === "step") return a.value;
  if (a.interpolation === "hermite") {
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * a.value + (t3 - 2 * t2 + t) * span * (a.outTangent ?? 0)
      + (-2 * t3 + 3 * t2) * b.value + (t3 - t2) * span * (b.inTangent ?? 0);
  }
  return a.value + (b.value - a.value) * t;
}

export function rotationAt(layer, time) {
  const base = sample(layer.tracks?.rotation, time, layer.rotation ?? 0);
  const idle = layer.idleRotation;
  return base + (idle ? Math.max(0, time - idle.start) * idle.degreesPerSecond : 0);
}

export function render(canvas, scene, time, {texts = {}, background = "transparent"} = {}) {
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(canvas.width / (scene.width || 1920), canvas.height / (scene.height || 1080));
  const draw = layer => {
    const prop = (name, fallback) => sample(layer.tracks?.[name], time, layer[name] ?? fallback);
    const condition = layer.textCondition;
    if (condition) {
      const targetVal = condition.value ?? condition.defaultText;
      const equal = (texts[condition.key] ?? condition.defaultText) === targetVal;
      if (equal !== (condition.mode === "equals")) return;
    }
    if (layer.visible === false || prop("active", 1) < 0.5 || time < (layer.start ?? 0) || time > (layer.end ?? Infinity)) return;
    ctx.save();
    ctx.translate(prop("x", 0), prop("y", 0));
    ctx.rotate(rotationAt(layer, time) * Math.PI / 180);
    ctx.scale(prop("scaleX", 1), prop("scaleY", 1));
    ctx.globalAlpha *= Math.max(0, Math.min(1, prop("opacity", 1)));
    ctx.globalCompositeOperation = layer.blend === "additive" ? "lighter" : "source-over";
    if (layer.type === "image" || layer.type === "sequence" || layer.type === "flowImage") {
      const src = layer.type === "sequence" ? sequenceSource(layer, time) : layer.src;
      if (!src) { ctx.restore(); return; }
      const image = layer.type === "sequence" ? frameImages.get(src) : images.get(src);
      if (!image) throw new Error(`贴图尚未加载：${layer.src}`);
      const rect = layer.sourceRect || {x: 0, y: 0, width: image.width, height: image.height};
      const w = prop("width", rect.width), h = prop("height", rect.height);
      const base = layer.color || [1, 1, 1, 1];
      const color = ["r", "g", "b"].map((axis, index) => sample(layer.colorTracks?.[axis], time, base[index]));
      ctx.globalAlpha *= base[3] ?? 1;
      const source = layer.type === "flowImage" ? flowImage(image, images.get(layer.flowSrc), layer, time) : tintedImage(image, color);
      const dx = -prop("anchorX", 0) * w, dy = -prop("anchorY", 0) * h;
      ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height, dx, dy, w, h);
    } else if (layer.type === "text") {
      let size = prop("fontSize", 64);
      const value = texts[layer.textKey] ?? layer.text ?? "";
      const fontSpec = () => `${layer.fontStyle || "normal"} ${layer.fontWeight || "normal"} ${size}px ${layer.fontFamily || '"GameCN", sans-serif'}`;
      ctx.font = fontSpec();
      if (layer.fitWidth) {
        const width = Math.max(...String(value).split("\n").map(line => ctx.measureText(line).width));
        size = Math.max(layer.minFontSize || 1, Math.min(size, size * layer.fitWidth / Math.max(width, 1)));
        ctx.font = fontSpec();
      }
      const align = layer.align || "left", baseline = layer.baseline || "top";
      ctx.textAlign = align; ctx.textBaseline = baseline;
      const color = layer.color || [1, 1, 1, 1];
      const fill = layer.colorTracks
        ? `rgb(${["r", "g", "b"].map((axis, index) => Math.round(255 * sample(layer.colorTracks[axis], time, color[index]))).join(",")})`
        : layer.fill || "#ffffff";
      const strokeW = prop("strokeWidth", 0);
      ctx.lineWidth = strokeW; ctx.strokeStyle = layer.stroke || "transparent"; ctx.lineJoin = "round";
      const lines = String(value).split("\n"), advance = size * (layer.lineHeight || 1.2);
      const anchor = baseline === "middle" ? 0.5 : baseline === "bottom" ? 1 : 0;
      const offset = (lines.length - 1) * advance * anchor;
      lines.forEach((line, index) => {
        const y = index * advance - offset;
        if (layer.shadow) {
          const alpha = ctx.globalAlpha;
          ctx.globalAlpha *= prop("shadowOpacity", layer.shadow.opacity ?? 1);
          ctx.fillStyle = layer.shadow.color;
          ctx.fillText(line, layer.shadow.x, y + layer.shadow.y);
          ctx.globalAlpha = alpha;
        }
        if (layer.outline) {
          const alpha = ctx.globalAlpha;
          ctx.globalAlpha *= prop("outlineOpacity", layer.outline.opacity ?? 1);
          ctx.fillStyle = layer.outline.color;
          for (const dx of [-1, 1]) for (const dy of [-1, 1]) ctx.fillText(line, dx * layer.outline.x, y + dy * layer.outline.y);
          ctx.globalAlpha = alpha;
        }
        ctx.fillStyle = fill;
        if (strokeW) ctx.strokeText(line, 0, y);
        ctx.fillText(line, 0, y);
      });
    }
    (layer.children || []).forEach(draw);
    ctx.restore();
  };
  (scene.layers || []).forEach(draw);
  if (background !== "transparent") {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = background === "green" ? "#00ff00" : "#000000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = "source-over";
  }
}
