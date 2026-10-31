'use strict';
/* Request construction, response validation and the user-triggered generation flow. */

function collectMeta() {
  const recipe = recipesCache.find(item => item.id === $('recipeSelect').value);
  const currentCharacterPrompt = $('characterPrompt').value.trim();
  const linkedCharacters = selectedCharacterIds().map(id => characters().find(character => character.id === id)).filter(character => {
    const prompt = characterPrompt(character);
    return prompt && currentCharacterPrompt.includes(prompt);
  });
  return {
    wordSources: collectedWordSources(Object.fromEntries(WORD_PROMPT_FIELDS.map(field => [field, $(field).value]))),
    title: $('scenePrompt').value.trim().slice(0, 42) || recipe?.name || '未命名镜头',
    scenePrompt: $('scenePrompt').value.trim(), clothingPrompt: $('clothingPrompt').value.trim(), characterPrompt: currentCharacterPrompt,
    characterIds: linkedCharacters.map(character => character.id), characterNames: linkedCharacters.map(character => character.name),
    characterId: linkedCharacters[0]?.id || '', characterName: linkedCharacters[0]?.name || '', artistPrompt: $('artistPrompt').value.trim(),
    positivePrompt: $('positivePrompt').value.trim(), negativePrompt: $('negativePrompt').value.trim(),
    fullPrompt: fullPrompt(), model: $('model').value, size: $('size').value,
    recipeId: recipe?.id || '', category: recipe?.name || '未分类', tags: splitTags($('tags').value),
    steps: Number($('steps').value) || 28, scale: $('scale').value.trim() === '' ? 7 : Number($('scale').value),
    seed: $('seed').value.trim(), sampler: $('sampler').value,
    noiseSchedule: $('noiseSchedule').value, transparentBg: $('transparentBg').checked,
    provider: $('apiMode').value,
    vibes: vibeSupported($('model').value) ? structuredClone(vibeSelection.filter(item => item.enabled !== false)) : []
  };
}

function randomSeed() {
  return Math.floor(Math.random() * 4294967295);
}

function naiRequest(meta) {
  const [width, height] = meta.size.split('x').map(Number);
  const seed = meta.seed !== '' && meta.seed != null ? Number(meta.seed) : randomSeed();
  meta.seed = String(seed);
  const isV5 = meta.model.startsWith('nai-diffusion-5-');
  const caption = prompt => ({ base_caption: prompt, char_captions: [] });
  return {
    input: meta.fullPrompt, model: meta.model, action: 'generate',
    parameters: {
      params_version: isV5 ? 4 : 3, width, height, scale: meta.scale, sampler: meta.sampler,
      steps: meta.steps, n_samples: 1, seed, negative_prompt: meta.negativePrompt,
      noise_schedule: meta.noiseSchedule, qualityToggle: true, ucPreset: 0, legacy: false,
      use_coords: false, v4_prompt: { caption: caption(meta.fullPrompt), use_coords: false, use_order: true },
      v4_negative_prompt: { caption: caption(meta.negativePrompt), use_coords: false, use_order: false },
      ...(isV5 ? {
        qualityPresetId: 'standard', ucPresetId: 'heavy', add_original_image: false,
        characterPrompts: [], reference_image_multiple: [], reference_information_extracted_multiple: [],
        reference_strength_multiple: []
      } : {}),
      ...(isV5 && meta.transparentBg ? { transparent_background: true } : {}),
      ...vibeRequestFields(meta)
    }
  };
}

function isYesNaiImagesEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && ['ynai.rinko.ai', 'nai.rinko.ai'].includes(url.hostname)
      && /^\/v1\/images\/generations\/?$/.test(url.pathname);
  } catch { return false; }
}

function isAuroraImagesEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && url.hostname === 'love.auroralove.cc'
      && /^\/(?:api\/)?(?:v1\/)?images\/generations\/?$/.test(url.pathname);
  } catch { return false; }
}

function proxyRequest(meta, endpoint = $('endpoint').value.trim()) {
  if (meta.seed === '' || meta.seed == null) meta.seed = String(randomSeed());
  if (isYesNaiImagesEndpoint(endpoint)) {
    // YesNAI /docs: NAI settings belong inside nai, not the OpenAI top level.
    const parameters = {
      ...(meta.transparentBg ? { transparent_background: true } : {}),
      ...vibeRequestFields(meta)
    };
    return {
      model: meta.model, prompt: meta.fullPrompt, size: meta.size, n: 1,
      response_format: 'b64_json',
      nai: {
        action: 'generate', steps: meta.steps, scale: meta.scale,
        sampler: meta.sampler, seed: Number(meta.seed),
        negative_prompt: meta.negativePrompt, noise_schedule: meta.noiseSchedule,
        qualityToggle: false, ucPreset: 4,
        ...(Object.keys(parameters).length ? { parameters } : {})
      }
    };
  }
  return {
    model: meta.model, prompt: meta.fullPrompt, negative_prompt: meta.negativePrompt,
    size: meta.size, n: 1, steps: meta.steps, scale: meta.scale,
    sampler: meta.sampler, seed: isAuroraImagesEndpoint(endpoint) ? String(meta.seed) : Number(meta.seed), noise_schedule: meta.noiseSchedule,
    ...(meta.transparentBg ? { transparent_background: true } : {}),
    ...vibeRequestFields(meta)
  };
}

