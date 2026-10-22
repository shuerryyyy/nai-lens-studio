'use strict';
/* Original-image decoding, PNG/EXIF/XMP and stealth metadata. No interface initialization. */

async function imageSourceFromBlob(blob) {
  if ('createImageBitmap' in window) return createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    if (image.decode) await image.decode();
    else await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function readNullTerminated(bytes, start) {
  let end = start;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return { bytes: bytes.slice(start, end), next: end + 1 };
}

async function inflateText(bytes) {
  if (typeof DecompressionStream === 'undefined') return '';
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new TextDecoder('utf-8').decode(await readLimitedResponse(new Response(stream), 2 * 1024 * 1024));
}

function decodeText(bytes) {
  return new TextDecoder('utf-8').decode(bytes).replace(/\u0000+$/g, '');
}

async function parsePNG(file) {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('PNG 超过 64 MB 限制');
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)) throw new Error('请选择 PNG 图片');
  const text = Object.create(null);
  let width = 0;
  let height = 0;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (offset + 12 + length > bytes.length) throw new Error('PNG 文件不完整');
    const type = new TextDecoder('ascii').decode(bytes.slice(offset + 4, offset + 8));
    const data = bytes.slice(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      if (length < 13) throw new Error('PNG 尺寸信息损坏');
      width = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
      height = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4);
    }
    if (type === 'tEXt') {
      if (length > 2 * 1024 * 1024) { text.ReadWarning = '文本元数据过大，已跳过该文本块'; offset += length + 12; continue; }
      const keyPart = readNullTerminated(data, 0);
      text[decodeText(keyPart.bytes)] = decodeText(data.slice(keyPart.next));
    }
    if (type === 'zTXt') {
      const keyPart = readNullTerminated(data, 0);
      try { text[decodeText(keyPart.bytes)] = await inflateText(data.slice(keyPart.next + 1)); } catch {}
    }
    if (type === 'iTXt') {
      const keyword = readNullTerminated(data, 0);
      const compressed = data[keyword.next] === 1;
      let cursor = keyword.next + 2;
      const language = readNullTerminated(data, cursor); cursor = language.next;
      const translated = readNullTerminated(data, cursor); cursor = translated.next;
      try {
        text[decodeText(keyword.bytes)] = compressed ? await inflateText(data.slice(cursor)) : decodeText(data.slice(cursor));
      } catch {}
    }
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return { text, width, height };
}

function splitPrompt(prompt) {
  const parts = [];
  let current = '';
  let depth = 0;
  for (const character of String(prompt || '')) {
    if ('{[('.includes(character)) depth++;
    if ('}])'.includes(character)) depth = Math.max(0, depth - 1);
    if (character === ',' && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function extractArtistPrompt(prompt) {
  const parts = splitPrompt(prompt);
  const artists = parts.filter(part => /(?:^|[\s{[(])artist\s*:|^by\s+|artist[_-]?name/i.test(part));
  return { artist: artists.join(', '), remaining: parts.filter(part => !artists.includes(part)).join(', ') };
}

function normalizeModel(value = '') {
  const model = String(value).toLowerCase();
  if (model.includes('4.5') || model.includes('4-5')) return model.includes('curated') ? 'nai-diffusion-4-5-curated' : 'nai-diffusion-4-5-full';
  if (/(?:diffusion[\s-]*|\bv)5\b/.test(model)) return model.includes('curated') ? 'nai-diffusion-5-curated' : 'nai-diffusion-5-full';
  if (/(?:diffusion[\s-]*|\bv)4\b/.test(model)) return model.includes('curated') ? 'nai-diffusion-4-curated' : 'nai-diffusion-4-full';
  return model.includes('v3') || model.includes('diffusion-3') ? 'nai-diffusion-3' : '';
}

function extractNovelAIMetadata(png) {
  const json = flattenImageMetadata(png.text);
  const prompt = metadataText(json.prompt, json.input, json.description, json.v4_prompt?.caption?.base_caption, json.Description, png.text.Description, png.text.description);
  const negative = metadataText(json.uc, json.negative_prompt, json.negativePrompt, json.v4_negative_prompt?.caption?.base_caption, json.Negative, png.text.Negative);
  const split = extractArtistPrompt(prompt);
  const model = normalizeModel(json.model || json.source || json.Source || json.Software || png.text.Source || png.text.Software || '');
  const width = Number(json.width) || png.width;
  const height = Number(json.height) || png.height;
  const scale = Number(json.scale ?? json.cfg_scale ?? 7);
  return {
    rawPrompt: prompt, artistPrompt: split.artist, positivePrompt: split.remaining,
    negativePrompt: negative, model, size: width && height ? `${width}x${height}` : '',
    steps: Number(json.steps) || 28, scale: Number.isFinite(scale) ? scale : 7,
    seed: json.seed !== undefined ? String(json.seed) : '', sampler: json.sampler || 'k_euler_ancestral',
    noiseSchedule: json.noise_schedule || json.noiseSchedule || 'karras', raw: { ...png.text, parsed: json }
  };
}

function metadataText(...values) { return values.find(value => typeof value === 'string' && value.trim()) || ''; }
function flattenImageMetadata(textMap) {
  const result = Object.create(null);
  const visit = (value, depth) => {
    if (depth > 6 || !value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, item] of Object.entries(value)) if (!['__proto__', 'constructor', 'prototype'].includes(key)) result[key] = item;
    for (const key of ['Comment', 'comment', 'parameters', 'generation', 'metadata', 'data']) {
      let nested = value[key];
      if (typeof nested === 'string' && nested.length < 2 * 1024 * 1024) { try { nested = JSON.parse(nested); } catch { continue; } }
      visit(nested, depth + 1);
    }
  };
  visit(textMap, 0);
  for (const value of Object.values(textMap)) if (typeof value === 'string' && value.length < 2 * 1024 * 1024) { try { visit(JSON.parse(value), 0); } catch {} }
  return result;
}

/* TIFF UserComment is used by JPEG/WebP exporters. All offsets are bounded. */
function readExifText(bytes, text) {
  if (bytes.length >= 6 && decodeText(bytes.subarray(0, 4)) === 'Exif') bytes = bytes.subarray(6);
  if (bytes.length < 8) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = bytes[0] === 73 && bytes[1] === 73;
  if (!little && !(bytes[0] === 77 && bytes[1] === 77)) return;
  if (view.getUint16(2, little) !== 42) return;
  const visited = new Set();
  const readIFD = (offset, depth) => {
    if (depth > 3 || offset < 8 || offset + 2 > bytes.length || visited.has(offset)) return;
    visited.add(offset);
    const count = Math.min(view.getUint16(offset, little), 1024);
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12; if (entry + 12 > bytes.length) break;
      const tag = view.getUint16(entry, little), type = view.getUint16(entry + 2, little), units = view.getUint32(entry + 4, little);
      if (tag === 34665) { readIFD(view.getUint32(entry + 8, little), depth + 1); continue; }
      if (![270, 305, 37510, 40092].includes(tag)) continue;
      const size = units * ({ 1: 1, 2: 1, 3: 2, 4: 4, 7: 1 }[type] || 0);
      const start = size <= 4 ? entry + 8 : view.getUint32(entry + 8, little);
      if (!size || size > 2 * 1024 * 1024 || start + size > bytes.length) continue;
      let data = bytes.subarray(start, start + size), encoding = 'utf-8';
      if (tag === 37510 && data.length >= 8) {
        const prefix = decodeText(data.subarray(0, 8)); data = data.subarray(8);
        if (prefix.startsWith('UNICODE')) encoding = little ? 'utf-16le' : 'utf-16be';
      }
      if (tag === 40092) encoding = 'utf-16le';
      const value = new TextDecoder(encoding).decode(data).replace(/\0+$/, '');
      text[tag === 305 ? 'Software' : tag === 270 ? 'Description' : 'Comment'] = value;
    }
  };
  readIFD(view.getUint32(4, little), 0);
}
function readXmpText(bytes, text) {
  if (bytes.length > 2 * 1024 * 1024) return;
  const xml = decodeText(bytes), start = xml.indexOf('<'); if (start < 0) return;
  const doc = new DOMParser().parseFromString(xml.slice(start), 'application/xml');
  for (const node of doc.getElementsByTagName('*')) {
    if (['UserComment', 'Comment', 'Description', 'description'].includes(node.localName) && node.textContent.trim()) text[node.localName === 'description' ? 'Description' : node.localName] = node.textContent.trim();
  }
}
async function readStealthMetadata(source) {
  if (source.width * source.height > 32 * 1024 * 1024) throw new Error('图片超过 3200 万像素，已跳过像素级隐写读取');
  const canvas = document.createElement('canvas'); canvas.width = source.width; canvas.height = source.height;
  const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(source, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const capacity = canvas.width * canvas.height;
  let cursor = 0;
  const read = count => {
    if (cursor + count * 8 > capacity) throw new Error('隐写信息不完整');
    const bytes = new Uint8Array(count);
    for (let i = 0; i < count; i++) for (let bit = 0; bit < 8; bit++, cursor++) {
      const pixel = (cursor % canvas.height) * canvas.width + Math.floor(cursor / canvas.height);
      bytes[i] = (bytes[i] << 1) | (pixels[pixel * 4 + 3] & 1);
    }
    return bytes;
  };
  if (capacity < 152) return null;
  const signature = decodeText(read(15));
  if (!['stealth_pngcomp', 'stealth_pnginfo'].includes(signature)) return null;
  const bitLength = new DataView(read(4).buffer).getUint32(0);
  if (bitLength % 8 || bitLength / 8 > 2 * 1024 * 1024) throw new Error('隐写信息长度无效或过大');
  const bytes = read(bitLength / 8);
  if (signature === 'stealth_pnginfo') return JSON.parse(decodeText(bytes));
  if (typeof DecompressionStream === 'undefined') throw new Error('此浏览器不支持解压隐写信息，请使用新版浏览器');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(decodeText(new Uint8Array(await readLimitedResponse(new Response(stream), 2 * 1024 * 1024))));
}
async function readImageMetadata(file) {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('图片超过 64 MB');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const png = bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v);
  const webp = decodeText(bytes.subarray(0, 4)) === 'RIFF' && decodeText(bytes.subarray(8, 12)) === 'WEBP';
  const jpeg = bytes[0] === 255 && bytes[1] === 216;
  if (!png && !webp && !jpeg) throw new Error('请选择 PNG、WebP 或 JPEG 图片');
  const metadata = png ? await parsePNG(file) : { text: Object.create(null), width: 0, height: 0 };
  if (webp) {
    const view = new DataView(bytes.buffer);
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = decodeText(bytes.subarray(offset, offset + 4)), length = view.getUint32(offset + 4, true);
      if (offset + 8 + length > bytes.length) throw new Error('WebP 文件不完整');
      const chunk = bytes.subarray(offset + 8, offset + 8 + length);
      if (type === 'EXIF') readExifText(chunk, metadata.text);
      if (type === 'XMP ') readXmpText(chunk, metadata.text);
      offset += 8 + length + (length % 2);
    }
  }
  if (jpeg) {
    const view = new DataView(bytes.buffer);
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset] !== 255) break;
      const marker = bytes[offset + 1]; if (marker === 218 || marker === 217) break;
      if (marker === 255) { offset++; continue; }
      if (marker === 1 || marker >= 208 && marker <= 215) { offset += 2; continue; }
      const length = view.getUint16(offset + 2); if (length < 2 || offset + 2 + length > bytes.length) throw new Error('JPEG 文件不完整');
      const chunk = bytes.subarray(offset + 4, offset + 2 + length);
      if (marker === 225) { if (decodeText(chunk.subarray(0, 4)) === 'Exif') readExifText(chunk, metadata.text); else readXmpText(chunk, metadata.text); }
      if (marker === 254 && chunk.length < 2 * 1024 * 1024) metadata.text.Comment = decodeText(chunk);
      offset += length + 2;
    }
  }
  const source = await imageSourceFromBlob(file);
  try {
    metadata.width ||= source.width; metadata.height ||= source.height;
    const parsed = flattenImageMetadata(metadata.text);
    if ((png || webp) && !metadataText(parsed.prompt, parsed.input, parsed.v4_prompt?.caption?.base_caption, metadata.text.Description)) {
      try {
        const hidden = await readStealthMetadata(source);
        if (hidden && typeof hidden === 'object') metadata.text.Stealth = JSON.stringify(hidden);
      } catch (error) { metadata.text.ReadWarning = error.message; }
    }
  } finally { source.close?.(); }
  return metadata;
}