async function b64Blob(base64) {
  if (typeof base64 !== 'string' || base64.length > MAX_IMAGE_BYTES * 1.4) throw new Error('图片数据无效或超过 64 MB 限制');
  const mime = /^data:(image\/(?:png|jpeg|webp));base64,/i.exec(base64)?.[1].toLowerCase() || 'image/png';
  const clean = base64.replace(/^data:[^;]+;base64,/, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

async function parseImageResponse(response, mode, adapter = null) {
  if (!response.ok) throw new Error(explainHttpError(response.status));
  if (adapter) {
    if (adapter.response.format === 'json') {
      const raw = new TextDecoder().decode(await readLimitedResponse(response, MAX_IMAGE_BYTES * 1.4));
      let data;
      try { data = JSON.parse(raw); }
      catch { throw new Error('适配文件要求JSON返回，但接口返回的内容无法解析；请核对返回格式，保留服务商记录，避免重复生图。'); }
      const value = NaiAdapters.imageValue(adapter,data);
      if (adapter.response.encoding === 'base64' || /^data:image\/(?:png|jpeg|webp);base64,/i.test(value)) return validateGeneratedImage(await b64Blob(value));
      return downloadGeneratedImage(value);
    }
    if (adapter.response.format === 'image') return validateGeneratedImage(new Blob([await readLimitedResponse(response)]));
    if (typeof JSZip === 'undefined') throw new Error('ZIP解析组件未加载');
    const zip = await JSZip.loadAsync(await readLimitedResponse(response));
    const entry = Object.values(zip.files).find(item => !item.dir && /\.(?:png|jpe?g|webp)$/i.test(item.name));
    if (!entry) throw new Error('ZIP中没有可读取的PNG、JPEG或WebP图片');
    if (entry._data?.uncompressedSize > MAX_IMAGE_BYTES) throw new Error('图片超过64 MB限制');
    return validateGeneratedImage(await entry.async('blob'));
  }
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('json')) {
    const data = JSON.parse(new TextDecoder().decode(await readLimitedResponse(response, MAX_IMAGE_BYTES * 1.4)));
    const item = data?.images?.[0] || data?.data?.[0] || data;
    if (item?.b64_json || (mode === 'official' && item?.image)) return validateGeneratedImage(await b64Blob(item.b64_json || item.image));
    if (item?.url) return downloadGeneratedImage(item.url);
    throw new Error(data?.message || data?.error?.message || '返回中没有图片数据');
  }
  if (contentType.includes('zip') || (mode === 'official' && !contentType.startsWith('image/'))) {
    if (typeof JSZip === 'undefined') throw new Error('ZIP 解析组件未加载');
    try {
      const zip = await JSZip.loadAsync(await readLimitedResponse(response));
      const name = Object.keys(zip.files).find(fileName => /\.(png|webp)$/i.test(fileName));
      if (!name) throw new Error('压缩包中没有图片');
      const entry = zip.files[name];
      if (entry._data?.uncompressedSize > MAX_IMAGE_BYTES) throw new Error('图片超过 64 MB 限制');
      return validateGeneratedImage(await entry.async('blob'));
    } catch (error) {
      if (error.message.includes('图片')) throw error;
      throw new Error('无法解析 NovelAI 返回的图片包');
    }
  }
  if (contentType.includes('text/event-stream') || contentType.includes('text/plain')) {
    const raw = new TextDecoder().decode(await readLimitedResponse(response, MAX_IMAGE_BYTES * 1.4));
    const candidates = raw.split(/\r?\n/).map(line => line.replace(/^data:\s*/, '').trim()).filter(Boolean);
    for (const candidate of candidates.reverse()) {
      try {
        const data = JSON.parse(candidate);
        const item = data?.data?.[0] || data?.image || data;
        const base64 = item?.b64_json || item?.base64 || item?.image_base64;
        if (base64) return validateGeneratedImage(await b64Blob(base64));
        if (item?.url) return downloadGeneratedImage(item.url);
      } catch {}
    }
    const base64Match = raw.match(/(?:b64_json|image_base64|base64)["']?\s*[:=]\s*["']([A-Za-z0-9+/=]{100,})/i);
    if (base64Match) return validateGeneratedImage(await b64Blob(base64Match[1]));
    throw new Error('站点返回了流式文本，但没有找到可识别的图片数据');
  }
  return validateGeneratedImage(new Blob([await readLimitedResponse(response)], { type: contentType }));
}

async function readLimitedResponse(response, limit = MAX_IMAGE_BYTES) {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('返回数据超过大小限制');
  const reader = response.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const parts = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel(); throw new Error('返回数据超过大小限制'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  return new Blob(parts).arrayBuffer();
}

async function validateGeneratedImage(blob) {
  if (!blob.size || blob.size > MAX_IMAGE_BYTES) throw new Error('返回图片为空或超过 64 MB 限制');
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const png = [137,80,78,71,13,10,26,10].every((byte, i) => head[i] === byte);
  const jpeg = head[0] === 255 && head[1] === 216 && head[2] === 255;
  const webp = String.fromCharCode(...head.slice(0,4)) === 'RIFF' && String.fromCharCode(...head.slice(8,12)) === 'WEBP';
  if (!png && !jpeg && !webp) throw new Error('接口返回的不是有效 PNG、JPG 或 WebP 图片，未归档');
  const image = new Blob([blob], { type: png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp' });
  try { const bitmap = await imageSourceFromBlob(image); if (bitmap.close) bitmap.close(); }
  catch { throw new Error('接口返回的图片已损坏，未归档'); }
  return image;
}

async function downloadGeneratedImage(value) {
  const url = safeHttpUrl(value);
  if (!url) throw new Error('返回的图片链接不是 HTTP/HTTPS 地址');
  const response = await fetch(url, { signal: generationController?.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
  return validateGeneratedImage(new Blob([await readLimitedResponse(response)]));
}

function explainHttpError(status, raw = '', mode = $('apiMode')?.value || 'proxy') {
  const recovery = {
    400: '请求参数不被站点接受；尝试默认采样器、小尺寸，并确认模型名称。',
    401: 'Token 无效或已经过期，请重新复制。',
    402: '账户余额或点数可能不足。',
    403: '当前 Token 没有生图权限，或被站点拒绝。',
    404: mode === 'official'
      ? 'NovelAI 官方接口路径或服务状态异常；官方地址应以 /ai/generate-image 结尾。'
      : '接口路径不存在；第三方站点请检查是否缺少 /v1/images/generations。',
    422: '模型或参数不受支持；请确认该站点已经开放 NAI V5 Full。',
    429: '请求过快或达到额度限制，请稍后再试。'
  }[status] || (status >= 500 ? '服务商服务器异常，请稍后再试。' : '请求没有成功。');
  const detail = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  return `HTTP ${status}：${recovery}${detail ? ` 服务端信息：${detail}` : ''}`;
}

function setStatus(text, type = '', detail = '') {
  $('status').textContent = text;
  $('status').className = `status ${type}`;
  $('statusDetail').textContent = detail;
}

$('generateBtn').onclick = async () => {
  const token = $('token').value.trim();
  const meta = collectMeta();
  for (const id of ['steps', 'scale']) {
    if (!$(id).checkValidity()) { setStatus('参数无效', 'err', id === 'steps' ? '步数须为1–50的整数。' : 'Guidance须为0–20的数字。'); $(id).reportValidity(); return; }
  }
  if (!token) {
    $('apiConfig').open = true;
    setStatus('缺少 Token', 'err', '请在连接设置中填写 Access Token 或 API Key');
    $('token').focus();
    return;
  }
  if (meta.seed !== '' && (!/^\d+$/.test(meta.seed) || Number(meta.seed) > 4294967295)) {
    setStatus('Seed 无效', 'err', '请留空使用随机值，或填写 0–4294967295 的整数。');
    $('seed').focus();
    return;
  }
  const button = $('generateBtn');
  if (generationController) return;
  generationController = new AbortController();
  const controller = generationController;
  let timedOut = false;
  let generatedBlob = null;
  let savedArtworkId = null;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 180000);
  $('cancelGenerateBtn').hidden = false;
  button.disabled = true;
  button.querySelector('span').textContent = '正在生成';
  document.querySelector('.result-sheet').classList.add('generating');
  setStatus('请求已发送', 'run', `${meta.model} · ${meta.size}`);
  try {
    const mode = $('apiMode').value, endpoint = $('endpoint').value.trim();
    const adapter = NaiAdapters.requireFor(endpoint,mode,meta);
    let adaptedBody = null;
    if (adapter) {
      if (meta.seed === '' || meta.seed == null) meta.seed = String(randomSeed());
      adaptedBody = NaiAdapters.build(adapter,meta);
    }
    await prepareVibes(meta, controller.signal, token);
    if (controller.signal.aborted) throw new DOMException('已停止等待', 'AbortError');
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      redirect: adapter ? 'error' : 'follow',
      headers: adapter ? NaiAdapters.headers(adapter,token) : { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, image/png, application/zip' },
      body: JSON.stringify(adapter ? adaptedBody : mode === 'official' || /\/ai\/generate-image\/?$/.test(new URL(endpoint).pathname) ? naiRequest(meta) : proxyRequest(meta,endpoint))
    });
    if (!response.ok) throw new Error(explainHttpError(response.status, await response.text(), mode));
    const blob = await parseImageResponse(response, mode, adapter);
    if (controller.signal.aborted) throw new DOMException('已停止等待', 'AbortError');
    generatedBlob = blob;
    meta.requestedSeed = meta.seed;
    meta.seedSource = 'requested';
    if (blob.type === 'image/png') {
      try {
        const returned = extractNovelAIMetadata(await parsePNG(blob));
        if (returned.seed !== '') { meta.seed = returned.seed; meta.seedSource = 'image-metadata'; }
      } catch { /* Metadata is optional; image decoding has already succeeded. */ }
    }
    if (latestUrl) URL.revokeObjectURL(latestUrl);
    latestUrl = URL.createObjectURL(blob);
    latestArtwork = { ...meta, blob, createdAt: Date.now(), imported: false };
    $('resultImage').src = latestUrl;
    $('resultImage').hidden = false;
    $('emptyStage').hidden = true;
    $('downloadLatest').href = latestUrl;
    $('downloadLatest').download = `NAI_${Date.now()}_${safeFilenamePart(meta.model)}.${blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png'}`;
    $('downloadLatest').hidden = false;
    $('downloadLatestJpeg').hidden = false;
    const id = await dbAdd('artworks', latestArtwork);
    savedArtworkId = id;
    latestArtwork.id = id;
    if (meta.recipeId) {
      const recipe = await dbGet('recipes', meta.recipeId);
      if (recipe) {
        if (!recipe.coverArtworkId) recipe.coverArtworkId = id;
        recipe.lastUsedAt = Date.now();
        recipe.updatedAt = Date.now();
        await dbPut('recipes', recipe);
      }
    }
    setStatus('生成成功，已归档', 'ok', `${meta.category} · ${meta.tags.join(' / ') || '无标签'}${meta.seedSource === 'requested' ? ' · Seed 为请求值，图片未提供实际值' : ''}`);
    await refreshData();
    toast('图片与当次完整参数已保存');
  } catch (error) {
    if (generatedBlob) {
      setStatus(savedArtworkId ? '图片已保存，配方更新未完成' : '图片已生成，但归档失败', 'err', `请先下载当前图片，不要重复生成。若正在使用无痕浏览，请保存原图后改用普通模式。${error.message}`);
      if (savedArtworkId) await refreshData().catch(() => {});
      return;
    }
    if (controller.signal.aborted) {
      setStatus(timedOut ? '等待超时' : '已停止等待', 'err', '服务端可能仍在生成或扣费，请先检查服务商记录，不要立即重复提交。');
      return;
    }
    const networkError = /Failed to fetch|NetworkError|Load failed/i.test(error.message);
    const localOfficial = networkError && $('apiMode').value === 'official' && ['file:', 'edge:'].includes(location.protocol);
    setStatus('生成失败', 'err', localOfficial
      ? '当前从手机本地文件打开，浏览器可能阻断官方接口请求。请用 HTTPS 在线版打开镜头台并重新填写 Token；两处档案不会自动同步，先备份再迁移。若在线版也失败，请检查网络或跨域设置。服务端可能已处理，请先核对记录，避免重复生成。'
      : networkError ? '请求未完成，可能是网络、跨域、证书或地址问题。使用适配文件时请填写不需重定向的最终接口地址。服务端可能已处理，请先检查记录，避免重复生成。' : error.message);
  } finally {
    clearTimeout(timeout);
    generationController = null;
    $('cancelGenerateBtn').hidden = true;
    button.disabled = false;
    button.querySelector('span').textContent = '生成并归档';
    document.querySelector('.result-sheet').classList.remove('generating');
  }
};
$('cancelGenerateBtn').onclick = () => generationController?.abort();

matchMedia('(max-width:1100px)').addEventListener('change', () => {
  if (!db) return;
  renderImageLibrary();
  renderRecipes();
});
