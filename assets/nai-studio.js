'use strict';
document.documentElement.dataset.v2 = 'loaded';
clearTimeout(window.__naiBootTimer);
const bootNotice = document.getElementById('bootError');
if (bootNotice) bootNotice.hidden = true;

const $ = id => document.getElementById(id);
const icon = id => `<svg class="icon sm"><use href="#i-${id}"/></svg>`;
const SETTINGS_KEY = 'nai_studio_settings_v1';
const STEPS_28_MIGRATION_KEY = 'nai_studio_steps_28_v1';
const WORDS_KEY = 'nai_studio_words_v1';
const CHARACTERS_KEY = 'nai_studio_characters_v1';
const THEME_KEY = 'nai_studio_theme_v1';
const TOKEN_KEY = 'nai_studio_token_v1';
const API_PRESETS_KEY = 'nai_studio_api_presets_v1';
const DEVICE_ID_KEY = 'nai_studio_device_id_v1';
const MIGRATION_KEY = 'nai_studio_recipe_migration_v2';
const AUTO_SCENE_TAG_KEY = 'nai_studio_auto_scene_tag_v1';
const DB_NAME = 'nai_shot_studio';
const DB_VERSION = 4;

let db;
let recipesCache = [];
let artworksCache = [];
let currentRecipe = null;
let restoredRecipeId = null;
let currentGalleryRecipeId = '';
let currentImage = null;
let pendingImport = null;
let latestUrl = '';
let latestArtwork = null;
let galleryUrls = [];
let libraryUrls = [];
let pickerKind = '';
let pickerTargetId = '';
let pickerItems = [];
let pickerCharacterSelection = new Set();
let expandedWordId = '';
let pendingBackupImport = null;
let artworkSelectionMode = false;
let selectedArtworkIds = new Set();
let batchMoveActive = false;
let imagePreviewUrl = '';
let importPreviewUrl = '';
let generationController = null;
let restoreInProgress = false;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const WORD_KINDS = ['scene', 'artist', 'positive', 'negative', 'bundle'];

function normalizeLibraryRecord(record, type, strict = false) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('备份中存在无效记录');
  const result = { ...record };
  result.id = String(record.id ?? makeId());
  for (const key of ['folderId', 'name', 'content', 'fullPrompt', 'artistPrompt', 'positivePrompt', 'negativePrompt', 'scenePrompt', 'characterPrompt', 'sourcePrompt', 'title', 'category', 'note', 'author', 'sourceUrl', 'transferId', 'recipeId', 'characterId', 'model', 'size', 'sampler', 'noiseSchedule', 'gender', 'hair', 'eyes', 'skin', 'body', 'features', 'outfit', 'naturalAppearance']) {
    if (key in result && typeof result[key] !== 'string') result[key] = String(result[key] ?? '');
  }
  result.tags = Array.isArray(record.tags) ? record.tags.filter(tag => typeof tag === 'string') : splitTags(record.tags);
  if (Array.isArray(record.characterIds)) result.characterIds = record.characterIds.map(String);
  if (type === 'word') {
    if (!WORD_KINDS.includes(record.kind) && strict) throw new Error('备份包含不支持的散词类型');
    result.kind = WORD_KINDS.includes(record.kind) ? record.kind : 'artist';
    if (result.bundle && typeof result.bundle === 'object') result.bundle = Object.fromEntries(['artistPrompt', 'positivePrompt', 'negativePrompt'].map(key => [key, String(result.bundle[key] ?? '')]));
  }
  return result;
}

function readLocalLibrary(key, type) {
  try {
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(list) ? list.filter(item => item && typeof item === 'object').map(item => normalizeLibraryRecord(item, type)) : [];
  } catch { return []; }
}

const fields = [
  'scenePrompt', 'characterPrompt', 'characterSelectIds', 'artistPrompt', 'positivePrompt', 'negativePrompt', 'model',
  'size', 'recipeSelect', 'tags', 'steps', 'scale', 'seed', 'sampler',
  'noiseSchedule', 'transparentBg', 'apiMode', 'endpoint', 'rememberToken', 'gallerySort', 'librarySort'
];

function toast(message) {
  const element = $('toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 2400);
}

function splitTags(value) {
  return [...new Set(String(value || '').split(/[，,、]/).map(item => item.trim()).filter(Boolean))];
}

function setAutoSceneTag(name = '') {
  const previous = localStorage.getItem(AUTO_SCENE_TAG_KEY) || '';
  const tags = splitTags($('tags').value).filter(tag => tag !== previous);
  if (name && !tags.includes(name)) tags.push(name);
  $('tags').value = tags.join(', ');
  if (name) localStorage.setItem(AUTO_SCENE_TAG_KEY, name);
  else localStorage.removeItem(AUTO_SCENE_TAG_KEY);
}

function debounce(callback, delay = 120) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), delay);
  };
}

function searchableText(...values) {
  return values.flat(Infinity).filter(Boolean).join(' ').toLowerCase();
}

function normalizeRecordText(value = '') {
  return String(value).normalize('NFKC').toLowerCase().replace(/[，、]/g, ',').replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ').trim();
}

function recipeContentKey(item = {}) {
  const parts = ['artistPrompt', 'positivePrompt', 'negativePrompt'].map(key => normalizeRecordText(item[key]));
  return parts.some(Boolean) ? parts.join('\u241f') : '';
}

function wordContentKey(item = {}) {
  if (item.kind === 'bundle') {
    const bundle = bundleData(item);
    return `bundle\u241f${recipeContentKey(bundle)}`;
  }
  const content = normalizeRecordText(item.content);
  return content ? `${item.kind || ''}\u241f${content}` : '';
}

function characterContentKey(item = {}) {
  const prompt = normalizeRecordText(characterPrompt(item));
  const name = normalizeRecordText(item.name);
  return prompt || name ? `${name}\u241f${prompt}` : '';
}

function escapeHTML(value = '') {
  return String(value).replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[character]));
}

function safeHttpUrl(value = '') {
  try {
    const url = new URL(String(value).trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function makeId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function samplerName(value = '') {
  return ({ k_euler_ancestral: 'Euler A', k_euler: 'Euler', k_dpmpp_2m: 'DPM++ 2M' })[value] || value;
}

function shortModel(model = '') {
  return String(model).replace(/^nai-diffusion-4-5/, 'V4.5').replace(/^nai-diffusion-(\d+)/, 'V$1').replaceAll('-', ' ');
}

function showDialog(id) {
  const dialog = $(id);
  if (!dialog.open) dialog.showModal();
}

function closeDialog(id) {
  const dialog = $(id);
  if (dialog?.open) dialog.close();
}

document.querySelectorAll('[data-close-dialog]').forEach(button => {
  button.addEventListener('click', () => closeDialog(button.dataset.closeDialog));
});

document.querySelectorAll('dialog').forEach(dialog => {
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    if (dialog.id === 'imageDialog') {
      if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
      imagePreviewUrl = '';
      $('imageDialogPreview').removeAttribute('src');
    }
    if (dialog.id === 'imageImportDialog') {
      if (importPreviewUrl) URL.revokeObjectURL(importPreviewUrl);
      importPreviewUrl = '';
      pendingImport = null;
      $('importPreview').removeAttribute('src');
    }
  });
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
});

const themeNames = { studio: '曝光台', berry: '月莓夜', ocean: '深海蓝', honey: '蜜糖棕' };

function applyTheme(theme, announce = false) {
  const safeTheme = themeNames[theme] ? theme : 'studio';
  document.documentElement.dataset.theme = safeTheme;
  localStorage.setItem(THEME_KEY, safeTheme);
  document.querySelectorAll('[data-theme-choice]').forEach(button => {
    button.classList.toggle('active', button.dataset.themeChoice === safeTheme);
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === safeTheme));
  });
  if (announce) toast(`已切换为“${themeNames[safeTheme]}”`);
}

document.querySelectorAll('[data-theme-toggle]').forEach(button => button.onclick = () => {
  applyTheme(document.documentElement.dataset.theme || 'studio');
  showDialog('themeDialog');
});
document.querySelectorAll('[data-theme-choice]').forEach(button => button.onclick = () => {
  applyTheme(button.dataset.themeChoice, true);
  closeDialog('themeDialog');
});

async function copyText(text, button, message = '已复制') {
  if (!text) {
    toast('这里还没有内容');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const fallback = document.createElement('textarea');
    fallback.value = text;
    fallback.style.position = 'fixed';
    fallback.style.opacity = '0';
    document.body.appendChild(fallback);
    fallback.select();
    document.execCommand('copy');
    fallback.remove();
  }
  if (button) {
    button.classList.add('copied');
    setTimeout(() => button.classList.remove('copied'), 1200);
  }
  toast(message);
}

document.querySelectorAll('.copy-btn[data-copy]').forEach(button => {
  button.addEventListener('click', () => copyText($(button.dataset.copy).value, button));
});

function fullPrompt() {
  return [$('positivePrompt').value.trim(), $('characterPrompt').value.trim(), $('scenePrompt').value.trim(), $('artistPrompt').value.trim()]
    .filter(Boolean).join(', ');
}

function updateAdvancedSummary() {
  $('advancedSummary').textContent = `${$('steps').value || 28} Steps · Guidance ${$('scale').value || 7} · ${samplerName($('sampler').value)} · ${$('noiseSchedule').value || 'karras'}`;
}

function saveSettings() {
  const data = {};
  fields.forEach(id => {
    const element = $(id);
    if (!element) return;
    data[id] = element.type === 'checkbox' ? element.checked : element.value;
  });
  data.wordSources = collectedWordSources(data);
  trackedWordSources = data.wordSources;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
  if ($('rememberToken').checked) localStorage.setItem(TOKEN_KEY, $('token').value);
  else localStorage.removeItem(TOKEN_KEY);
  updateApiStatus();
  updateAdvancedSummary();
}

function loadSettings() {
  let data = {};
  try { data = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch {}
  restoredRecipeId = String(data.recipeSelect || '');
  if (!localStorage.getItem(STEPS_28_MIGRATION_KEY)) {
    if (data.steps === undefined || Number(data.steps) === 23) data.steps = '28';
    localStorage.setItem(STEPS_28_MIGRATION_KEY, new Date().toISOString());
  }
  fields.forEach(id => {
    const element = $(id);
    if (!element || data[id] === undefined) return;
    if (element.type === 'checkbox') element.checked = Boolean(data[id]);
    else element.value = data[id];
  });
  trackedWordSources = Array.isArray(data.wordSources) ? data.wordSources.filter(source => source && WORD_PROMPT_FIELDS.includes(source.field) && typeof source.content === 'string') : [];
  if (data.rememberToken) $('token').value = localStorage.getItem(TOKEN_KEY) || '';
  updateActiveCharacterLabel();
  updateApiStatus();
  updateModelUI();
  updateAdvancedSummary();
}

function updateApiStatus() {
  const preset = apiPresets().find(item => item.id === $('apiPresetSelect')?.value);
  $('apiStatus').textContent = $('token').value
    ? (preset ? `${preset.name} · 已就绪` : 'Token 已填写')
    : (preset ? `${preset.name} · 缺少 Token` : '尚未配置 Token');
}

function apiPresets() {
  try { return JSON.parse(localStorage.getItem(API_PRESETS_KEY) || '[]'); } catch { return []; }
}

function saveApiPresets(list) {
  localStorage.setItem(API_PRESETS_KEY, JSON.stringify(list));
  renderApiPresets();
}

function renderApiPresets(selectedId = $('apiPresetSelect')?.value || '') {
  const select = $('apiPresetSelect');
  if (!select) return;
  const list = apiPresets();
  select.innerHTML = '<option value="">选择 API 预设</option>' + list.map(item => `<option value="${escapeHTML(item.id)}">${escapeHTML(item.name)}</option>`).join('');
  if (list.some(item => item.id === selectedId)) select.value = selectedId;
  $('deleteApiPresetBtn').disabled = !select.value;
  updateApiStatus();
}

function applyApiPreset(preset) {
  if (!preset) return;
  $('apiPresetName').value = preset.name || '';
  $('apiMode').value = preset.mode || 'proxy';
  $('endpoint').value = preset.endpoint || '';
  $('token').value = preset.token || '';
  $('presetSaveToken').checked = Boolean(preset.token);
  $('deleteApiPresetBtn').disabled = false;
  updateApiStatus();
  saveSettings();
  toast(`已切换到：${preset.name}`);
}

$('apiPresetSelect').addEventListener('change', () => {
  const preset = apiPresets().find(item => item.id === $('apiPresetSelect').value);
  if (preset) applyApiPreset(preset);
  else {
    $('apiPresetName').value = '';
    $('deleteApiPresetBtn').disabled = true;
    updateApiStatus();
  }
});

$('saveApiPresetBtn').onclick = () => {
  const name = $('apiPresetName').value.trim();
  const endpoint = $('endpoint').value.trim();
  if (!name) { toast('请先填写预设名称'); $('apiPresetName').focus(); return; }
  if (!endpoint) { toast('请先填写接口地址'); $('endpoint').focus(); return; }
  const list = apiPresets();
  const selectedId = $('apiPresetSelect').value;
  const existingIndex = list.findIndex(item => item.id === selectedId);
  const preset = {
    id: selectedId || makeId(), name, mode: $('apiMode').value, endpoint,
    token: $('presetSaveToken').checked ? $('token').value.trim() : '', updatedAt: Date.now()
  };
  if (existingIndex >= 0) list.splice(existingIndex, 1, preset);
  else list.unshift(preset);
  saveApiPresets(list);
  $('apiPresetSelect').value = preset.id;
  $('deleteApiPresetBtn').disabled = false;
  updateApiStatus();
  toast(existingIndex >= 0 ? 'API 预设已更新' : 'API 预设已保存');
};

$('deleteApiPresetBtn').onclick = () => {
  const id = $('apiPresetSelect').value;
  const preset = apiPresets().find(item => item.id === id);
  if (!preset || !confirm(`删除 API 预设“${preset.name}”？`)) return;
  saveApiPresets(apiPresets().filter(item => item.id !== id));
  $('apiPresetName').value = '';
  toast('API 预设已删除');
};

$('clearAllDataBtn').onclick = () => {
  $('clearDataConfirm').value = '';
  $('clearDataBackupCheck').checked = false;
  $('confirmClearData').disabled = true;
  showDialog('clearDataDialog');
  setTimeout(() => $('clearDataConfirm').focus(), 50);
};

function updateClearDataButton() {
  $('confirmClearData').disabled = $('clearDataConfirm').value.trim() !== '清空全部' || !$('clearDataBackupCheck').checked;
}

$('clearDataConfirm').addEventListener('input', updateClearDataButton);
$('clearDataBackupCheck').addEventListener('change', updateClearDataButton);
$('confirmClearData').onclick = async () => {
  if ($('confirmClearData').disabled) return;
  const button = $('confirmClearData');
  button.disabled = true;
  button.textContent = '正在清除…';
  try {
    await Promise.all([dbClear('artworks'), dbClear('recipes'), dbClear('vibes'), dbClear('collections')]);
    collectionsCache = [];
    Object.keys(localStorage).filter(key => key.startsWith('nai_studio_')).forEach(key => localStorage.removeItem(key));
    closeDialog('clearDataDialog');
    toast('本机数据已全部清除');
    setTimeout(() => location.reload(), 500);
  } catch (error) {
    toast(`清除失败：${error.message}`);
    button.textContent = '永久清除';
    updateClearDataButton();
  }
};

function updateModelUI() {
  renderVibePanel();
  const model = $('model').value;
  const isV5 = model.startsWith('nai-diffusion-5-');
  $('modelBadge').textContent = isV5 ? 'V5' : model.includes('4-5') ? 'V4.5' : model.includes('diffusion-4-') ? 'V4' : 'V3';
  $('modelHelp').textContent = isV5
    ? (model.endsWith('full') ? 'V5 Full · 长提示词、多角色与透明背景' : 'V5 Curated · 更干净、聚焦的训练集')
    : (model.includes('4-5') ? 'V4.5 · 兼容传统 TAG 与角色提示' : model.includes('diffusion-4-') ? 'V4 · 多角色与 Vibe 参考' : 'Anime V3 · 传统标签模型');
  $('transparentWrap').style.opacity = isV5 ? '1' : '.42';
  $('transparentBg').disabled = !isV5;
}

function switchView(name) {
  document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === `view-${name}`));
  document.querySelectorAll('[data-view]').forEach(button => {
    const active = button.dataset.view === name;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('topViewName').textContent = { create: '创作台', gallery: '配方档案', library: '图库', characters: '人物库', words: '散词库' }[name];
  if (name === 'gallery') renderRecipes();
  if (name === 'library') renderImageLibrary();
  if (name === 'characters') renderCharacters();
  if (name === 'words') renderWords();
  if (matchMedia('(max-width:760px), (max-width:1100px) and (pointer:coarse)').matches) window.scrollTo({top:0,behavior:'instant'});
  else { document.querySelector('.app').scrollTo?.({ top: 0, behavior: 'smooth' }); window.scrollTo({ top: 0, behavior: 'smooth' }); }
}

document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      document.documentElement.dataset.stage = 'upgrading-db';
      const database = request.result;
      if (!database.objectStoreNames.contains('collections')) database.createObjectStore('collections', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('vibes')) database.createObjectStore('vibes', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('artworks')) {
        const artworks = database.createObjectStore('artworks', { keyPath: 'id', autoIncrement: true });
        artworks.createIndex('createdAt', 'createdAt');
      }
      if (!database.objectStoreNames.contains('recipes')) {
        const recipes = database.createObjectStore('recipes', { keyPath: 'id' });
        recipes.createIndex('updatedAt', 'updatedAt');
      }
    };
    request.onsuccess = () => { document.documentElement.dataset.stage = 'db-open'; db = request.result; db.onversionchange = () => db.close(); resolve(); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('数据库升级被其他页面占用，请关闭旧页面后重试'));
  });
}

function storeRequest(storeName, mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = operation(transaction.objectStore(storeName));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error || new Error('数据库写入已撤销，请检查存储空间'));
    transaction.onerror = () => reject(transaction.error || request.error);
    request.onerror = () => reject(request.error);
  });
}

const dbAdd = (store, value) => storeRequest(store, 'readwrite', objectStore => objectStore.add(value));
const dbPut = (store, value) => storeRequest(store, 'readwrite', objectStore => objectStore.put(value));
const dbDelete = (store, id) => storeRequest(store, 'readwrite', objectStore => objectStore.delete(id));
const dbClear = store => storeRequest(store, 'readwrite', objectStore => objectStore.clear());
const dbGet = (store, id) => storeRequest(store, 'readonly', objectStore => objectStore.get(id));
const dbAll = store => storeRequest(store, 'readonly', objectStore => objectStore.getAll());

// Commit related records together; caches are refreshed only after success.
function commitRecords(writes = {}, removals = {}) {
  const stores = [...new Set([...Object.keys(writes), ...Object.keys(removals)])];
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error('保存失败，本次修改已撤销'));
    tx.onerror = () => {};
    try {
      for (const [name, records] of Object.entries(writes)) for (const record of records) tx.objectStore(name).put(record);
      for (const [name, ids] of Object.entries(removals)) for (const id of ids) tx.objectStore(name).delete(id);
    } catch (error) { tx.abort(); reject(error); }
  });
}

function characters() {
  return readLocalLibrary(CHARACTERS_KEY, 'character');
}

function saveCharacters(list) {
  localStorage.setItem(CHARACTERS_KEY, JSON.stringify(list));
  renderCharacters();
  updateActiveCharacterLabel();
  renderImageLibrary();
}

const characterFieldLabels = {
  gender: '性别', hair: '头发', eyes: '眼睛', skin: '肤色', body: '体型',
  features: '标志特征', outfit: '固定着装', naturalAppearance: '自然语言外貌'
};

function characterPrompt(character) {
  if (!character) return '';
  if (character.fullPrompt?.trim()) return character.fullPrompt.trim();
  return Object.keys(characterFieldLabels).map(key => character[key]?.trim()).filter(Boolean).join(', ');
}

function selectedCharacterIds() {
  try {
    const ids = JSON.parse($('characterSelectIds')?.value || '[]');
    return Array.isArray(ids) ? [...new Set(ids.map(String))] : [];
  } catch { return []; }
}

function setSelectedCharacterIds(ids = []) {
  const existing = new Set(characters().map(character => character.id));
  const clean = [...new Set(ids.map(String))].filter(id => existing.has(id));
  $('characterSelectIds').value = JSON.stringify(clean);
  updateActiveCharacterLabel();
}

function updateActiveCharacterLabel() {
  const selected = selectedCharacterIds().map(id => characters().find(character => character.id === id)).filter(Boolean);
  $('activeCharacterNames').innerHTML = selected.length
    ? `已关联人物：<strong>${selected.map(character => escapeHTML(character.name)).join(' + ')}</strong>`
    : '未关联人物档案';
  $('clearCharacterLinks').hidden = !selected.length;
}

function selectedCharactersPrompt(ids = selectedCharacterIds()) {
  return ids.map(id => characters().find(character => character.id === id)).filter(Boolean).map(characterPrompt).filter(Boolean).join(', ');
}

function resetCharacterForm() {
  $('characterForm').reset();
  $('characterEditId').value = '';
  $('characterFormTitle').textContent = '新增人物';
  $('saveCharacterBtn').querySelector('span').textContent = '保存人物';
  $('cancelCharacterEdit').hidden = true;
}

function openCharacterEditor(id) {
  const character = characters().find(item => item.id === id);
  if (!character) return;
  $('characterEditId').value = character.id;
  $('characterName').value = character.name || '';
  $('characterFullPrompt').value = character.fullPrompt || '';
  $('characterGender').value = character.gender || '';
  $('characterHair').value = character.hair || '';
  $('characterEyes').value = character.eyes || '';
  $('characterSkin').value = character.skin || '';
  $('characterBody').value = character.body || '';
  $('characterFeatures').value = character.features || '';
  $('characterOutfit').value = character.outfit || '';
  $('characterNatural').value = character.naturalAppearance || '';
  $('characterTags').value = (character.tags || []).join(', ');
  $('characterFormTitle').textContent = '修改人物';
  $('saveCharacterBtn').querySelector('span').textContent = '保存修改';
  $('cancelCharacterEdit').hidden = false;
  $('characterForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('characterName').focus();
}

function useCharacter(id) {
  const character = characters().find(item => item.id === id);
  if (!character) return;
  recordLibraryUse('characters', character.id);
  $('characterPrompt').value = characterPrompt(character);
  setSelectedCharacterIds([character.id]);
  saveSettings();
  switchView('create');
  toast(`已把“${character.name}”放入创作台`);
}

function characterDetailHTML(character, key) {
  const value = character[key] || '';
  return `<div class="character-field${['features', 'outfit', 'naturalAppearance'].includes(key) ? ' wide' : ''}"><header><b>${characterFieldLabels[key]}</b><button class="copy-btn" data-character-field="${key}" data-character-id="${escapeHTML(character.id)}" type="button" aria-label="复制${characterFieldLabels[key]}">${icon('copy')}</button></header><p>${escapeHTML(value || '—')}</p></div>`;
}

function renderCharacters() {
  const listElement = $('characterList');
  if (!listElement) return;
  const query = $('characterSearch').value.trim().toLowerCase();
  const list = characters().filter(character => !query || [
    character.name, character.fullPrompt, character.gender, character.hair, character.eyes,
    character.skin, character.body, character.features, character.outfit,
    character.naturalAppearance, character.sourceUrl, ...(character.tags || [])
  ].join(' ').toLowerCase().includes(query));
  listElement.innerHTML = list.length ? list.map(character => {
    const prompt = characterPrompt(character);
    return `<article class="character-card"><div class="character-head"><div><h2>${escapeHTML(character.name)}</h2><div class="chips">${(character.tags || []).map(tag => `<span class="chip">${escapeHTML(tag)}</span>`).join('') || '<span class="chip">未添加标签</span>'}</div></div><button class="icon-btn${character.favorite ? ' favorite-active' : ''}" data-character-favorite="${escapeHTML(character.id)}" type="button" aria-label="${character.favorite ? '取消收藏' : '收藏'}${escapeHTML(character.name)}" aria-pressed="${Boolean(character.favorite)}">${icon('star')}</button></div><p class="character-prompt">${escapeHTML(prompt || '还没有完整人物提示词')}</p><div class="character-actions"><button class="primary" data-character-use="${escapeHTML(character.id)}" type="button">放入创作台</button><button class="secondary" data-character-copy="${escapeHTML(character.id)}" type="button">复制完整描述</button><button class="secondary" data-character-edit="${escapeHTML(character.id)}" type="button">修改</button><button class="danger-btn" data-character-delete="${escapeHTML(character.id)}" type="button">删除</button></div><details class="character-details"><summary>查看并复制分类资料</summary><div class="character-fields">${Object.keys(characterFieldLabels).map(key => characterDetailHTML(character, key)).join('')}</div></details></article>`;
  }).join('') : '<div class="empty"><div><b>人物库还是空的</b><span>把常用角色保存下来，以后可以一键放入创作台。</span></div></div>';
  if (typeof groupRenderedLibrary === 'function') groupRenderedLibrary('characters', list, listElement, '.character-card');
  listElement.querySelectorAll('[data-character-use]').forEach(button => button.onclick = () => useCharacter(button.dataset.characterUse));
  listElement.querySelectorAll('[data-character-copy]').forEach(button => button.onclick = () => {
    const character = characters().find(item => item.id === button.dataset.characterCopy);
    copyText(characterPrompt(character || {}), button, '已复制完整人物提示词');
  });
  listElement.querySelectorAll('[data-character-field]').forEach(button => button.onclick = () => {
    const character = characters().find(item => item.id === button.dataset.characterId);
    copyText(character?.[button.dataset.characterField] || '', button, `已复制${characterFieldLabels[button.dataset.characterField]}`);
  });
  listElement.querySelectorAll('[data-character-edit]').forEach(button => button.onclick = () => openCharacterEditor(button.dataset.characterEdit));
  listElement.querySelectorAll('[data-character-favorite]').forEach(button => button.onclick = () => {
    const list = characters();
    const character = list.find(item => item.id === button.dataset.characterFavorite);
    if (!character) return;
    character.favorite = !character.favorite;
    character.updatedAt = Date.now();
    saveCharacters(list);
    toast(character.favorite ? '已收藏人物' : '已取消收藏');
  });
  listElement.querySelectorAll('[data-character-delete]').forEach(button => button.onclick = () => {
    const character = characters().find(item => item.id === button.dataset.characterDelete);
    if (!character || !confirm(`删除人物“${character.name}”？`)) return;
    saveCharacters(characters().filter(item => item.id !== character.id));
    toast('人物档案已删除');
  });
}

$('characterForm').onsubmit = event => {
    try {
  event.preventDefault();
  const list = characters();
  const editId = $('characterEditId').value;
  const old = list.find(item => item.id === editId);
  const character = {
    ...old,
    id: editId || makeId(), name: $('characterName').value.trim(),
    fullPrompt: $('characterFullPrompt').value.trim(), gender: $('characterGender').value.trim(),
    hair: $('characterHair').value.trim(), eyes: $('characterEyes').value.trim(),
    skin: $('characterSkin').value.trim(), body: $('characterBody').value.trim(),
    features: $('characterFeatures').value.trim(), outfit: $('characterOutfit').value.trim(),
    naturalAppearance: $('characterNatural').value.trim(), tags: splitTags($('characterTags').value),
    favorite: Boolean(old?.favorite), createdAt: old?.createdAt || Date.now(), updatedAt: Date.now()
  };
  if (old) list.splice(list.findIndex(item => item.id === editId), 1, character);
  else list.unshift(character);
  saveCharacters(list);
  resetCharacterForm();
  toast(old ? '人物档案已更新' : '人物档案已保存');
    } catch (error) { toast(`保存失败：${error.message}`); }
};

$('cancelCharacterEdit').onclick = resetCharacterForm;
$('characterSearch').addEventListener('input', debounce(renderCharacters));
$('clearCharacterLinks').onclick = () => {
  setSelectedCharacterIds([]);
  saveSettings();
  toast('已取消人物档案关联，提示词内容仍然保留');
};

function words() {
  return readLocalLibrary(WORDS_KEY, 'word');
}

function saveWords(list) {
  localStorage.setItem(WORDS_KEY, JSON.stringify(list));
  renderWords();
}

function bundleData(word) {
  if (word.bundle && typeof word.bundle === 'object') return word.bundle;
  try {
    const parsed = JSON.parse(word.content || '{}');
    return {
      artistPrompt: parsed.artistPrompt || '',
      positivePrompt: parsed.positivePrompt || '',
      negativePrompt: parsed.negativePrompt || '',
      scenePrompt: parsed.scenePrompt || ''
    };
  } catch {
    return { artistPrompt: '', positivePrompt: word.content || '', negativePrompt: '', scenePrompt: '' };
  }
}

async function migrateLegacyData() {
  if (localStorage.getItem(MIGRATION_KEY)) return;
  const legacyArtworks = await dbAll('artworks');
  const grouped = new Map();
  legacyArtworks.forEach(item => {
    if (item.recipeId || !item.category || item.category === '未分类') return;
    if (!grouped.has(item.category)) grouped.set(item.category, []);
    grouped.get(item.category).push(item);
  });
  for (const [name, items] of grouped) {
    items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const source = items[0];
    const recipe = {
      id: makeId(), name, artistPrompt: source.artistPrompt || '',
      positivePrompt: source.positivePrompt || '', negativePrompt: source.negativePrompt || '',
      tags: source.tags || [], coverArtworkId: source.id, createdAt: Date.now(), updatedAt: Date.now(),
      manualOrder: -(source.createdAt || Date.now()), defaultParams: pickParams(source), migratedFrom: 'category'
    };
    await dbAdd('recipes', recipe);
    for (const artwork of items) {
      artwork.recipeId = recipe.id;
      await dbPut('artworks', artwork);
    }
  }
  const existingRecipes = await dbAll('recipes');
  for (const word of words().filter(item => item.kind === 'bundle')) {
    if (existingRecipes.some(recipe => recipe.name === word.name)) continue;
    const bundle = bundleData(word);
    await dbAdd('recipes', {
      id: makeId(), name: word.name || '旧版整套配方', artistPrompt: bundle.artistPrompt,
      positivePrompt: bundle.positivePrompt, negativePrompt: bundle.negativePrompt,
      tags: word.tags || [], coverArtworkId: null, createdAt: word.createdAt || Date.now(),
      updatedAt: Date.now(), manualOrder: -(word.createdAt || Date.now()), defaultParams: {}, migratedFrom: 'word-bundle'
    });
  }
  localStorage.setItem(MIGRATION_KEY, new Date().toISOString());
}

function pickParams(source = {}) {
  const result = {};
  ['model', 'size', 'steps', 'scale', 'sampler', 'noiseSchedule', 'transparentBg', 'vibes'].forEach(key => {
    if (source[key] !== undefined) result[key] = source[key];
  });
  return result;
}

async function refreshData() {
  if (typeof refreshCollections === 'function') await refreshCollections();
  recipesCache = (await dbAll('recipes')).map(item => normalizeLibraryRecord(item, 'recipe')).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  artworksCache = (await dbAll('artworks')).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  renderRecipeOptions();
  renderRecipes();
  renderImageLibrary();
}

function renderRecipeOptions() {
  const current = restoredRecipeId ?? $('recipeSelect').value;
  restoredRecipeId = null;
  const options = recipesCache.map(recipe => `<option value="${escapeHTML(recipe.id)}">${escapeHTML(recipe.name)}</option>`).join('');
  $('recipeSelect').innerHTML = `<option value="">未关联配方</option>${options}`;
  $('importRecipeSelect').innerHTML = options || '<option value="">还没有配方</option>';
  $('moveRecipeSelect').innerHTML = `<option value="">未关联配方</option>${options}`;
  if (recipesCache.some(recipe => recipe.id === current)) $('recipeSelect').value = current;
  else if (current) $('recipeSelect').value = '';
  updateActiveRecipeLabel();
}

function updateActiveRecipeLabel() {
  currentRecipe = recipesCache.find(recipe => recipe.id === $('recipeSelect').value) || null;
  $('activeRecipeName').textContent = currentRecipe ? currentRecipe.name : '未选择配方档案';
  $('activeRecipeHint').textContent = currentRecipe
    ? '生成图片会自动保存到这份配方档案'
    : '生成后暂不关联配方，也可以先选择或新建配方';
}

function setRecipeAssociation(recipe) {
  const previous = currentRecipe;
  const sceneTag = localStorage.getItem(AUTO_SCENE_TAG_KEY) || '';
  const oldTags = new Set(previous?.tags || []);
  const retained = splitTags($('tags').value).filter(tag => !oldTags.has(tag) || tag === sceneTag);
  $('tags').value = [...new Set([...retained, ...(recipe?.tags || [])])].join(', ');
  $('recipeSelect').value = recipe?.id || '';
  updateActiveRecipeLabel();
}
function syncArtistRecipe(preferredId = '') {
  const prompt = normalizedWordPrompt($('artistPrompt').value);
  const matches = recipesCache.filter(recipe => prompt && normalizedWordPrompt(recipe.artistPrompt) === prompt);
  const preferred = matches.find(recipe => String(recipe.id) === String(preferredId));
  setRecipeAssociation(preferred || (matches.length === 1 ? matches[0] : null));
}

function applyRecipe(recipe, includeParams = true) {
  if (!recipe) return;
  trackedWordSources = trackedWordSources.filter(source => !['artistPrompt', 'positivePrompt', 'negativePrompt'].includes(source.field));
  $('artistPrompt').value = recipe.artistPrompt || '';
  $('positivePrompt').value = recipe.positivePrompt || '';
  $('negativePrompt').value = recipe.negativePrompt || '';
  setRecipeAssociation(recipe);
  if (includeParams) {
    if (Array.isArray(recipe.defaultParams?.vibes)) restoreVibeSelection(recipe.defaultParams.vibes, recipe.defaultParams.model);
    Object.entries(pickParams(recipe.defaultParams || {})).forEach(([key, value]) => {
      const element = $(key);
      if (!element || value === undefined || value === null || (key === 'model' && !value)) return;
      if (element.type === 'checkbox') element.checked = Boolean(value);
      else element.value = value;
    });
  }
  $('recipeSelect').value = recipe.id;
  updateActiveRecipeLabel();
  updateModelUI();
  saveSettings();
}

$('recipeSelect').addEventListener('change', () => {
  const recipe = recipesCache.find(item => item.id === $('recipeSelect').value);
  if (recipe) {
    applyRecipe(recipe);
    toast(`已载入配方：${recipe.name}`);
  } else {
    setRecipeAssociation(null);
    saveSettings();
  }
});

function openRecipeEditor(recipe = null, prefillCurrent = false) {
  const params = recipe?.defaultParams || (prefillCurrent ? collectMeta() : {});
  $('recipeDialogTitle').textContent = recipe ? '编辑配方档案' : '新建配方档案';
  $('recipeEditId').value = recipe?.id || '';
  $('recipeName').value = recipe?.name || '';
  $('recipeArtist').value = recipe?.artistPrompt || (prefillCurrent ? $('artistPrompt').value : '');
  $('recipePositive').value = recipe?.positivePrompt || (prefillCurrent ? $('positivePrompt').value : '');
  $('recipeNegative').value = recipe?.negativePrompt || (prefillCurrent ? $('negativePrompt').value : '');
  $('recipeTags').value = (recipe?.tags || (prefillCurrent ? splitTags($('tags').value) : [])).join(', ');
  $('recipeAuthor').value = recipe?.author || '';
  $('recipeNote').value = recipe?.note || '';
  $('recipeSourceUrl').value = recipe?.sourceUrl || '';
  $('recipeSteps').value = Number(params.steps) || 28;
  $('recipeModel').value = params.model || '';
  $('recipeSampler').value = params.sampler || 'k_euler_ancestral';
  showDialog('recipeDialog');
  setTimeout(() => $('recipeName').focus(), 50);
}

$('newRecipeBtn').onclick = () => openRecipeEditor(null, true);
$('galleryNewRecipeBtn').onclick = () => openRecipeEditor();
$('saveBundleBtn').onclick = () => openRecipeEditor(null, true);

$('recipeForm').onsubmit = async event => {
  try {
  event.preventDefault();
  const id = $('recipeEditId').value;
  const old = id ? await dbGet('recipes', id) : null;
  const recipe = {
    ...old,
    id: id || makeId(),
    name: $('recipeName').value.trim(),
    artistPrompt: $('recipeArtist').value.trim(),
    positivePrompt: $('recipePositive').value.trim(),
    negativePrompt: $('recipeNegative').value.trim(),
    tags: splitTags($('recipeTags').value),
    author: $('recipeAuthor').value.trim(),
    note: $('recipeNote').value.trim(),
    sourceUrl: $('recipeSourceUrl').value.trim(),
    coverArtworkId: old?.coverArtworkId || null,
    createdAt: old?.createdAt || Date.now(),
    updatedAt: Date.now(),
    manualOrder: old?.manualOrder ?? -Date.now(),
    defaultParams: {
      ...(old?.defaultParams || pickParams(collectMeta())),
      model: $('recipeModel').value || undefined,
      steps: Number($('recipeSteps').value) || 28,
      sampler: $('recipeSampler').value
    }
  };
  await dbPut('recipes', recipe);
  closeDialog('recipeDialog');
  await refreshData();
  applyRecipe(recipesCache.find(item => item.id === recipe.id));
  toast(id ? '配方已更新' : '配方档案已创建');
  } catch (error) { toast(`操作失败：${error.message}`); }
};

function recipeCopyRow(label, value, key) {
  return `<div class="recipe-copy-row"><header><b>${label}</b><button class="copy-btn with-text" data-recipe-copy="${key}">${icon('copy')}<span>复制</span></button></header><p>${escapeHTML(value || '—')}</p></div>`;
}

function releaseGalleryUrls() {
  galleryUrls.forEach(url => URL.revokeObjectURL(url));
  galleryUrls = [];
}

function artworkUrl(blob) {
  const url = URL.createObjectURL(blob);
  galleryUrls.push(url);
  return url;
}

function coverFor(recipe) {
  if (recipe.virtualKind === 'search') return artworksCache.find(item => recipe.artworkIds.includes(item.id)) || null;
  if (recipe.virtual) return artworksCache.find(item => !item.recipeId) || null;
  return artworksCache.find(item => item.id === recipe.coverArtworkId && item.recipeId === recipe.id)
    || artworksCache.find(item => item.recipeId === recipe.id)
    || null;
}

const WORD_PROMPT_FIELDS = ['scenePrompt', 'artistPrompt', 'positivePrompt', 'negativePrompt'];
let trackedWordSources = [];
let wordSourceIndexRaw = null, wordSourceIndex = [];
function normalizedWordPrompt(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').trim().replace(/^,+|,+$/g, '');
}
function wordPromptParts(word) {
  if (word.kind === 'bundle') return WORD_PROMPT_FIELDS.map(field => ({ field, content: bundleData(word)[field] || '' })).filter(part => part.content.trim());
  const field = word.kind + 'Prompt';
  return WORD_PROMPT_FIELDS.includes(field) && word.content ? [{ field, content: word.content }] : [];
}
function currentWordSourceIndex() {
  const raw = localStorage.getItem(WORDS_KEY);
  if (raw !== wordSourceIndexRaw) {
    wordSourceIndexRaw = raw;
    wordSourceIndex = words().map(word => ({ word, parts: wordPromptParts(word).map(part => ({ ...part, normalized: normalizedWordPrompt(part.content) })) }));
  }
  return wordSourceIndex;
}
function promptContainsWord(prompt, content, explicit = false) {
  const haystack = normalizedWordPrompt(prompt), needle = normalizedWordPrompt(content);
  if (!needle) return false;
  if (haystack === needle) return true;
  // Old images need a substantial complete phrase, not one common tag.
  return (explicit || (needle.length >= 30 && needle.split(',').length >= 3)) && (',' + haystack + ',').includes(',' + needle + ',');
}
function snapshotWordSource(word, field, content) {
  return { wordId: String(word.id), field, content, author: word.author || '', sourceUrl: word.sourceUrl || '', name: word.name || '' };
}
function trackWordSource(word, field, content, append = false) {
  if (!WORD_PROMPT_FIELDS.includes(field)) return;
  if (!append) trackedWordSources = trackedWordSources.filter(source => source.field !== field);
  if (word) trackedWordSources.push(snapshotWordSource(word, field, content));
}
function inferredWordSources(item) {
  const index = currentWordSourceIndex(), result = [];
  for (const {word, parts} of index) {
    if (!parts.length || !parts.every(part => promptContainsWord(item[part.field], part.content))) continue;
    // Identical contents cannot tell us which entry was used.
    if (parts.some(part => index.some(other => other.word.id !== word.id && other.parts.some(candidate => candidate.field === part.field && candidate.normalized === part.normalized)))) continue;
    for (const part of parts) result.push(snapshotWordSource(word, part.field, part.content));
  }
  return result;
}
function collectedWordSources(item) {
  const explicit = trackedWordSources.filter(source => promptContainsWord(item[source.field], source.content, true));
  const seen = new Set(explicit.map(source => source.field + ':' + normalizedWordPrompt(source.content)));
  return [...explicit, ...inferredWordSources(item).filter(source => !seen.has(source.field + ':' + normalizedWordPrompt(source.content)))].map(source => {
    const word = currentWordSourceIndex().find(entry => String(entry.word.id) === String(source.wordId))?.word;
    return word ? { ...source, author: word.author || '', sourceUrl: word.sourceUrl || '', name: word.name || '' } : source;
  });
}
function artworkWordSearchText(item) {
  const index = currentWordSourceIndex();
  const sources = Array.isArray(item.wordSources) ? item.wordSources : inferredWordSources(item);
  return sources.flatMap(source => {
    if (!source || !WORD_PROMPT_FIELDS.includes(source.field) || !promptContainsWord(item[source.field], source.content, true)) return [];
    const word = index.find(entry => String(entry.word.id) === String(source.wordId))?.word;
    return word ? [word.author, word.sourceUrl] : [source.author, source.sourceUrl];
  }).join(' ');
}

function artworkSearchText(item) {
  const recipe = recipesCache.find(value => value.id === item.recipeId);
  return [
    item.title, item.scenePrompt, item.characterPrompt, item.sourcePrompt, item.fullPrompt, item.artistPrompt,
    item.positivePrompt, item.negativePrompt, item.category, ...(item.tags || []),
    item.sourceUrl, artworkWordSearchText(item), recipe?.name, recipe?.author, recipe?.sourceUrl, ...(recipe?.tags || [])
  ].join(' ').toLowerCase();
}

function artworksForView(recipe) {
  if (recipe.virtualKind === 'search') return artworksCache.filter(item => recipe.artworkIds.includes(item.id));
  return artworksCache.filter(item => recipe.virtual ? !item.recipeId : item.recipeId === recipe.id);
}

function recipeViews() {
  const list = [...recipesCache];
  const uncategorized = artworksCache.filter(item => !item.recipeId);
  if (uncategorized.length) list.unshift({
    id: '__uncategorized__', name: '未关联配方', artistPrompt: '', positivePrompt: '',
    negativePrompt: '', tags: ['待整理'], coverArtworkId: null, virtual: true, updatedAt: Date.now()
  });
  return list;
}

function manualRecipeRank(recipe) {
  return Number.isFinite(Number(recipe.manualOrder)) ? Number(recipe.manualOrder) : -Number(recipe.createdAt || 0);
}

function sortRecipeViews(views) {
  const virtual = views.filter(recipe => recipe.virtual);
  const recipes = views.filter(recipe => !recipe.virtual);
  const mode = $('gallerySort').value || 'newest';
  recipes.sort((a, b) => {
    if (mode === 'recent') return (b.lastUsedAt || 0) - (a.lastUsedAt || 0) || (b.createdAt || 0) - (a.createdAt || 0);
    if (mode === 'oldest') return (a.createdAt || 0) - (b.createdAt || 0);
    if (mode === 'name') return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN', { numeric: true, sensitivity: 'base' });
    if (mode === 'manual') return manualRecipeRank(a) - manualRecipeRank(b);
    return (b.createdAt || b.updatedAt || 0) - (a.createdAt || a.updatedAt || 0);
  });
  return [...virtual, ...recipes];
}

function restoreRecipeInspectorHome() {
  const inspector = $('recipeInspector');
  const grid = $('recipeGrid');
  if (inspector && grid?.contains(inspector)) grid.parentElement.appendChild(inspector);
}

function selectedArtworks() {
  return artworksCache.filter(item => selectedArtworkIds.has(String(item.id)));
}

function selectionMark(item) {
  if (!artworkSelectionMode) return '';
  return `<span class="select-mark" aria-hidden="true">${icon('check')}</span>`;
}

function batchBarHTML(visibleIds = []) {
  if (!artworkSelectionMode) return '';
  const visible = visibleIds.map(String);
  const visibleSelected = visible.filter(id => selectedArtworkIds.has(id)).length;
  return `<div class="batch-bar"><span data-artwork-selection-count>已选择 ${selectedArtworkIds.size} 张</span><button class="secondary" data-batch-all type="button">${visible.length && visibleSelected === visible.length ? '取消全选' : '全选当前'}</button><button class="secondary" data-batch-favorite type="button">收藏 / 取消</button><button class="secondary" data-batch-tag type="button">加标签</button><button class="secondary" data-batch-move type="button">更换配方</button><button class="danger-btn" data-batch-delete type="button">删除</button><button class="secondary" data-batch-cancel type="button">退出多选</button></div>`;
}

function setArtworkSelectionMode(enabled) {
  artworkSelectionMode = enabled;
  if (!enabled) selectedArtworkIds.clear();
  renderRecipes();
  renderImageLibrary();
}

function toggleArtworkSelection(id) {
  const key = String(id);
  if (selectedArtworkIds.has(key)) selectedArtworkIds.delete(key);
  else selectedArtworkIds.add(key);
  document.querySelectorAll(`[data-image-id="${key}"],[data-library-image="${key}"]`).forEach(button => button.classList.toggle('selected', selectedArtworkIds.has(key)));
  document.querySelectorAll('[data-artwork-selection-count]').forEach(span => { span.textContent = `已选择 ${selectedArtworkIds.size} 张`; });
}

async function batchFavoriteArtworks() {
  const items = selectedArtworks();
  if (!items.length) { toast('请先选择图片'); return; }
  const favorite = !items.every(item => item.favorite);
  await commitRecords({ artworks: items.map(item => ({ ...item, favorite, updatedAt: Date.now() })) });
  await refreshData();
  toast(favorite ? `已收藏 ${items.length} 张图片` : `已取消收藏 ${items.length} 张图片`);
}

async function batchDeleteArtworks() {
  const items = selectedArtworks();
  if (!items.length) { toast('请先选择图片'); return; }
  if (!confirm(`永久删除选中的 ${items.length} 张图片？此操作无法撤销。`)) return;
  const ids = new Set(items.map(item => item.id));
  await commitRecords({ recipes: recipesCache.filter(item => ids.has(item.coverArtworkId)).map(recipe => ({ ...recipe, coverArtworkId: null, updatedAt: Date.now() })) }, { artworks: [...ids] });
  artworkSelectionMode = false;
  selectedArtworkIds.clear();
  await refreshData();
  toast(`已删除 ${items.length} 张图片`);
}

function bindBatchBar(root, visibleIds) {
  const all = root.querySelector('[data-batch-all]');
  if (all) all.onclick = () => {
    const ids = visibleIds.map(String);
    const shouldSelect = !ids.length || ids.some(id => !selectedArtworkIds.has(id));
    ids.forEach(id => shouldSelect ? selectedArtworkIds.add(id) : selectedArtworkIds.delete(id));
    renderRecipes();
    renderImageLibrary();
  };
  root.querySelector('[data-batch-favorite]')?.addEventListener('click', () => batchFavoriteArtworks().catch(error => toast(error.message)));
  root.querySelector('[data-batch-tag]')?.addEventListener('click', () => { $('batchTags').value = ''; showDialog('batchTagDialog'); });
  root.querySelector('[data-batch-move]')?.addEventListener('click', () => {
    if (!selectedArtworkIds.size) { toast('请先选择图片'); return; }
    batchMoveActive = true;
    $('moveRecipeSelect').value = '';
    showDialog('moveDialog');
  });
  root.querySelector('[data-batch-delete]')?.addEventListener('click', () => batchDeleteArtworks().catch(error => toast(error.message)));
  root.querySelector('[data-batch-cancel]')?.addEventListener('click', () => setArtworkSelectionMode(false));
}

function collapseRecipeInspector() {
  currentGalleryRecipeId = '';
  const inspector = $('recipeInspector');
  restoreRecipeInspectorHome();
  inspector.hidden = true;
  document.querySelectorAll('[data-recipe-id]').forEach(button => button.classList.remove('active'));
}

const authorSelections = {
  recipes: { active: false, ids: new Set() },
  words: { active: false, ids: new Set() }
};
let pendingAuthorEdit = null;
function authorSelectionRecords(type) { return type === 'recipes' ? recipesCache : words(); }
function renderAuthorSelectionLibrary(type) { (type === 'recipes' ? renderRecipes : renderWords)(); }
function setAuthorSelectionMode(type, active) {
  const state = authorSelections[type];
  state.active = active;
  if (!active) state.ids.clear();
  if (type === 'recipes') collapseRecipeInspector();
  renderAuthorSelectionLibrary(type);
}
function toggleAuthorSelection(type, id) {
  const state = authorSelections[type], key = String(id);
  if (state.ids.has(key)) state.ids.delete(key); else state.ids.add(key);
  renderAuthorSelectionLibrary(type);
}
function renderAuthorSelection(type, visibleIds) {
  const state = authorSelections[type], valid = new Set(authorSelectionRecords(type).map(item => String(item.id)));
  for (const id of state.ids) if (!valid.has(id)) state.ids.delete(id);
  const button = $(type === 'recipes' ? 'recipeMultiSelectBtn' : 'wordMultiSelectBtn');
  button.textContent = state.active ? '退出多选' : '多选';
  button.setAttribute('aria-pressed', String(state.active));
  button.onclick = () => setAuthorSelectionMode(type, !state.active);
  const host = $(type === 'recipes' ? 'recipeAuthorBatchBar' : 'wordAuthorBatchBar');
  host.hidden = !state.active;
  if (!state.active) { host.replaceChildren(); return; }
  const ids = visibleIds.map(String), all = ids.length > 0 && ids.every(id => state.ids.has(id));
  host.innerHTML = `<div class="batch-bar"><span role="status">已选择 ${state.ids.size} ${type === 'recipes' ? '份配方' : '个词条'}</span><button class="secondary" type="button" data-author-select-all ${ids.length ? '' : 'disabled'}>${all ? '取消全选当前' : '全选当前'}</button><button class="secondary" type="button" data-author-batch-edit ${state.ids.size ? '' : 'disabled'}>批量作者备注</button><button class="secondary" type="button" data-author-selection-cancel>退出多选</button></div>`;
  host.querySelector('[data-author-select-all]').onclick = () => {
    for (const id of ids) if (all) state.ids.delete(id); else state.ids.add(id);
    renderAuthorSelectionLibrary(type);
  };
  host.querySelector('[data-author-batch-edit]').onclick = () => openBatchAuthor(type);
  host.querySelector('[data-author-selection-cancel]').onclick = () => setAuthorSelectionMode(type, false);
}
function openBatchAuthor(type) {
  const records = authorSelectionRecords(type).filter(item => authorSelections[type].ids.has(String(item.id)));
  if (!records.length) { toast('请先选择条目'); return; }
  pendingAuthorEdit = { type, ids: records.map(item => String(item.id)) };
  const authors = new Set(records.map(item => item.author || ''));
  $('batchAuthorInput').value = authors.size === 1 ? records[0].author || '' : '';
  $('batchAuthorSummary').textContent = `将统一修改 ${records.length} ${type === 'recipes' ? '份配方' : '个词条'}的作者备注。`;
  $('batchAuthorError').textContent = '';
  showDialog('batchAuthorDialog');
  $('batchAuthorInput').focus();
}
async function saveBatchAuthors(type, ids, author) {
  if (!['recipes', 'words'].includes(type)) throw new Error('不支持的资料库');
  author = String(author || '').trim();
  const selected = new Set(ids.map(String)), updatedAt = Date.now();
  let count = 0;
  if (type === 'words') {
    const list = words().map(item => {
      if (!selected.has(String(item.id))) return item;
      count++;
      return { ...item, author, updatedAt };
    });
    if (!count) throw new Error('选中的词条已不存在，请重新选择');
    localStorage.setItem(WORDS_KEY, JSON.stringify(list));
    renderWords();
  } else {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('recipes', 'readwrite'), store = tx.objectStore('recipes');
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || new Error('保存失败，所选配方保持原样'));
      tx.onerror = () => {};
      try {
        for (const id of selected) {
          const request = store.get(id);
          request.onsuccess = () => {
            if (!request.result) return;
            try { store.put({ ...request.result, author, updatedAt }); count++; }
            catch (error) { tx.abort(); reject(error); }
          };
        }
      } catch (error) { tx.abort(); reject(error); }
    });
    if (!count) throw new Error('选中的配方已不存在，请重新选择');
    await refreshData();
  }
  return count;
}
$('batchAuthorDialog').addEventListener('close', () => { if (!$('batchAuthorDialog').open) pendingAuthorEdit = null; });
$('batchAuthorForm').onsubmit = async event => {
  event.preventDefault();
  if (!pendingAuthorEdit || $('saveBatchAuthorBtn').disabled) return;
  const { type, ids } = pendingAuthorEdit, author = $('batchAuthorInput').value.trim();
  $('saveBatchAuthorBtn').disabled = true;
  $('batchAuthorError').textContent = '';
  try {
    const count = await saveBatchAuthors(type, ids, author);
    closeDialog('batchAuthorDialog');
    setAuthorSelectionMode(type, false);
    toast(`已${author ? '更新' : '清除'} ${count} ${type === 'recipes' ? '份配方' : '个词条'}的作者备注`);
  } catch (error) { $('batchAuthorError').textContent = `保存失败：${error.message}`; }
  finally { $('saveBatchAuthorBtn').disabled = false; }
};

function renderRecipes() {
  if (!db) return;
  restoreRecipeInspectorHome();
  releaseGalleryUrls();
  const query = $('gallerySearch').value.trim().toLowerCase();
  const views = sortRecipeViews(recipeViews());
  const matchingArtworks = query ? artworksCache.filter(item => artworkSearchText(item).includes(query)) : [];
  const matchingRecipeIds = new Set(matchingArtworks.map(item => item.recipeId || '__uncategorized__'));
  let list = views.filter(recipe => !query || matchingRecipeIds.has(recipe.id) || [
    recipe.name, recipe.artistPrompt, recipe.positivePrompt, recipe.negativePrompt,
    recipe.author, recipe.note, recipe.sourceUrl, ...(recipe.tags || [])
  ].join(' ').toLowerCase().includes(query));
  if (authorSelections.recipes.active) list = list.filter(recipe => !recipe.virtual);
  if (query && matchingArtworks.length && !authorSelections.recipes.active) {
    const searchView = {
      id: '__search__', name: `图片搜索：${$('gallerySearch').value.trim()}`, artistPrompt: '',
      positivePrompt: '', negativePrompt: '', tags: [`${matchingArtworks.length} 张命中`], virtual: true,
      virtualKind: 'search', artworkIds: matchingArtworks.map(item => item.id)
    };
    list.unshift(searchView);
    views.unshift(searchView);
    currentGalleryRecipeId = searchView.id;
  } else if (currentGalleryRecipeId === '__search__') currentGalleryRecipeId = '';
  renderAuthorSelection('recipes', list.filter(recipe => !recipe.virtual).map(recipe => recipe.id));
  const grid = $('recipeGrid');
  grid.classList.toggle('recipe-selection-mode', authorSelections.recipes.active);
  if (!list.length) {
    grid.innerHTML = `<div class="empty"><div><b>${recipesCache.length ? '没有匹配的配方' : '还没有配方档案'}</b><span>解析一张 NovelAI PNG，或手动建立第一份画师配方。</span><div class="empty-recipe-call"><button class="secondary" id="emptyImport">解析图片</button><button class="primary" id="emptyCreate">新建配方</button></div></div></div>`;
    $('emptyImport').onclick = () => $('imageImportFile').click();
    $('emptyCreate').onclick = () => openRecipeEditor();
  } else {
    grid.innerHTML = list.map(recipe => {
      const cover = coverFor(recipe);
      const count = artworksForView(recipe).length;
      const visual = cover
        ? `<img class="recipe-cover" src="${artworkUrl(cover.blob)}" alt="${escapeHTML(recipe.name)}封面">`
        : '<div class="recipe-cover empty-cover">等待第一张立图</div>';
      return `<button class="recipe-card${currentGalleryRecipeId === recipe.id ? ' active' : ''}${authorSelections.recipes.active && authorSelections.recipes.ids.has(String(recipe.id)) ? ' selected' : ''}" ${authorSelections.recipes.active ? `aria-pressed="${authorSelections.recipes.ids.has(String(recipe.id))}"` : ''} data-recipe-id="${escapeHTML(recipe.id)}">${authorSelections.recipes.active ? `<span class="select-mark" aria-hidden="true">${icon('check')}</span>` : ''}${visual}<div class="recipe-card-body"><div class="recipe-card-title">${recipe.favorite ? `${icon('star')} ` : ''}${escapeHTML(recipe.name)}</div><div class="recipe-card-meta"><span>${count} 张立图</span><span>${escapeHTML((recipe.tags || [])[0] || '未标记')}</span></div></div></button>`;
    }).join('');
    grid.querySelectorAll('[data-recipe-id]').forEach(button => {
      button.onclick = () => authorSelections.recipes.active ? toggleAuthorSelection('recipes', button.dataset.recipeId) : currentGalleryRecipeId === button.dataset.recipeId ? collapseRecipeInspector() : inspectRecipe(list.find(recipe => recipe.id === button.dataset.recipeId));
    });
  }
  if (typeof groupRenderedLibrary === 'function') groupRenderedLibrary('recipes', list, grid, '.recipe-card');
  if (currentGalleryRecipeId && !authorSelections.recipes.active) {
    const fresh = list.find(recipe => recipe.id === currentGalleryRecipeId);
    if (fresh) inspectRecipe(fresh);
    else collapseRecipeInspector();
  }
}

function inspectRecipe(recipe) {
  if (!recipe) return;
  currentGalleryRecipeId = recipe.id;
  const inspector = $('recipeInspector');
  inspector.hidden = false;
  inspector.classList.remove('detail-enter');
  void inspector.offsetWidth;
  const images = artworksForView(recipe);
  const cover = coverFor(recipe);
  const coverHTML = cover
    ? `<img src="${artworkUrl(cover.blob)}" alt="${escapeHTML(recipe.name)}封面">`
    : '<div class="recipe-hero-placeholder">暂无立图</div>';
  inspector.className = 'sheet recipe-inspector detail-enter';
  const recipeTools = recipe.virtualKind === 'search'
    ? '<div class="tools"><button class="secondary" id="clearGallerySearch" type="button">清空搜索</button></div>'
    : recipe.virtual
    ? '<div class="tools"><button class="secondary" id="organizeFirst" type="button">新建配方整理</button></div>'
    : `<div class="tools"><button class="secondary" id="useRecipe" type="button">去创作台</button><button class="secondary" id="moveRecipeFront" type="button">移到最前</button><button class="icon-btn${recipe.favorite ? ' favorite-active' : ''}" id="favoriteRecipe" type="button" aria-label="${recipe.favorite ? '取消收藏' : '收藏'}配方" aria-pressed="${Boolean(recipe.favorite)}">${icon('star')}</button><button class="icon-btn" id="editRecipe" type="button" aria-label="编辑配方">${icon('settings')}</button></div>`;
  const reusable = recipe.virtualKind === 'search'
    ? '<p class="security-note">集中展示命中图片标签、标题、画面提示词或所属配方的结果。打开图片可以继续补标签。</p>'
    : recipe.virtual ? '<p class="security-note">这里收纳尚未归入配方的图片。打开任一图片即可移动、复制或删除。</p>'
    : `<div class="recipe-copy-list">${recipeCopyRow('画师串', recipe.artistPrompt, 'artistPrompt')}${recipeCopyRow('正面提示词', recipe.positivePrompt, 'positivePrompt')}${recipeCopyRow('负面提示词', recipe.negativePrompt, 'negativePrompt')}</div>${recipe.author || recipe.note || recipe.sourceUrl ? `<div class="recipe-notes"><b>作者、备注与来源</b>${recipe.author ? `<p>作者：${escapeHTML(recipe.author)}</p>` : ''}${recipe.note ? `<p>${escapeHTML(recipe.note)}</p>` : ''}${safeHttpUrl(recipe.sourceUrl) ? `<a class="source-link" href="${escapeHTML(safeHttpUrl(recipe.sourceUrl))}" target="_blank" rel="noopener noreferrer">打开来源链接</a>` : recipe.sourceUrl ? `<p>${escapeHTML(recipe.sourceUrl)}</p>` : ''}</div>` : ''}`;
  const bottomActions = recipe.virtual ? '' : '<div class="inspector-actions"><button class="secondary" id="editRecipeBottom" type="button">编辑配方</button><button class="danger-btn" id="deleteRecipe" type="button">删除配方</button></div>';
  const imageIds = images.map(item => item.id);
  const selectionTools = `<button class="mini-action" id="selectRecipeImages" type="button">${artworkSelectionMode ? '退出多选' : '多选'}</button>`;
  inspector.innerHTML = `<div class="recipe-hero">${coverHTML}<div><h2>${escapeHTML(recipe.name)}</h2><div class="chips">${(recipe.tags || []).map(tag => `<span class="chip">${escapeHTML(tag)}</span>`).join('') || '<span class="chip">未添加标签</span>'}</div>${recipeTools}</div></div>${reusable}<div class="recipe-images-head"><b>立图 · ${images.length}</b><div class="tools">${selectionTools}${recipe.virtualKind === 'search' ? '' : '<button class="mini-action" id="importIntoRecipe" type="button">导入图片</button>'}</div></div>${batchBarHTML(imageIds)}<div class="recipe-images${images.length <= 3 ? ' single-row' : ''}${artworkSelectionMode ? ' selection-mode' : ''}">${images.map(item => `<button class="recipe-image${selectedArtworkIds.has(String(item.id)) ? ' selected' : ''}" data-image-id="${item.id}" aria-label="${artworkSelectionMode ? '选择' : '查看'}${escapeHTML(item.title || '图片')}">${selectionMark(item)}<img draggable="false" loading="lazy" decoding="async" src="${artworkUrl(item.blob)}" alt="${escapeHTML(item.title || recipe.name)}">${artworkSelectionMode ? '' : '<span class="recipe-image-more" aria-hidden="true">•••</span>'}</button>`).join('') || '<div class="empty-inline">还没有立图。去创作台生成，或导入外部 PNG。</div>'}</div>${bottomActions}`;
  $('selectRecipeImages').onclick = () => setArtworkSelectionMode(!artworkSelectionMode);
  bindBatchBar(inspector, imageIds);
  inspector.querySelectorAll('[data-recipe-copy]').forEach(button => {
    button.onclick = () => copyText(recipe[button.dataset.recipeCopy] || '', button, `已复制${button.dataset.recipeCopy === 'artistPrompt' ? '画师串' : button.dataset.recipeCopy === 'positivePrompt' ? '正面词' : '负面词'}`);
  });
  if (recipe.virtualKind === 'search') {
    $('clearGallerySearch').onclick = () => { $('gallerySearch').value = ''; renderRecipes(); };
  } else if (recipe.virtual) {
    $('organizeFirst').onclick = () => openRecipeEditor();
    $('importIntoRecipe').onclick = () => { delete $('imageImportFile').dataset.recipeId; $('imageImportFile').click(); };
  } else {
    $('useRecipe').onclick = () => { applyRecipe(recipe); switchView('create'); toast('配方已放入创作台'); };
    $('moveRecipeFront').onclick = () => moveRecipeToFront(recipe).catch(error => toast(error.message));
    $('favoriteRecipe').onclick = async () => {
    try {
      const updated = { ...recipe, favorite: !recipe.favorite, updatedAt: Date.now() };
      await dbPut('recipes', updated);
      await refreshData();
      inspectRecipe(recipesCache.find(item => item.id === recipe.id));
      toast(updated.favorite ? '已收藏配方' : '已取消收藏');
    } catch (error) { toast(`保存失败：${error.message}`); }
    };
    $('editRecipe').onclick = $('editRecipeBottom').onclick = () => openRecipeEditor(recipe);
    $('importIntoRecipe').onclick = () => { $('imageImportFile').dataset.recipeId = recipe.id; $('imageImportFile').click(); };
    $('deleteRecipe').onclick = () => deleteRecipe(recipe).catch(error => toast(error.message));
  }
  inspector.querySelectorAll('[data-image-id]').forEach(button => bindImageAction(button, Number(button.dataset.imageId)));
  document.querySelectorAll('[data-recipe-id]').forEach(button => button.classList.toggle('active', button.dataset.recipeId === recipe.id));
  if (matchMedia('(max-width:1100px)').matches) {
    const card = document.querySelector(`[data-recipe-id="${CSS.escape(String(recipe.id))}"]`);
    if (card) (card.closest('.folder-item') || card).after(inspector);
  } else {
    restoreRecipeInspectorHome();
  }
}

async function moveRecipeToFront(recipe) {
  const ranks = recipesCache.filter(item => item.id !== recipe.id).map(manualRecipeRank);
  await dbPut('recipes', { ...recipe, manualOrder: (ranks.length ? Math.min(...ranks) : 0) - 1, updatedAt: Date.now() });
  $('gallerySort').value = 'manual';
  saveSettings();
  await refreshData();
  inspectRecipe(recipesCache.find(item => item.id === recipe.id));
  toast('已切换为手动顺序，并把这份配方移到最前');
}

function bindImageAction(button, id) {
  let timer = 0;
  const open = () => openImageDialog(artworksCache.find(item => item.id === id));
  button.onclick = () => artworkSelectionMode ? toggleArtworkSelection(id) : open();
  button.oncontextmenu = event => { event.preventDefault(); open(); };
  button.onpointerdown = event => {
    if (event.pointerType === 'mouse' || artworkSelectionMode) return;
    timer = window.setTimeout(open, 520);
  };
  ['pointerup', 'pointercancel', 'pointermove'].forEach(name => button.addEventListener(name, () => clearTimeout(timer)));
}

async function deleteRecipe(recipe) {
  const count = artworksCache.filter(item => item.recipeId === recipe.id).length;
  if (!confirm(`删除配方“${recipe.name}”？其中 ${count} 张图片将不再关联配方，不会删除图片。`)) return;
  await commitRecords({ artworks: artworksCache.filter(item => item.recipeId === recipe.id).map(artwork => ({ ...artwork, recipeId: '', category: '未分类', updatedAt: Date.now() })) }, { recipes: [recipe.id] });
  if ($('recipeSelect').value === recipe.id) $('recipeSelect').value = '';
  currentGalleryRecipeId = '';
  $('recipeInspector').className = 'sheet recipe-inspector empty-inspector';
  $('recipeInspector').textContent = '选择一份配方，查看封面立图与可复制内容';
  await refreshData();
  toast('配方已删除，图片已解除配方关联');
}

function inferredArtworkCharacterIds(item = {}) {
  // Only legacy records without explicit links use prompt matching. Backup IDs stay exact.
  if (Array.isArray(item.characterIds) || item.characterId) return artworkCharacterIds(item);
  const prompt = String(item.characterPrompt || '');
  return characters().filter(character => {
    const savedPrompt = characterPrompt(character);
    return savedPrompt && prompt.includes(savedPrompt);
  }).map(character => character.id);
}

function artworkCharacterNames(item) {
  const savedNames = Array.isArray(item.characterNames) ? item.characterNames : (item.characterName ? [item.characterName] : []);
  if (savedNames.length) return [...new Set(savedNames.filter(Boolean))];
  return inferredArtworkCharacterIds(item).map(id => characters().find(character => character.id === id)?.name).filter(Boolean);
}

async function deleteLibraryTag(tag) {
  const affected = artworksCache.filter(item => (item.tags || []).includes(tag));
  if (!affected.length) return;
  if (!confirm(`删除图片标签“${tag}”？\n\n它会从 ${affected.length} 张图片中移除，但不会删除图片。`)) return;
  await commitRecords({ artworks: affected.map(item => ({ ...item, tags: (item.tags || []).filter(value => value !== tag), updatedAt: Date.now() })) });
  await refreshData();
  toast(`已从 ${affected.length} 张图片中删除标签“${tag}”`);
}

function restoreLibraryResultsHome() {
  const results = $('libraryResults');
  const shell = $('libraryShell');
  if (results && shell && results.parentElement !== shell) shell.appendChild(results);
}

function renderImageLibrary() {
  const filterList = $('libraryFilterList');
  const imageGrid = $('libraryImageGrid');
  if (!filterList || !imageGrid) return;
  restoreLibraryResultsHome();
  libraryUrls.forEach(URL.revokeObjectURL);
  libraryUrls = [];
  const query = $('librarySearch').value.trim().toLowerCase();
  renderGalleryFacets(filterList);
  let images = artworksCache.filter(matchesGalleryFacets).filter(item => !query || [
    artworkSearchText(item), ...artworkCharacterNames(item)
  ].join(' ').toLowerCase().includes(query));
  if ($('librarySort').value === 'oldest') images = [...images].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  else images = [...images].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  $('libraryActiveName').textContent = '图片';
  $('libraryCount').textContent = `${images.length} 张`;
  $('librarySelectBtn').textContent = artworkSelectionMode ? '退出多选' : '多选';
  $('librarySelectBtn').onclick = () => setArtworkSelectionMode(!artworkSelectionMode);
  $('libraryBatchBar').innerHTML = batchBarHTML(images.map(item => item.id));
  bindBatchBar($('libraryBatchBar'), images.map(item => item.id));
  imageGrid.classList.toggle('single-row', images.length > 0 && images.length <= 3);
  imageGrid.innerHTML = images.length ? images.map(item => {
    const url = URL.createObjectURL(item.blob);
    libraryUrls.push(url);
    const title = item.title || '未命名镜头';
    const favoriteMark = item.favorite ? `<span class="library-favorite-mark" aria-label="已收藏">${icon('star')}</span>` : '';
    return `<button class="library-image${selectedArtworkIds.has(String(item.id)) ? ' selected' : ''}" data-library-image="${item.id}" type="button" aria-label="${artworkSelectionMode ? '选择' : '查看'}${escapeHTML(title)}" title="${escapeHTML(title)}">${selectionMark(item)}${favoriteMark}<img loading="lazy" decoding="async" src="${url}" alt="${escapeHTML(title)}"></button>`;
  }).join('') : '<div class="empty"><div><b>没有符合条件的图片</b><span>可以取消筛选条件，或换个关键词搜索。</span></div></div>';
  if (typeof groupRenderedLibrary === 'function') groupRenderedLibrary('artworks', images, imageGrid, '.library-image');
  imageGrid.classList.toggle('selection-mode', artworkSelectionMode);
  imageGrid.querySelectorAll('[data-library-image]').forEach(button => button.onclick = () => artworkSelectionMode ? toggleArtworkSelection(button.dataset.libraryImage) : openImageDialog(artworksCache.find(item => item.id === Number(button.dataset.libraryImage))));
  const results = $('libraryResults');
  results.hidden = false;
  restoreLibraryResultsHome();
}

// Read returned values from the original image. Never replace the archived request.
const returnedImageMetadataCache = new WeakMap();
let returnedImageDetailsToken = null;
function reportedImageValues(metadata) {
  const raw = flattenImageMetadata(metadata.text || {}), result = {};
  const negative = [raw.v4_negative_prompt?.caption?.base_caption, raw.uc, raw.negative_prompt, raw.negativePrompt, raw.Negative, metadata.text?.Negative].find(value => typeof value === 'string');
  if (negative !== undefined) result.negativePrompt = negative;
  for (const key of ['steps', 'scale', 'seed']) {
    const value = raw[key] ?? (key === 'scale' ? raw.cfg_scale : undefined);
    if (value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value))) result[key] = Number(value);
  }
  if (typeof raw.sampler === 'string' && raw.sampler) result.sampler = raw.sampler;
  const noise = raw.noise_schedule ?? raw.noiseSchedule;
  if (typeof noise === 'string' && noise) result.noiseSchedule = noise;
  return result;
}
function returnedImageValues(blob) {
  if (!returnedImageMetadataCache.has(blob)) returnedImageMetadataCache.set(blob, (async () => {
    // Ordinary PNG text can be read without decoding all the pixels.
    try {
      const values = reportedImageValues(await parsePNG(blob));
      if ('negativePrompt' in values) return values;
    } catch { /* JPEG/WebP and PNG stealth metadata use the shared reader. */ }
    return reportedImageValues(await readImageMetadata(blob));
  })());
  return returnedImageMetadataCache.get(blob);
}
async function showReturnedImageValues(item) {
  const host = $('imageReturnedRecord'), token = Symbol();
  returnedImageDetailsToken = token;
  host.innerHTML = '<header><b>图片记录的负面词与参数</b></header><p role="status">正在读取原图记录……</p>';
  try {
    const values = await returnedImageValues(item.blob);
    if (returnedImageDetailsToken !== token || currentImage !== item || !$('imageDialog').open) return;
    const hasNegative = Object.hasOwn(values, 'negativePrompt');
    const comparable = value => String(value || '').trim().replace(/\s+/g, ' ');
    const same = hasNegative && comparable(values.negativePrompt) === comparable(item.negativePrompt);
    const note = !hasNegative ? '原图没有可读取的负面词记录，无法核实。' : same ? '原图记录与档案保存的负面词一致。' : '原图记录与档案保存的负面词不同；原填写内容已保留。';
    const params = [
      'steps' in values ? values.steps + ' Steps' : '', 'scale' in values ? 'Guidance ' + values.scale : '',
      values.sampler ? samplerName(values.sampler) : '', values.noiseSchedule || '',
      'seed' in values ? 'Seed ' + values.seed : ''
    ].filter(Boolean);
    host.innerHTML = '<header><b>图片记录的负面词</b><button class="copy-btn" type="button" data-returned-negative-copy aria-label="复制图片记录的负面词" ' + (hasNegative && values.negativePrompt ? '' : 'disabled') + '>' + icon('copy') + '</button></header>'
      + '<p class="returned-record-note" role="status">' + note + '</p>'
      + (hasNegative ? '<p data-returned-negative>' + escapeHTML(values.negativePrompt || '（空）') + '</p>' : '')
      + (params.length ? '<div class="image-parameter-strip" aria-label="图片记录的参数">' + params.map(value => '<span class="chip">' + escapeHTML(value) + '</span>').join('') + '</div>' : '<p class="returned-record-note">原图没有可读取的生成参数。</p>');
    host.querySelector('[data-returned-negative-copy]').onclick = event => copyText(values.negativePrompt || '', event.currentTarget);
  } catch {
    if (returnedImageDetailsToken === token && currentImage === item && $('imageDialog').open) host.innerHTML = '<header><b>图片记录的负面词与参数</b></header><p role="status">无法读取原图中的生成记录；档案内容保留原样。</p>';
  }
}

function openImageDialog(item) {
  if (!item) return;
  currentImage = item;
  const recipe = recipesCache.find(value => value.id === item.recipeId);
  $('imageDialogTitle').textContent = item.title || '图片记录';
  $('imageDialogMeta').textContent = `${recipe?.name || '未关联配方'} · ${shortModel(item.model || '未知模型')} · ${item.size || '未知尺寸'}`;
  if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
  imagePreviewUrl = URL.createObjectURL(item.blob);
  $('imageDialogPreview').src = imagePreviewUrl;
  $('imageTags').value = (item.tags || []).join(', ');
  const people = artworkCharacterNames(item);
  $('imageParameterStrip').innerHTML = [
    ...people.map(name => `人物：${name}`), shortModel(item.model || '未知模型'), item.size || '未知尺寸',
    item.steps ? `${item.steps} Steps` : '', item.sampler ? samplerName(item.sampler) : ''
  ].filter(Boolean).map(value => `<span class="chip">${escapeHTML(value)}</span>`).join('');
  const promptRows = [
    ['画面描述', item.scenePrompt || item.sourcePrompt], ['人物提示词', item.characterPrompt],
    ['画师串', item.artistPrompt], ['正面提示词', item.positivePrompt], ['负面提示词', item.negativePrompt]
  ];
  $('imagePromptDetails').innerHTML = promptRows.map(([label, value], index) => `<section class="image-prompt-row"><header><b>${label}${index === 4 ? (item.imported === false ? '（当时填写）' : '（档案保存）') : ''}</b><button type="button" class="copy-btn" data-image-prompt-copy="${index}" aria-label="复制${label}" ${value ? '' : 'disabled'}>${icon('copy')}</button></header><p>${escapeHTML(value || '—')}</p></section>`).join('');
  $('imagePromptDetails').querySelectorAll('[data-image-prompt-copy]').forEach(button => button.onclick = () => copyText(promptRows[Number(button.dataset.imagePromptCopy)][1] || '', button));
  const copyAll = $('imageCopyAll');
  copyAll.onclick = () => copyText(promptRows.filter(([, value]) => value).map(([label, value]) => `${label}\n${value}`).join('\n\n'), copyAll);
  $('imageSetCover').disabled = !recipe;
  $('imageMove').onclick = () => { batchMoveActive = false; $('moveRecipeSelect').value = item.recipeId || ''; showDialog('moveDialog'); };
  $('saveImageTags').onclick = async () => {
    try {
    const updated = { ...item, tags: splitTags($('imageTags').value), updatedAt: Date.now() };
    await dbPut('artworks', updated);
    Object.assign(item, updated);
    await refreshData();
    toast('图片标签已保存，现在可以用它搜索');
    } catch (error) { toast(`保存失败：${error.message}`); }
  };
  $('imageSetCover').onclick = async () => {
    try {
    if (!recipe) return;
    await dbPut('recipes', { ...recipe, coverArtworkId: item.id, updatedAt: Date.now() });
    await refreshData();
    inspectRecipe(recipesCache.find(value => value.id === recipe.id));
    toast('已设为配方封面');
    } catch (error) { toast(`保存失败：${error.message}`); }
  };
  $('imageReuse').onclick = () => { reuseArtwork(item); closeDialog('imageDialog'); };
  $('imageDownload').onclick = () => downloadArtwork(item);
  $('imageDownloadJpeg').onclick = () => downloadArtworkJpeg(item, $('imageDownloadJpeg'));
  $('imageDelete').onclick = () => deleteArtwork(item).catch(error => toast(error.message));
  showDialog('imageDialog');
  void showReturnedImageValues(item);
}

async function moveArtworkRecords(items, targetRecipeId) {
  const target = recipesCache.find(recipe => recipe.id === targetRecipeId);
  if (targetRecipeId && !target) throw new Error('目标配方已不存在');
  const ids = new Set(items.filter(item => item.recipeId !== targetRecipeId).map(item => item.id));
  const updates = recipesCache.filter(recipe => ids.has(recipe.coverArtworkId)).map(recipe => ({ ...recipe, coverArtworkId: null, updatedAt: Date.now() }));
  if (target && !target.coverArtworkId && items.length) updates.push({ ...target, coverArtworkId: items[0].id, updatedAt: Date.now() });
  await commitRecords({ artworks: items.map(item => ({ ...item, recipeId: targetRecipeId, category: target?.name || '未分类', updatedAt: Date.now() })), recipes: updates });
}
async function moveArtworkRecord(item, targetRecipeId) { return moveArtworkRecords([item], targetRecipeId); }

$('confirmMoveBtn').onclick = async () => {
  try {
  const targetRecipeId = $('moveRecipeSelect').value;
  if (batchMoveActive) {
    const items = selectedArtworks();
    if (!items.length) { toast('请先选择图片'); return; }
    await moveArtworkRecords(items, targetRecipeId);
    closeDialog('moveDialog');
    batchMoveActive = false;
    artworkSelectionMode = false;
    selectedArtworkIds.clear();
    await refreshData();
    toast(`已移动 ${items.length} 张图片`);
    return;
  }
  if (!currentImage) return;
  await moveArtworkRecord(currentImage, targetRecipeId);
  closeDialog('moveDialog');
  closeDialog('imageDialog');
  await refreshData();
  toast('图片已重新归档');
  } catch (error) { toast(`操作失败：${error.message}`); }
};

$('moveDialog').addEventListener('close', () => { batchMoveActive = false; });

$('confirmBatchTags').onclick = async () => {
  try {
  const tags = splitTags($('batchTags').value);
  const items = selectedArtworks();
  if (!tags.length) { toast('请先填写标签'); return; }
  if (!items.length) { toast('请先选择图片'); return; }
  await commitRecords({ artworks: items.map(item => ({ ...item, tags: [...new Set([...(item.tags || []), ...tags])], updatedAt: Date.now() })) });
  closeDialog('batchTagDialog');
  await refreshData();
  toast(`已给 ${items.length} 张图片添加标签`);
  } catch (error) { toast(`操作失败：${error.message}`); }
};

async function deleteArtwork(item) {
  if (!confirm('删除这张图片及其生成记录？此操作不可恢复。')) return;
  await commitRecords({ recipes: recipesCache.filter(recipe => recipe.coverArtworkId === item.id).map(owner => ({ ...owner, coverArtworkId: null, updatedAt: Date.now() })) }, { artworks: [item.id] });
  closeDialog('imageDialog');
  await refreshData();
  toast('图片记录已删除');
}

function safeFilenamePart(value = 'image') {
  return String(value).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').slice(0, 80) || 'image';
}

function triggerBlobDownload(blob, filename) {
  const anchor = document.createElement('a');
  const url = URL.createObjectURL(blob);
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function downloadArtwork(item) {
  const extension = item.blob.type === 'image/jpeg' ? 'jpg' : item.blob.type === 'image/webp' ? 'webp' : 'png';
  triggerBlobDownload(item.blob, `NAI_${item.id}_${safeFilenamePart(item.model)}.${extension}`);
  toast('开始下载保留元数据的原图');
}

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

async function reencodeImageAsJpeg(blob, quality = 0.92) {
  if (!(blob instanceof Blob)) throw new Error('图片文件不可用');
  const source = await imageSourceFromBlob(blob);
  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;
  if (!width || !height) throw new Error('无法读取图片尺寸');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('当前浏览器不支持图片转换');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(source, 0, 0, width, height);
  source.close?.();
  const jpeg = await new Promise((resolve, reject) => canvas.toBlob(result => {
    if (result) resolve(result);
    else reject(new Error('浏览器没有生成 JPG 文件'));
  }, 'image/jpeg', quality));
  return jpeg;
}

async function downloadArtworkJpeg(item, button) {
  if (!item?.blob) { toast('这里还没有可下载的图片'); return; }
  if (button) button.disabled = true;
  try {
    const jpeg = await reencodeImageAsJpeg(item.blob);
    triggerBlobDownload(jpeg, `NAI_${item.id || 'share'}_${safeFilenamePart(item.model)}_分享版.jpg`);
    toast('JPG 分享版已下载，不含提示词元数据');
  } catch (error) {
    toast(`JPG 转换失败：${error.message}`);
  } finally {
    if (button) button.disabled = false;
  }
}

function reuseArtwork(item) {
  trackedWordSources = structuredClone(Array.isArray(item.wordSources) ? item.wordSources : inferredWordSources(item));
  restoreVibeSelection(item.vibes || [], item.model);
  ['scenePrompt', 'characterPrompt', 'artistPrompt', 'positivePrompt', 'negativePrompt', 'model', 'size', 'steps', 'scale', 'seed', 'sampler', 'noiseSchedule'].forEach(key => {
    if (item[key] !== undefined && $(key)) $(key).value = item[key];
  });
  $('tags').value = (item.tags || []).join(', ');
  setSelectedCharacterIds(inferredArtworkCharacterIds(item));
  $('transparentBg').checked = Boolean(item.transparentBg);
  $('recipeSelect').value = item.recipeId || '';
  updateActiveRecipeLabel();
  updateModelUI();
  saveSettings();
  switchView('create');
  toast('图片配方已带回创作台');
}

function updatePickerCharacterCount() {
  const count = pickerCharacterSelection.size;
  $('pickerSelectedCount').textContent = count ? `已选择 ${count} 个人物` : '尚未选择人物';
  $('replaceCharactersBtn').disabled = !count;
  $('appendCharactersBtn').disabled = !count;
}

function renderPickerList() {
  const query = $('pickerSearch').value.trim().toLowerCase();
  const list = sortPickerItems(pickerItems.filter(item => !query || item.search.includes(query)));
  if (pickerKind === 'character') {
    $('pickerList').innerHTML = list.length ? list.map(item => `<label class="picker-check"><input type="checkbox" value="${escapeHTML(item.id)}"${pickerCharacterSelection.has(item.id) ? ' checked' : ''}><span><b>${escapeHTML(item.name)}</b><span>${escapeHTML(item.value)}</span>${item.favorite ? '<span class="picker-badge">已收藏</span>' : ''}</span></label>`).join('') : '<div class="empty"><div><b>没有匹配的人物</b><span>试试人物名称、标签或描述中的关键词。</span></div></div>';
    $('pickerList').querySelectorAll('input').forEach(input => input.onchange = () => {
      if (input.checked) pickerCharacterSelection.add(input.value);
      else pickerCharacterSelection.delete(input.value);
      updatePickerCharacterCount();
    });
    updatePickerCharacterCount();
    return;
  }
  $('pickerList').innerHTML = list.length ? list.map(item => `<div class="picker-item"><div><b>${escapeHTML(item.name)}</b><span>${escapeHTML(item.source)} · ${escapeHTML(item.value)}</span>${item.favorite ? '<span class="picker-badge">已收藏</span>' : ''}</div><div class="picker-actions"><button class="secondary" data-picker-mode="replace" data-picker-id="${escapeHTML(item.id)}" type="button">替换</button><button class="secondary" data-picker-mode="append" data-picker-id="${escapeHTML(item.id)}" type="button">追加</button></div></div>`).join('') : '<div class="empty"><div><b>没有匹配的内容</b><span>可以搜索名称、正文、分类、标签、备注或来源。</span></div></div>';
  $('pickerList').querySelectorAll('[data-picker-id]').forEach(button => button.onclick = () => {
    const item = pickerItems.find(value => value.id === button.dataset.pickerId);
    if (!item) return;
    recordLibraryUse(item.libraryType, item.recordId);
    const target = $(pickerTargetId);
    target.value = button.dataset.pickerMode === 'append' && target.value.trim() ? `${target.value.trim()}, ${item.value}` : item.value;
    trackWordSource(item.libraryType === 'words' ? words().find(word => String(word.id) === String(item.recordId)) : null, pickerTargetId, item.value, button.dataset.pickerMode === 'append');
    if (pickerTargetId === 'artistPrompt') syncArtistRecipe(item.libraryType === 'recipes' ? item.recordId : '');
    if (pickerKind === 'scene') setAutoSceneTag(item.name);
    saveSettings();
    closeDialog('pickerDialog');
    toast(button.dataset.pickerMode === 'append' ? '已追加到输入框' : '已替换输入框内容');
  });
}

function applyPickedCharacters(mode) {
  const pickedIds = [...pickerCharacterSelection];
  if (!pickedIds.length) return;
  for (const id of pickedIds) recordLibraryUse('characters', id);
  const target = $(pickerTargetId);
  if (mode === 'replace') {
    setSelectedCharacterIds(pickedIds);
    target.value = selectedCharactersPrompt(pickedIds);
  } else {
    const existingIds = selectedCharacterIds();
    const combinedIds = [...new Set([...existingIds, ...pickedIds])];
    const existingLinkedPrompt = selectedCharactersPrompt(existingIds);
    const pickedPrompt = selectedCharactersPrompt(pickedIds.filter(id => !existingIds.includes(id)));
    setSelectedCharacterIds(combinedIds);
    target.value = target.value.trim() && target.value.trim() !== existingLinkedPrompt
      ? [target.value.trim(), pickedPrompt].filter(Boolean).join(', ')
      : selectedCharactersPrompt(combinedIds);
  }
  saveSettings();
  closeDialog('pickerDialog');
  toast(`${pickedIds.length} 个人物已${mode === 'append' ? '追加' : '放入'}创作台`);
}

function openPicker(kind, targetId = `${kind}Prompt`) {
  pickerKind = kind;
  $('pickerSort').value = localStorage.getItem(`nai_picker_sort_${kind}`) || 'favorite';
  pickerTargetId = targetId;
  $('pickerSearch').value = '';
  const fieldName = { scene: '画面描述词', character: '人物提示词', artist: '画师串', positive: '正面词', negative: '负面词' }[kind];
  $('pickerTitle').textContent = `选择${fieldName}`;
  $('pickerHelp').textContent = kind === 'character' ? '可以同时勾选多个人物；切换搜索词不会丢失勾选。' : '收藏内容优先显示；“替换”会清空当前字段，“追加”会接在后面。';
  $('pickerMultiActions').hidden = kind !== 'character';
  if (kind === 'character') {
    pickerCharacterSelection = new Set(selectedCharacterIds());
    pickerItems = characters().filter(character => characterPrompt(character)).map(character => ({
      ...pickerRecordInfo(character, 'characters'),
      id: character.id, name: character.name, value: characterPrompt(character), favorite: Boolean(character.favorite),
      search: searchableText(character.name, characterPrompt(character), character.tags, character.note, character.sourceUrl)
    })).sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name, 'zh-CN'));
  } else {
    const recipeItems = ['scene', 'character'].includes(kind) ? [] : recipesCache.map(recipe => ({
      ...pickerRecordInfo(recipe, 'recipes'),
      id: `recipe-${recipe.id}`, name: recipe.name, source: '配方档案', value: recipe[`${kind}Prompt`] || '', favorite: Boolean(recipe.favorite),
      search: searchableText(recipe.name, recipe[`${kind}Prompt`], recipe.tags, recipe.author, recipe.note, recipe.sourceUrl)
    }));
    const wordItems = words().flatMap(word => {
      const value = word.kind === kind ? word.content || '' : word.kind === 'bundle' ? bundleData(word)[`${kind}Prompt`] || '' : '';
      if (!value) return [];
      return [{ ...pickerRecordInfo(word, 'words'), id: `${word.kind}-${word.id}`, name: word.name, source: word.kind === 'bundle' ? '整套配方' : '散词库', value, favorite: Boolean(word.favorite), search: searchableText(word.name, value, word.category, word.tags, word.author, word.note, word.sourceUrl) }];
    });
    pickerItems = [...recipeItems, ...wordItems].filter(item => item.value).sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name, 'zh-CN'));
  }
  renderPickerList();
  $('replaceCharactersBtn').onclick = () => applyPickedCharacters('replace');
  $('appendCharactersBtn').onclick = () => applyPickedCharacters('append');
  showDialog('pickerDialog');
  setTimeout(() => $('pickerSearch').focus(), 50);
}

$('pickerSearch').addEventListener('input', renderPickerList);

document.querySelectorAll('[data-pick]').forEach(button => button.onclick = () => openPicker(button.dataset.pick));
document.querySelectorAll('[data-recipe-pick]').forEach(button => button.onclick = () => openPicker(button.dataset.recipePick, `recipe${button.dataset.recipePick[0].toUpperCase()}${button.dataset.recipePick.slice(1)}`));

function kindName(kind) {
  return ({ scene: '画面描述词', artist: '画师串', positive: '正面词', negative: '负面词', bundle: '整套配方' })[kind] || '散词';
}

function renderWords() {
  const query = $('wordSearch').value.trim().toLowerCase();
  const filter = $('wordFilter').value;
  const list = words().filter(word => {
    const bundle = word.kind === 'bundle' ? bundleData(word) : {};
    return (!filter || word.kind === filter) && (!query || [
      word.name, word.content, bundle.artistPrompt, bundle.positivePrompt, bundle.negativePrompt,
      word.category, word.author, word.note, word.sourceUrl, ...(word.tags || [])
    ].join(' ').toLowerCase().includes(query));
  });
  renderAuthorSelection('words', list.map(word => word.id));
  $('wordList').innerHTML = list.length ? list.map(word => {
    const bundle = word.kind === 'bundle' ? bundleData(word) : null;
    const summary = bundle
      ? `<div class="word-summary"><span>画师：${escapeHTML(bundle.artistPrompt || '—')}</span><span>正面：${escapeHTML(bundle.positivePrompt || '—')}</span><span>负面：${escapeHTML(bundle.negativePrompt || '—')}</span></div>`
      : `<p>${escapeHTML(word.content || '')}</p>`;
    const copyActions = bundle
      ? `<button class="secondary" data-bundle-copy="artistPrompt" data-word-id="${escapeHTML(word.id)}" type="button">画师</button><button class="secondary" data-bundle-copy="positivePrompt" data-word-id="${escapeHTML(word.id)}" type="button">正面</button><button class="secondary" data-bundle-copy="negativePrompt" data-word-id="${escapeHTML(word.id)}" type="button">负面</button>`
      : `<button class="copy-btn" data-word-copy="${escapeHTML(word.id)}" aria-label="复制${escapeHTML(word.name)}">${icon('copy')}</button>`;
    const safeSource = safeHttpUrl(word.sourceUrl);
    const provenance = word.author || word.note || word.sourceUrl
      ? `<div class="word-provenance">${word.author ? `<span title="${escapeHTML(word.author)}">作者：${escapeHTML(word.author)}</span>` : ''}${word.note ? `<span title="${escapeHTML(word.note)}">备注：${escapeHTML(word.note)}</span>` : ''}${safeSource ? `<a class="source-link" href="${escapeHTML(safeSource)}" target="_blank" rel="noopener noreferrer">打开来源</a>` : word.sourceUrl ? `<span>来源：${escapeHTML(word.sourceUrl)}</span>` : ''}</div>`
      : '';
    return `<article class="word-row${authorSelections.words.active ? ' word-selection-mode' : ''}${authorSelections.words.active && authorSelections.words.ids.has(String(word.id)) ? ' selected' : ''}${expandedWordId === String(word.id) ? ' expanded' : ''}">${authorSelections.words.active ? `<label class="word-bulk-select"><input type="checkbox" data-word-select="${escapeHTML(word.id)}" aria-label="选择${escapeHTML(word.name)}" ${authorSelections.words.ids.has(String(word.id)) ? 'checked' : ''}></label>` : ''}<button class="word-mobile-summary" data-word-expand="${escapeHTML(word.id)}" type="button" ${authorSelections.words.active ? `aria-pressed="${authorSelections.words.ids.has(String(word.id))}"` : `aria-expanded="${expandedWordId === String(word.id)}"`}><span><b>${escapeHTML(word.name)}</b> · ${kindName(word.kind)}</span><span>${authorSelections.words.active ? (authorSelections.words.ids.has(String(word.id)) ? '已选择' : '未选择') : expandedWordId === String(word.id) ? '收起' : '展开'}</span></button><div class="word-row-details"><div class="word-kind"><span class="kind-dot ${word.kind}"></span>${kindName(word.kind)}</div><div class="word-content"><b>${escapeHTML(word.name)}</b>${summary}${provenance}</div><div class="word-actions">${copyActions}<button class="icon-btn${word.favorite ? ' favorite-active' : ''}" data-word-favorite="${escapeHTML(word.id)}" type="button" aria-label="${word.favorite ? '取消收藏' : '收藏'}${escapeHTML(word.name)}" aria-pressed="${Boolean(word.favorite)}">${icon('star')}</button><button class="secondary" data-word-use="${escapeHTML(word.id)}" type="button" style="padding:7px 10px">使用</button><button class="secondary" data-word-edit="${escapeHTML(word.id)}" type="button" style="padding:7px 10px">修改</button><button class="icon-btn" data-word-del="${escapeHTML(word.id)}" type="button" aria-label="删除${escapeHTML(word.name)}">${icon('trash')}</button></div></div></article>`;
  }).join('') : '<div class="empty"><div><b>散词库还是空的</b><span>保存单独词条，或用结构化表单保存整套配方。</span></div></div>';
  if (typeof groupRenderedLibrary === 'function') groupRenderedLibrary('words', list, $('wordList'), '.word-row');
  document.querySelectorAll('[data-word-copy]').forEach(button => button.onclick = () => {
    const word = words().find(item => item.id === button.dataset.wordCopy);
    copyText(word?.content || '', button);
  });
  document.querySelectorAll('[data-bundle-copy]').forEach(button => button.onclick = () => {
    const word = words().find(item => item.id === button.dataset.wordId);
    copyText(bundleData(word)[button.dataset.bundleCopy] || '', button);
  });
  document.querySelectorAll('[data-word-use]').forEach(button => button.onclick = () => useWord(button.dataset.wordUse));
  $('wordList').querySelectorAll('[data-word-select]').forEach(input => input.onchange = () => toggleAuthorSelection('words', input.dataset.wordSelect));
  document.querySelectorAll('[data-word-expand]').forEach(button => button.onclick = () => {
    if (authorSelections.words.active) { toggleAuthorSelection('words', button.dataset.wordExpand); return; }
    expandedWordId = expandedWordId === button.dataset.wordExpand ? '' : button.dataset.wordExpand;
    renderWords();
  });
  document.querySelectorAll('[data-word-favorite]').forEach(button => button.onclick = () => {
    const list = words();
    const word = list.find(item => String(item.id) === button.dataset.wordFavorite);
    if (!word) return;
    word.favorite = !word.favorite;
    word.updatedAt = Date.now();
    saveWords(list);
    toast(word.favorite ? '已收藏词条' : '已取消收藏');
  });
  document.querySelectorAll('[data-word-edit]').forEach(button => button.onclick = () => openWordEditor(button.dataset.wordEdit));
  document.querySelectorAll('[data-word-del]').forEach(button => button.onclick = () => {
    if (!confirm('删除这个词条？')) return;
    saveWords(words().filter(item => item.id !== button.dataset.wordDel));
    toast('词条已删除');
  });
}

function resetWordForm() {
  $('wordForm').reset();
  $('wordEditId').value = '';
  $('wordFormTitle').textContent = '新增词条';
  $('saveWordBtn').querySelector('span').textContent = '保存词条';
  $('cancelWordEdit').hidden = true;
  updateWordForm();
}

function openWordEditor(id) {
  const word = words().find(item => item.id === id);
  if (!word) return;
  const bundle = word.kind === 'bundle' ? bundleData(word) : null;
  $('wordEditId').value = word.id;
  $('wordName').value = word.name || '';
  $('wordKind').value = word.kind || 'artist';
  $('wordContent').value = bundle ? '' : word.content || '';
  $('wordArtist').value = bundle?.artistPrompt || '';
  $('wordPositive').value = bundle?.positivePrompt || '';
  $('wordNegative').value = bundle?.negativePrompt || '';
  $('wordCategory').value = word.category || '';
  $('wordTags').value = (word.tags || []).join(', ');
  $('wordAuthor').value = word.author || '';
  $('wordNote').value = word.note || '';
  $('wordSourceUrl').value = word.sourceUrl || '';
  $('wordFormTitle').textContent = '修改词条';
  $('saveWordBtn').querySelector('span').textContent = '保存修改';
  $('cancelWordEdit').hidden = false;
  updateWordForm();
  openWordPanel();
}

function updateWordForm() {
  const bundle = $('wordKind').value === 'bundle';
  $('wordSingleFields').hidden = bundle;
  $('wordBundleFields').hidden = !bundle;
  $('wordContent').required = !bundle;
}

$('wordKind').addEventListener('change', updateWordForm);
$('wordSearch').addEventListener('input', debounce(renderWords));
$('wordFilter').addEventListener('change', renderWords);
$('cancelWordEdit').onclick = () => { resetWordForm(); closeDialog('wordEditorDialog'); };
let wordPanelScroll = 0;
function openWordPanel() {
  wordPanelScroll = window.scrollY;
  showDialog('wordEditorDialog');
  $('wordEditorDialog').scrollTop = 0;
  $('wordName').focus({ preventScroll: true });
}
$('newWordBtn').onclick = () => {
  if ($('wordEditId').value) resetWordForm();
  openWordPanel();
};
$('closeWordEditor').onclick = () => closeDialog('wordEditorDialog');
$('wordEditorDialog').addEventListener('close', () => {
  if (!$('wordEditorDialog').open) window.scrollTo({ top: wordPanelScroll, behavior: 'instant' });
});

$('wordForm').onsubmit = event => {
  event.preventDefault();
  const kind = $('wordKind').value;
  const bundle = kind === 'bundle' ? {
    artistPrompt: $('wordArtist').value.trim(),
    positivePrompt: $('wordPositive').value.trim(),
    negativePrompt: $('wordNegative').value.trim()
  } : null;
  if (bundle && !bundle.artistPrompt && !bundle.positivePrompt && !bundle.negativePrompt) {
    toast('整套配方至少填写一项');
    return;
  }
  const list = words();
  const editId = $('wordEditId').value;
  const old = list.find(item => item.id === editId);
  const word = {
    ...old,
    id: editId || makeId(), name: $('wordName').value.trim(), kind,
    content: bundle ? JSON.stringify(bundle) : $('wordContent').value.trim(), bundle,
    category: $('wordCategory').value.trim() || '未分类', tags: splitTags($('wordTags').value),
    author: $('wordAuthor').value.trim(), note: $('wordNote').value.trim(), sourceUrl: $('wordSourceUrl').value.trim(),
    favorite: Boolean(old?.favorite), createdAt: old?.createdAt || Date.now(), updatedAt: Date.now()
  };
  if (old) list.splice(list.findIndex(item => item.id === editId), 1, word);
  else list.unshift(word);
  try { saveWords(list); } catch (error) { toast(`保存失败：${error.message}`); return; }
  resetWordForm();
  closeDialog('wordEditorDialog');
  toast(old ? '词条已更新' : '词条已保存');
};

function useWord(id) {
  const word = words().find(item => item.id === id);
  if (!word) return;
  recordLibraryUse('words', word.id);
  if (word.kind === 'bundle') {
    const bundle = bundleData(word);
    ['artistPrompt', 'positivePrompt', 'negativePrompt'].forEach(key => {
      if (bundle[key] !== undefined) { $(key).value = bundle[key]; trackWordSource(word, key, bundle[key]); }
    });
  } else {
    $(`${word.kind}Prompt`).value = word.content || '';
    trackWordSource(word, `${word.kind}Prompt`, word.content || '');
    if (word.kind === 'scene') setAutoSceneTag(word.name);
  }
  if (word.kind === 'artist' || word.kind === 'bundle') syncArtistRecipe();
  saveSettings();
  switchView('create');
  toast('已放入创作台');
}

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
    scenePrompt: $('scenePrompt').value.trim(), characterPrompt: currentCharacterPrompt,
    characterIds: linkedCharacters.map(character => character.id), characterNames: linkedCharacters.map(character => character.name),
    characterId: linkedCharacters[0]?.id || '', characterName: linkedCharacters[0]?.name || '', artistPrompt: $('artistPrompt').value.trim(),
    positivePrompt: $('positivePrompt').value.trim(), negativePrompt: $('negativePrompt').value.trim(),
    fullPrompt: fullPrompt(), model: $('model').value, size: $('size').value,
    recipeId: recipe?.id || '', category: recipe?.name || '未分类', tags: splitTags($('tags').value),
    steps: Number($('steps').value) || 28, scale: Number($('scale').value) || 7,
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

async function parseImageResponse(response, mode) {
  if (!response.ok) throw new Error(explainHttpError(response.status));
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('json')) {
    const data = JSON.parse(new TextDecoder().decode(await readLimitedResponse(response, MAX_IMAGE_BYTES * 1.4)));
    const item = data?.data?.[0] || data;
    if (item?.b64_json) return validateGeneratedImage(await b64Blob(item.b64_json));
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
    const mode = $('apiMode').value;
    await prepareVibes(meta, controller.signal);
    if (controller.signal.aborted) throw new DOMException('已停止等待', 'AbortError');
    const response = await fetch($('endpoint').value.trim(), {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, image/png, application/zip' },
      body: JSON.stringify(mode === 'official' || /\/ai\/generate-image\/?$/.test(new URL($('endpoint').value.trim()).pathname) ? naiRequest(meta) : proxyRequest(meta))
    });
    if (!response.ok) throw new Error(explainHttpError(response.status, await response.text(), mode));
    const blob = await parseImageResponse(response, mode);
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
    latestArtwork = { ...meta, blob };
    $('resultImage').src = latestUrl;
    $('resultImage').hidden = false;
    $('emptyStage').hidden = true;
    $('downloadLatest').href = latestUrl;
    $('downloadLatest').download = `NAI_${Date.now()}_${safeFilenamePart(meta.model)}.${blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png'}`;
    $('downloadLatest').hidden = false;
    $('downloadLatestJpeg').hidden = false;
    const id = await dbAdd('artworks', { ...meta, blob, createdAt: Date.now(), imported: false });
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
      setStatus(savedArtworkId ? '图片已保存，配方更新未完成' : '图片已生成，但归档失败', 'err', `请先下载当前图片，不要重复生成。${error.message}`);
      if (savedArtworkId) await refreshData().catch(() => {});
      return;
    }
    if (controller.signal.aborted) {
      setStatus(timedOut ? '等待超时' : '已停止等待', 'err', '服务端可能仍在生成或扣费，请先检查服务商记录，不要立即重复提交。');
      return;
    }
    const cors = /Failed to fetch|NetworkError/i.test(error.message);
    setStatus('生成失败', 'err', cors ? '浏览器可能拦截了官方跨域请求，请改用可信反代。' : error.message);
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
  return {
    rawPrompt: prompt, artistPrompt: split.artist, positivePrompt: split.remaining,
    negativePrompt: negative, model, size: width && height ? `${width}x${height}` : '',
    steps: Number(json.steps) || 28, scale: Number(json.scale ?? json.cfg_scale) || 7,
    seed: json.seed !== undefined ? String(json.seed) : '', sampler: json.sampler || 'k_euler_ancestral',
    noiseSchedule: json.noise_schedule || json.noiseSchedule || 'karras', raw: { ...png.text, parsed: json }
  };
}

async function beginImageImport(file, targetRecipeId = '') {
  pendingImport = { file, targetRecipeId, metadata: null };
  const importing = pendingImport;
  if (importPreviewUrl) URL.revokeObjectURL(importPreviewUrl);
  importPreviewUrl = URL.createObjectURL(file);
  $('importPreview').src = importPreviewUrl;
  $('importStatus').textContent = '正在读取 PNG 中的生成信息……';
  $('importArtist').value = '';
  $('importPositive').value = '';
  $('importNegative').value = '';
  $('importRawPrompt').value = '';
  $('importRawMeta').textContent = '';
  $('importRecipeMode').value = targetRecipeId ? 'existing' : 'new';
  $('importRecipeSelect').value = targetRecipeId || recipesCache[0]?.id || '';
  updateImportMode();
  showDialog('imageImportDialog');
  try {
    const png = await readImageMetadata(file);
    if (pendingImport !== importing) return;
    const metadata = extractNovelAIMetadata(png);
    pendingImport.metadata = metadata;
    $('importArtist').value = metadata.artistPrompt;
    $('importPositive').value = metadata.positivePrompt;
    $('importNegative').value = metadata.negativePrompt;
    $('importRawPrompt').value = metadata.rawPrompt;
    $('importRawMeta').textContent = JSON.stringify(metadata.raw, null, 2);
    const artistName = metadata.artistPrompt.replace(/[{}[\]]/g, '').slice(0, 36);
    $('importRecipeName').value = artistName || file.name.replace(/\.(png|webp|jpe?g)$/i, '');
    $('importStatus').textContent = metadata.rawPrompt || metadata.negativePrompt
      ? '已读取图片内嵌信息；自动拆分后请确认三项内容。'
      : '图片中没有可识别的 NovelAI 提示词，可能经过截图或平台转码；仍可手动填写并归档。';
    if (png.text.ReadWarning) $('importStatus').textContent += ` ${png.text.ReadWarning}。`;
  } catch (error) {
    if (pendingImport !== importing) return;
    $('importStatus').textContent = `解析失败：${error.message}。仍可手动填写配方后保存图片。`;
  }
}

function updateImportMode() {
  const mode = $('importRecipeMode').value;
  $('importNameWrap').hidden = mode !== 'new';
  $('importExistingWrap').hidden = mode !== 'existing';
}

$('importRecipeMode').addEventListener('change', updateImportMode);
$('importImageBtn').onclick = () => { delete $('imageImportFile').dataset.recipeId; $('imageImportFile').click(); };
$('galleryImportBtn').onclick = () => { delete $('imageImportFile').dataset.recipeId; $('imageImportFile').click(); };
$('imageImportFile').onchange = event => {
  const file = event.target.files[0];
  if (file) beginImageImport(file, event.target.dataset.recipeId || '');
  event.target.value = '';
};

document.querySelectorAll('[data-import-copy]').forEach(button => {
  button.onclick = () => copyText($(button.dataset.importCopy).value, button);
});

$('imageImportForm').onsubmit = async event => {
  event.preventDefault();
  if (!pendingImport?.file) return;
  const mode = $('importRecipeMode').value;
  let recipeId = '';
  let recipe = null;
  if (mode === 'new') {
    const name = $('importRecipeName').value.trim();
    if (!name) { toast('请填写新配方名称'); return; }
    recipe = {
      id: makeId(), name, artistPrompt: $('importArtist').value.trim(),
      positivePrompt: $('importPositive').value.trim(), negativePrompt: $('importNegative').value.trim(),
      tags: [], coverArtworkId: null, createdAt: Date.now(), updatedAt: Date.now(),
      manualOrder: -Date.now(), defaultParams: pickParams(pendingImport.metadata || {}), source: 'png-import'
    };
    await dbAdd('recipes', recipe);
    recipeId = recipe.id;
  } else if (mode === 'existing') {
    recipeId = $('importRecipeSelect').value;
    recipe = recipesCache.find(item => item.id === recipeId) || null;
    if (!recipeId) { toast('请先选择一份已有配方'); return; }
  }
  const metadata = pendingImport.metadata || {};
  const artwork = {
    title: pendingImport.file.name.replace(/\.(png|webp|jpe?g)$/i, ''),
    scenePrompt: metadata.rawPrompt || '', sourcePrompt: metadata.rawPrompt || '',
    artistPrompt: $('importArtist').value.trim(), positivePrompt: $('importPositive').value.trim(),
    negativePrompt: $('importNegative').value.trim(), fullPrompt: metadata.rawPrompt || '',
    model: metadata.model || 'unknown', size: metadata.size || '', steps: metadata.steps || '',
    scale: metadata.scale || '', seed: metadata.seed || '', sampler: metadata.sampler || '',
    noiseSchedule: metadata.noiseSchedule || '', recipeId,
    category: recipe?.name || '未分类', tags: [], blob: pendingImport.file,
    imported: true, importedAt: Date.now(), createdAt: Date.now(), rawMetadata: metadata.raw || {}
  };
  const artworkId = await dbAdd('artworks', artwork);
  if (recipe && !recipe.coverArtworkId) {
    recipe.coverArtworkId = artworkId;
    recipe.updatedAt = Date.now();
    await dbPut('recipes', recipe);
  }
  closeDialog('imageImportDialog');
  pendingImport = null;
  await refreshData();
  if (recipeId) inspectRecipe(recipesCache.find(item => item.id === recipeId));
  switchView('gallery');
  toast(recipeId ? '图片与配方已归档' : '图片已保存，未关联配方');
};

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function deviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = makeId();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

function localDateString(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function dateBounds(startDate, endDate) {
  if (!startDate || !endDate) throw new Error('请选择完整的开始和结束日期');
  const start = new Date(`${startDate}T00:00:00`).getTime();
  const end = new Date(`${endDate}T23:59:59.999`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('日期格式不正确');
  if (start > end) throw new Error('开始日期不能晚于结束日期');
  return { start, end };
}

function itemInDateRange(item, bounds) {
  return [item.createdAt, item.updatedAt, item.importedAt]
    .map(Number)
    .filter(Number.isFinite)
    .some(timestamp => timestamp >= bounds.start && timestamp <= bounds.end);
}

function artworkCharacterIds(item = {}) {
  const ids = Array.isArray(item.characterIds) ? item.characterIds : (item.characterId ? [item.characterId] : []);
  return [...new Set(ids.map(String).filter(Boolean))];
}

const BACKUP_DATA_TYPES = ['artworks', 'recipes', 'characters', 'words', 'vibes'];
const BACKUP_TYPE_LABELS = { artworks: '图库', recipes: '配方', characters: '人物', words: '散词', vibes: 'Vibe' };

function selectedBackupTypes() {
  return new Set([...document.querySelectorAll('[name="backupDataType"]:checked')].map(input => input.value));
}

async function backupSelection(scope = 'all', startDate = '', endDate = '', selectedTypes = new Set(BACKUP_DATA_TYPES)) {
  const types = selectedTypes instanceof Set ? selectedTypes : new Set(selectedTypes || []);
  if (!types.size) throw new Error('请至少选择一类要备份的数据');
  const allArtworks = await dbAll('artworks');
  const allRecipes = await dbAll('recipes');
  const allWords = words();
  const allCharacters = characters();
  const allVibes = types.has('vibes') ? await dbAll('vibes') : [];
  const collections = (await dbAll('collections')).filter(item => types.has(item.libraryType));
  if (scope !== 'range') {
    return {
      artworks: types.has('artworks') ? allArtworks : [],
      recipes: types.has('recipes') ? allRecipes : [],
      words: types.has('words') ? allWords : [],
      characters: types.has('characters') ? allCharacters : [],
      vibes: allVibes, collections
    };
  }
  const bounds = dateBounds(startDate, endDate);
  const selectedArtworks = types.has('artworks') ? allArtworks.filter(item => itemInDateRange(item, bounds)) : [];
  const linkedRecipeIds = new Set(selectedArtworks.map(item => String(item.recipeId || '')).filter(Boolean));
  const linkedCharacterIds = new Set(selectedArtworks.flatMap(artworkCharacterIds));
  const linkedWordIds = new Set(selectedArtworks.flatMap(item => (Array.isArray(item.wordSources) ? item.wordSources : []).filter(Boolean).map(source => String(source.wordId || ''))));
  const linkedVibeIds = new Set(selectedArtworks.flatMap(item => (item.vibes || []).map(entry => entry.id)));
  for (const recipe of allRecipes.filter(item => linkedRecipeIds.has(String(item.id)))) for (const item of recipe.defaultParams?.vibes || []) linkedVibeIds.add(item.id);
  for (const mix of allVibes.filter(item => item.type === 'bundle' && itemInDateRange(item,bounds))) for (const item of mix.items) linkedVibeIds.add(item.id);
  return {
    artworks: selectedArtworks,
    recipes: types.has('recipes') ? allRecipes.filter(item => itemInDateRange(item, bounds) || linkedRecipeIds.has(String(item.id))) : [],
    words: types.has('words') ? allWords.filter(item => itemInDateRange(item, bounds) || linkedWordIds.has(String(item.id))) : [],
    characters: types.has('characters') ? allCharacters.filter(item => itemInDateRange(item, bounds) || linkedCharacterIds.has(String(item.id))) : [],
    vibes: allVibes.filter(item => itemInDateRange(item,bounds) || linkedVibeIds.has(item.id)), collections
  };
}

function withTransferId(item, type, sourceDeviceId) {
  return { ...item, transferId: item.transferId || `${sourceDeviceId}:${type}:${item.id}` };
}

async function updateBackupSummary() {
  const scope = document.querySelector('[name="backupScope"]:checked')?.value || 'all';
  const types = selectedBackupTypes();
  $('backupRange').hidden = scope !== 'range';
  $('backupStartDate').required = scope === 'range';
  $('backupEndDate').required = scope === 'range';
  $('backupSubmitBtn').disabled = !types.size;
  $('backupSummary').classList.toggle('is-warning', !types.size);
  try {
    const selected = await backupSelection(scope, $('backupStartDate').value, $('backupEndDate').value, types);
    $('backupSummary').textContent = `将备份 ${selected.artworks.length} 张图片、${selected.recipes.length} 份配方、${selected.characters.length} 个人物、${selected.words.length} 个词条和 ${selected.vibes.length} 份 Vibe 素材/组合`;
  } catch (error) {
    $('backupSummary').textContent = error.message;
  }
}

$('exportBtn').onclick = () => {
  const today = localDateString();
  if (!$('backupStartDate').value) $('backupStartDate').value = today;
  if (!$('backupEndDate').value) $('backupEndDate').value = today;
  updateBackupSummary();
  showDialog('backupDialog');
};

document.querySelectorAll('[name="backupScope"]').forEach(input => input.addEventListener('change', updateBackupSummary));
document.querySelectorAll('[name="backupDataType"]').forEach(input => input.addEventListener('change', updateBackupSummary));
$('backupStartDate').addEventListener('change', updateBackupSummary);
$('backupEndDate').addEventListener('change', updateBackupSummary);

$('backupForm').onsubmit = async event => {
  event.preventDefault();
  try {
    const scope = document.querySelector('[name="backupScope"]:checked')?.value || 'all';
    const startDate = $('backupStartDate').value;
    const endDate = $('backupEndDate').value;
    const types = selectedBackupTypes();
    const selected = await backupSelection(scope, startDate, endDate, types);
    const sourceDeviceId = deviceId();
    const packed = [];
    for (const source of selected.artworks) {
      const artwork = { ...withTransferId(source, 'artwork', sourceDeviceId), contentHash: source.contentHash || await blobFingerprint(source.blob) };
      if (!source.transferId || !source.contentHash) await dbPut('artworks', artwork);
      const exportedArtwork = { ...artwork };
      if (Array.isArray(artwork.wordSources)) exportedArtwork.wordSources = artwork.wordSources.filter(Boolean).map(source => {
        const word = currentWordSourceIndex().find(entry => String(entry.word.id) === String(source.wordId))?.word;
        return word ? { ...source, author: word.author || '', sourceUrl: word.sourceUrl || '', name: word.name || '' } : source;
      });
      if (!types.has('recipes')) exportedArtwork.recipeId = '';
      if (!types.has('characters')) {
        exportedArtwork.characterId = '';
        exportedArtwork.characterIds = [];
      }
      packed.push({ ...exportedArtwork, blob: await blobToDataURL(source.blob) });
    }
    const packedRecipes = [];
    for (const source of selected.recipes) {
      const recipe = withTransferId(source, 'recipe', sourceDeviceId);
      if (!source.transferId) await dbPut('recipes', recipe);
      packedRecipes.push(recipe);
    }
    const packedWords = selected.words.map(item => withTransferId(item, 'word', sourceDeviceId));
    const packedCharacters = selected.characters.map(item => withTransferId(item, 'character', sourceDeviceId));
    if (packedWords.some((item, index) => item.transferId !== selected.words[index]?.transferId)) {
      const identities = new Map(packedWords.map(item => [String(item.id), item.transferId]));
      localStorage.setItem(WORDS_KEY, JSON.stringify(words().map(item => identities.has(String(item.id)) ? { ...item, transferId: identities.get(String(item.id)) } : item)));
    }
    if (packedCharacters.some((item, index) => item.transferId !== selected.characters[index]?.transferId)) {
      const identities = new Map(packedCharacters.map(item => [String(item.id), item.transferId]));
      localStorage.setItem(CHARACTERS_KEY, JSON.stringify(characters().map(item => identities.has(String(item.id)) ? { ...item, transferId: identities.get(String(item.id)) } : item)));
    }
    const payload = {
      app: 'NAI 镜头台', version: 9, exportedAt: new Date().toISOString(),
      scope: scope === 'range' ? { type: 'range', startDate, endDate } : { type: 'all' },
      includedTypes: BACKUP_DATA_TYPES.filter(type => types.has(type)),
      artworks: packed,
      recipes: packedRecipes,
      words: packedWords,
      characters: packedCharacters,
      vibeRecords: selected.vibes,
      collections: selected.collections.map(item => withTransferId(item, 'collection', sourceDeviceId))
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    const rangeLabel = scope === 'range' ? `${startDate}至${endDate}` : `全部_${localDateString()}`;
    const typeLabel = types.size === BACKUP_DATA_TYPES.length ? '全部内容' : BACKUP_DATA_TYPES.filter(type => types.has(type)).map(type => BACKUP_TYPE_LABELS[type]).join('+');
    anchor.download = `NAI镜头台备份_${typeLabel}_${rangeLabel}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    closeDialog('backupDialog');
    toast(`已备份 ${packed.length} 张图片、${payload.recipes.length} 份配方、${payload.characters.length} 个人物、${payload.words.length} 个词条和 ${payload.vibeRecords.length} 份 Vibe`);
  } catch (error) {
    toast(`备份失败：${error.message}`);
  }
};

$('importBtn').onclick = () => $('importFile').click();
function mergeRecord(existing, incoming, type = '') {
  const merged = { ...existing };
  const before = JSON.stringify(merged);
  merged.tags = [...new Set([...(existing.tags || []), ...(incoming.tags || [])])];
  ['name', 'category', 'note', 'author', 'sourceUrl', 'transferId', 'folderId'].forEach(key => {
    if (!merged[key] && incoming[key]) merged[key] = incoming[key];
  });
  if (existing.favorite || incoming.favorite) merged.favorite = true;
  if (existing.lastUsedAt || incoming.lastUsedAt) merged.lastUsedAt = Math.max(existing.lastUsedAt || 0, incoming.lastUsedAt || 0);
  if (type === 'recipe') merged.defaultParams = { ...(incoming.defaultParams || {}), ...(existing.defaultParams || {}) };
  if (type === 'recipe' && !merged.coverArtworkId && incoming.coverArtworkId) merged._incomingCoverArtworkId = incoming.coverArtworkId;
  if (type === 'artwork') {
    if (!Array.isArray(existing.wordSources) && Array.isArray(incoming.wordSources)) merged.wordSources = incoming.wordSources;
    merged.characterIds = [...new Set([...artworkCharacterIds(existing), ...artworkCharacterIds(incoming)])];
    merged.characterId = merged.characterIds[0] || '';
  }
  const changed = before !== JSON.stringify(merged);
  if (changed) merged.updatedAt = Math.max(existing.updatedAt || 0, incoming.updatedAt || 0, Date.now());
  return { record: merged, changed };
}

function prepareRecordPlan(incoming, existing, keyFn, type) {
  const idMap = new Map();
  const additions = [];
  const merges = [];
  let skipped = 0;
  let conflicts = 0;
  const byId = new Map(existing.map(item => [String(item.id), item]));
  const byTransferId = new Map(existing.filter(item => item.transferId).map(item => [item.transferId, item]));
  const byContent = new Map(existing.map(item => [keyFn(item), item]).filter(([key]) => key));
  const usedIds = new Set(existing.map(item => String(item.id)));
  const pendingIds = new Set();
  incoming.forEach(source => {
    const oldKey = String(source.id ?? '');
    const contentKey = keyFn(source);
    const matched = (source.transferId && byTransferId.get(source.transferId)) || (contentKey && byContent.get(contentKey));
    if (matched) {
      if (oldKey) idMap.set(oldKey, matched.id);
      const merged = mergeRecord(matched, source, type);
      if (merged.changed) {
        Object.assign(matched, merged.record);
        if (!pendingIds.has(String(matched.id)) && !merges.includes(matched)) merges.push(matched);
      } else skipped += 1;
      return;
    }
    const idMatch = oldKey ? byId.get(oldKey) : null;
    let newId = source.id;
    if (newId === undefined || newId === null || usedIds.has(String(newId))) {
      if (idMatch) conflicts += 1;
      newId = makeId();
    }
    const record = { ...source, id: newId };
    usedIds.add(String(newId));
    if (oldKey) idMap.set(oldKey, newId);
    additions.push(record);
    pendingIds.add(String(newId));
    byId.set(String(newId), record);
    if (record.transferId) byTransferId.set(record.transferId, record);
    if (contentKey) byContent.set(contentKey, record);
  });
  return { idMap, additions, merges, skipped, conflicts };
}

async function blobFingerprint(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (crypto.subtle) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
  }
  let hash = 2166136261;
  bytes.forEach(value => { hash ^= value; hash = Math.imul(hash, 16777619); });
  return `fnv-${bytes.length}-${(hash >>> 0).toString(16)}`;
}

function normalizeBackupPayload(input) {
  if (!input || typeof input !== 'object') throw new Error('备份内容不是有效对象');
  const nested = input.data && typeof input.data === 'object' ? input.data : {};
  const source = { ...nested, ...input };
  const readArray = names => {
    for (const name of names) {
      const value = source[name];
      if (Array.isArray(value)) return value;
      if (typeof value === 'string') {
        try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed; } catch {}
      }
      if (value && typeof value === 'object') return Object.values(value);
    }
    return [];
  };
  const artworkSource = readArray(['artworks', 'images', 'gallery', 'pictures']);
  const recipeSource = readArray(['recipes', 'recipeLibrary', 'folders', 'presets']);
  const wordSource = readArray(['words', 'wordLibrary', 'promptLibrary', 'promptWords']);
  const characterSource = readArray(['characters', 'characterLibrary', 'charactersLibrary', 'people']);
  const vibeSource = readArray(['vibeRecords', 'vibes']);
  const collectionSource = readArray(['collections']);
  const recognized = collectionSource.length || artworkSource.length || recipeSource.length || wordSource.length || characterSource.length || vibeSource.length || source.app || source.version;
  if (!recognized) throw new Error('没有找到图片、配方、人物或散词数据，请确认选择的是镜头台 JSON 备份');
  return {
    ...source,
    vibeRecords: vibeSource,
    collections: collectionSource.map(normalizeCollection),
    artworks: artworkSource.map(item => normalizeLibraryRecord(item, 'artwork', true)),
    recipes: recipeSource.map(item => normalizeLibraryRecord({ ...item, artistPrompt: item.artistPrompt ?? item.artist ?? '', positivePrompt: item.positivePrompt ?? item.positive ?? '', negativePrompt: item.negativePrompt ?? item.negative ?? '' }, 'recipe', true)),
    words: wordSource.map(item => normalizeLibraryRecord({ ...item, kind: item.kind || item.type || 'artist', content: item.content ?? item.value ?? item.prompt ?? '' }, 'word', true)),
    characters: characterSource.map(item => normalizeLibraryRecord({ ...item, fullPrompt: item.fullPrompt ?? item.prompt ?? item.description ?? '' }, 'character', true))
  };
}

async function analyzeBackupImport(data) {
  data = normalizeBackupPayload(data);
  const collectionPlan = prepareRecordPlan(data.collections, await dbAll('collections'), item => `${item.libraryType}:${item.name.trim().toLocaleLowerCase()}`, 'collection');
  for (const type of ['artworks', 'recipes', 'words', 'characters']) {
    for (const item of data[type]) {
      const folder = data.collections.find(folder => folder.libraryType === type && folder.id === String(item.folderId || ''));
      item.folderId = folder ? collectionPlan.idMap.get(folder.id) || '' : '';
    }
  }
  const vibeRecords = await planVibeImport(data.vibeRecords);
  for (const artwork of data.artworks) if(Array.isArray(artwork.vibes)) artwork.vibes = artwork.vibes.map(item => ({...item,id:vibeRecords.idMap.get(String(item.id))||item.id}));
  for (const recipe of data.recipes) if(Array.isArray(recipe.defaultParams?.vibes)) recipe.defaultParams.vibes = recipe.defaultParams.vibes.map(item => ({...item,id:vibeRecords.idMap.get(String(item.id))||item.id}));
  const existingRecipes = await dbAll('recipes');
  const existingArtworks = await dbAll('artworks');
  const existingWords = words();
  const existingCharacters = characters();
  const characterPlan = prepareRecordPlan(data.characters, existingCharacters, characterContentKey, 'character');
  const recipePlan = prepareRecordPlan(data.recipes, existingRecipes, recipeContentKey, 'recipe');
  const wordPlan = prepareRecordPlan(data.words, existingWords, wordContentKey, 'word');
  for (const artwork of data.artworks) if (Array.isArray(artwork.wordSources)) {
    artwork.wordSources = artwork.wordSources.filter(source => source && typeof source.content === 'string').map(source => ({ ...source, wordId: wordPlan.idMap.get(String(source.wordId)) || '' }));
  }
  const artworkIdMap = new Map();
  const additions = [];
  const merges = [];
  let skipped = 0;
  const byHash = new Map();
  for (const item of existingArtworks) {
    const hash = await blobFingerprint(item.blob);
    byHash.set(hash, item);
  }
  for (const source of data.artworks) {
    const blob = await b64Blob(source.blob);
    const hash = await blobFingerprint(blob);
    const matched = byHash.get(hash);
    const oldKey = String(source.id ?? '');
    if (matched) {
      if (oldKey) {
        if (matched._oldIds) matched._oldIds.push(oldKey);
        else artworkIdMap.set(oldKey, matched.id);
      }
      const mappedSource = { ...source, characterIds: artworkCharacterIds(source).map(id => characterPlan.idMap.get(String(id)) || id), blob: matched.blob, contentHash: hash };
      const merged = mergeRecord(matched, mappedSource, 'artwork');
      if (merged.changed) {
        Object.assign(matched, merged.record);
        if (!matched._oldIds && !merges.includes(matched)) merges.push(matched);
      }
      else skipped += 1;
      continue;
    }
    const mappedCharacterIds = artworkCharacterIds(source).map(id => characterPlan.idMap.get(String(id)) || id);
    additions.push({ ...source, id: undefined, recipeId: recipePlan.idMap.get(String(source.recipeId || '')) || source.recipeId || '', characterIds: mappedCharacterIds, characterId: mappedCharacterIds[0] || '', blob, contentHash: hash, _oldIds: oldKey ? [oldKey] : [] });
    byHash.set(hash, additions[additions.length - 1]);
  }
  const plans = { data, collectionPlan, vibeRecords, characterPlan, recipePlan, wordPlan, artworkPlan: { additions, merges, skipped, idMap: artworkIdMap } };
  plans.stats = {
    added: additions.length + recipePlan.additions.length + wordPlan.additions.length + characterPlan.additions.length,
    merged: merges.length + recipePlan.merges.length + wordPlan.merges.length + characterPlan.merges.length,
    skipped: skipped + recipePlan.skipped + wordPlan.skipped + characterPlan.skipped,
    conflicts: recipePlan.conflicts + wordPlan.conflicts + characterPlan.conflicts,
    artworkCount: additions.length, recipeCount: recipePlan.additions.length, wordCount: wordPlan.additions.length, characterCount: characterPlan.additions.length,
    artworkMerged: merges.length, recipeMerged: recipePlan.merges.length, wordMerged: wordPlan.merges.length, characterMerged: characterPlan.merges.length,
    artworkSkipped: skipped, recipeSkipped: recipePlan.skipped, wordSkipped: wordPlan.skipped, characterSkipped: characterPlan.skipped
  };
  plans.stats.vibeCount = vibeRecords.length;
  plans.stats.collectionCount = collectionPlan.additions.length;
  plans.stats.added += collectionPlan.additions.length;
  plans.stats.merged += collectionPlan.merges.length;
  plans.stats.skipped += collectionPlan.skipped;
  plans.stats.conflicts += collectionPlan.conflicts;
  plans.stats.added += vibeRecords.newCount;
  plans.stats.merged += vibeRecords.length-vibeRecords.newCount;
  return plans;
}

async function restoreBackupData(data, suppliedPlan = null) {
  if (restoreInProgress) throw new Error('另一个备份正在恢复，请稍后再试');
  restoreInProgress = true;
  const previousCharacters = localStorage.getItem(CHARACTERS_KEY);
  const previousWords = localStorage.getItem(WORDS_KEY);
  let localWritten = false;
  try {
  const plan = suppliedPlan || await analyzeBackupImport(data);
  const existingCharacters = characters();
  const existingWords = words();
  const replaceMerged = (existing, merges) => {
    const map = new Map(merges.map(item => [String(item.id), item]));
    return existing.map(item => map.get(String(item.id)) || item);
  };
  localWritten = true;
  if (plan.characterPlan.additions.length || plan.characterPlan.merges.length) localStorage.setItem(CHARACTERS_KEY, JSON.stringify([...plan.characterPlan.additions, ...replaceMerged(existingCharacters, plan.characterPlan.merges)]));
  if (plan.wordPlan.additions.length || plan.wordPlan.merges.length) localStorage.setItem(WORDS_KEY, JSON.stringify([...plan.wordPlan.additions, ...replaceMerged(existingWords, plan.wordPlan.merges)]));
  if (characters().length < existingCharacters.length + plan.characterPlan.additions.length) throw new Error('人物库写入没有完成，请检查浏览器存储空间');
  if (words().length < existingWords.length + plan.wordPlan.additions.length) throw new Error('散词库写入没有完成，请检查浏览器存储空间');
  await new Promise((resolve, reject) => {
  const transaction = db.transaction(['artworks', 'recipes', 'vibes', 'collections'], 'readwrite');
  transaction.oncomplete = resolve;
  transaction.onabort = () => reject(transaction.error || new Error('备份恢复写入失败，图片与配方已撤销'));
  transaction.onerror = () => {};
  const artworks = transaction.objectStore('artworks');
  const recipes = transaction.objectStore('recipes');
  const writeRecipes = () => {
    for (const record of plan.recipePlan.merges) {
      const recipe = { ...record };
      if (!recipe.coverArtworkId && recipe._incomingCoverArtworkId) recipe.coverArtworkId = plan.artworkPlan.idMap.get(String(recipe._incomingCoverArtworkId)) || null;
      delete recipe._incomingCoverArtworkId;
      recipes.put(recipe);
    }
    for (const source of plan.recipePlan.additions) {
      recipes.put({ ...source, coverArtworkId: plan.artworkPlan.idMap.get(String(source.coverArtworkId ?? '')) || null });
    }
  };
  try {
  for (const record of [...plan.collectionPlan.additions, ...plan.collectionPlan.merges]) transaction.objectStore('collections').put(record);
  for (const record of plan.vibeRecords || []) transaction.objectStore('vibes').put(record);
  for (const record of plan.artworkPlan.merges) artworks.put(record);
  let remaining = plan.artworkPlan.additions.length;
  if (!remaining) writeRecipes();
  for (const artwork of plan.artworkPlan.additions) {
    const record = { ...artwork };
    delete record.id;
    delete record._oldIds;
    const request = artworks.add(record);
    request.onsuccess = () => {
      for (const oldId of artwork._oldIds) plan.artworkPlan.idMap.set(oldId, request.result);
      if (!--remaining) {
        try { writeRecipes(); } catch { transaction.abort(); }
      }
    };
  }
  } catch (error) { transaction.abort(); reject(error); }
  });
  localWritten = false;
  await refreshCollections();
  renderCharacters();
  renderWords();
  updateActiveCharacterLabel();
  await refreshData();
  await refreshVibes();
  return { ...plan.stats, skippedCount: plan.stats.skipped, mergedCount: plan.stats.merged };
  } catch (error) {
    if (localWritten) {
      for (const [key, value] of [[CHARACTERS_KEY, previousCharacters], [WORDS_KEY, previousWords]]) {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    }
    throw error;
  } finally { restoreInProgress = false; }
}

function showRestorePreview(data, plan) {
  pendingBackupImport = { data: plan.data || data, plan };
  $('restorePreviewStats').innerHTML = [
    ['新增', plan.stats.added], ['补全', plan.stats.merged], ['跳过重复', plan.stats.skipped]
  ].map(([label, count]) => `<div class="restore-stat"><b>${count}</b><span>${label}</span></div>`).join('');
  $('restorePreviewDetail').textContent = `新增：${plan.stats.artworkCount} 张图片、${plan.stats.recipeCount} 份配方、${plan.stats.characterCount} 个人物、${plan.stats.wordCount} 个词条。补全：图片 ${plan.stats.artworkMerged}、配方 ${plan.stats.recipeMerged}、人物 ${plan.stats.characterMerged}、散词 ${plan.stats.wordMerged}。跳过重复：图片 ${plan.stats.artworkSkipped}、配方 ${plan.stats.recipeSkipped}、人物 ${plan.stats.characterSkipped}、散词 ${plan.stats.wordSkipped}${plan.stats.conflicts ? `。另有 ${plan.stats.conflicts} 个编号冲突会保留为新记录` : ''}`;
  showDialog('restorePreviewDialog');
  $('restorePreviewDetail').textContent += `。Vibe 素材/组合：${plan.stats.vibeCount || 0} 项`;
}

$('cancelRestorePreview').onclick = () => { pendingBackupImport = null; closeDialog('restorePreviewDialog'); };
$('confirmRestorePreview').onclick = async () => {
  if (!pendingBackupImport) return;
  const button = $('confirmRestorePreview');
  button.disabled = true;
  try {
    const restored = await restoreBackupData(pendingBackupImport.data, pendingBackupImport.plan);
    closeDialog('restorePreviewDialog');
    toast(`已合并 ${restored.artworkCount} 张图片、${restored.recipeCount} 份配方；补全 ${restored.mergedCount} 项，跳过 ${restored.skippedCount} 项重复`);
    pendingBackupImport = null;
  } catch (error) {
    toast(`恢复失败：${error.message}`);
  } finally { button.disabled = false; }
};

$('importFile').onchange = async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    toast('正在核对重复内容与图片……');
    showRestorePreview(data, await analyzeBackupImport(data));
  } catch (error) {
    toast(`恢复失败：${error.message}`);
  } finally { event.target.value = ''; }
};

$('apiMode').onchange = () => {
  if ($('apiMode').value === 'official' && (!$('endpoint').value || $('endpoint').value.includes('/v1/'))) {
    $('endpoint').value = 'https://image.novelai.net/ai/generate-image';
  } else if ($('apiMode').value === 'proxy' && $('endpoint').value.includes('image.novelai.net/ai/generate-image')) {
    $('endpoint').value = 'https://你的站点域名/v1/images/generations';
  }
  saveSettings();
};

$('model').addEventListener('change', () => { updateModelUI(); saveSettings(); });
fields.forEach(id => {
  const element = $(id);
  if (!element || id === 'recipeSelect' || id === 'model' || id === 'apiMode') return;
  element.addEventListener('input', saveSettings);
  element.addEventListener('change', saveSettings);
});
$('token').addEventListener('input', updateApiStatus);
$('copyAllBtn').onclick = () => copyText(fullPrompt());
$('downloadLatest').onclick = () => toast('开始下载最新图片');
$('downloadLatestJpeg').onclick = () => downloadArtworkJpeg(latestArtwork, $('downloadLatestJpeg'));
$('gallerySearch').addEventListener('input', debounce(renderRecipes));
$('gallerySort').addEventListener('change', renderRecipes);
$('librarySearch').addEventListener('input', debounce(renderImageLibrary));
$('librarySort').addEventListener('change', () => { saveSettings(); renderImageLibrary(); });
$('characterPrompt').addEventListener('input', () => {
  const value = $('characterPrompt').value;
  const remaining = selectedCharacterIds().filter(id => {
    const character = characters().find(item => item.id === id);
    const prompt = character ? characterPrompt(character) : '';
    return prompt && value.includes(prompt);
  });
  if (remaining.length !== selectedCharacterIds().length) setSelectedCharacterIds(remaining);
});

$('testPresetBtn').onclick = () => {
  $('model').value = 'nai-diffusion-5-full';
  $('size').value = '512x768';
  $('steps').value = '28';
  $('scale').value = '7';
  $('sampler').value = 'k_euler_ancestral';
  $('noiseSchedule').value = 'karras';
  if (!$('scenePrompt').value.trim()) $('scenePrompt').value = '1girl, simple background';
  updateModelUI();
  saveSettings();
  toast('已套用 V5 Full 小尺寸 28 步测试参数');
};

// Vibe assets and reusable mixes live in IndexedDB, not localStorage.
const VIBE_SELECTION_KEY = 'nai_studio_vibe_selection_v1';
let vibeCache = [];
let vibeSelection = [];
let vibeBusy = false;

function vibeSupported(model) { return /^nai-diffusion-(?:3$|4(?:-5)?-)/.test(model); }
function vibeNumber(value, fallback = 0.6) { const number = Number(value); return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback; }
function cleanVibeSelection(items) {
  const seen=new Set();
  return Array.isArray(items) ? items.filter(item => {if(!item||typeof item.id!=='string'||seen.has(item.id))return false;seen.add(item.id);return true;}).slice(0,16).map(item => ({id:item.id, strength:vibeNumber(item.strength), information:vibeNumber(item.information,1), enabled:item.enabled !== false})) : [];
}
function saveVibeSelection() { localStorage.setItem(VIBE_SELECTION_KEY, JSON.stringify(cleanVibeSelection(vibeSelection))); }
function vibeEncoding(asset, model, information) {
  return (asset?.encodings || []).find(item => item.model === model && Math.abs(item.information-information) < 0.00001);
}
function vibeRequestFields(meta) {
  if (!vibeSupported(meta.model) || !meta.vibes?.length) return {};
  if(meta.vibes.some(item=>typeof item.encoding!=='string'||!item.encoding)) throw new Error('Vibe 数据尚未准备完成');
  return {
    reference_image_multiple: meta.vibes.map(item => item.encoding),
    reference_information_extracted_multiple: meta.vibes.map(item => item.information),
    reference_strength_multiple: meta.vibes.map(item => item.strength)
  };
}
function vibeEndpoint() {
  const url = new URL($('endpoint').value.trim());
  if (!['https:','http:'].includes(url.protocol)) throw new Error('Vibe 接口必须是 HTTP/HTTPS 地址');
  if ($('apiMode').value === 'official' || /\/ai\/generate-image\/?$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/ai\/generate-image\/?$/, '/ai/encode-vibe');
    if (!/\/ai\/encode-vibe$/.test(url.pathname)) throw new Error('请使用官方格式的 /ai/generate-image 接口');
    return url.href;
  }
  const explicit = $('vibeEncodeEndpoint').value.trim();
  if (!safeHttpUrl(explicit)) throw new Error('这个兼容站点需要在 Vibe 设置中填写编码接口，或导入已编码的 Vibe 文件');
  return explicit;
}
async function prepareVibes(meta, signal) {
  if (!meta.vibes?.length) return;
  if (!vibeSupported(meta.model)) throw new Error('当前模型不支持 Vibe');
  if ($('apiMode').value === 'proxy' && !/\/ai\/generate-image\/?$/.test(new URL($('endpoint').value.trim()).pathname) && !$('vibeProxySupported').checked) {
    throw new Error('请先确认第三方站点支持 Vibe 参数；在 Vibe 设置中勾选后才能发送');
  }
  const missing = meta.vibes.filter(item => !vibeEncoding(vibeCache.find(asset => asset.id === item.id), meta.model, item.information) && meta.model !== 'nai-diffusion-3');
  if (missing.length && !confirm(`这次需要编码 ${missing.length} 份 Vibe，官方通常每份收取 2 Anlas（第三方以站点定价为准）。修改信息提取量或模型可能重新收费。是否继续？`)) throw new Error('已取消 Vibe 编码，未发送生成请求');
  if (meta.vibes.length > 4 && !confirm('超过 4 个 Vibe，官方 V4 及以上通常每多一个增加 2 Anlas 生图费用。继续生成？')) throw new Error('已取消生成');
  // Preflight every asset and route before any billable encoding request.
  for (const item of meta.vibes) {
    const asset = vibeCache.find(record => record.id === item.id && record.type === 'asset');
    if (!asset) throw new Error('有 Vibe 素材已删除，请重新从库选择');
    if ((meta.model === 'nai-diffusion-3' || !vibeEncoding(asset,meta.model,item.information)) && !asset.image) throw new Error(`“${asset.name}”没有此模型/提取量的编码，也没有原图；请使用已有提取量或重新导入原图`);
  }
  const encodeUrl = missing.length ? vibeEndpoint() : '';
  for (const item of meta.vibes) {
    if (signal?.aborted) throw new DOMException('已停止等待','AbortError');
    const asset = vibeCache.find(record => record.id === item.id);
    item.name = asset.name;
    item.model = meta.model;
    if (meta.model === 'nai-diffusion-3') { item.encoding = asset.image.replace(/^data:[^;]+;base64,/, ''); continue; }
    let encoded = vibeEncoding(asset,meta.model,item.information);
    if (!encoded) {
      setStatus('正在准备 Vibe', 'run', `编码：${asset.name}；完成后将继续生图`);
      const response = await fetch(encodeUrl, {method:'POST', signal, headers:{Authorization:`Bearer ${$('token').value.trim()}`, 'Content-Type':'application/json'}, body:JSON.stringify({image:asset.image.replace(/^data:[^;]+;base64,/, ''), model:meta.model, information_extracted:item.information})});
      if (!response.ok) throw new Error(explainHttpError(response.status, await response.text()));
      if ((response.headers.get('content-type') || '').includes('json')) throw new Error('编码接口返回 JSON，预期官方二进制编码格式；请核对站点协议');
      const bytes = new Uint8Array(await readLimitedResponse(response, 8*1024*1024));
      if (!bytes.length || /^(?:\s*<|\s*\{)/.test(new TextDecoder().decode(bytes.slice(0,32)))) throw new Error('编码接口没有返回有效的二进制 Vibe');
      let binary = ''; for (let i=0;i<bytes.length;i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
      encoded = {model:meta.model,information:item.information,encoding:btoa(binary)};
      const next = {...asset,encodings:[...asset.encodings,encoded],updatedAt:Date.now()};
      Object.assign(asset,next);
      try { await dbPut('vibes',next); }
      catch { renderVibePanel();throw new Error('Vibe 已编码，但浏览器缓存写入失败。请先从 Vibe 库导出这份素材；当前页面仍保留编码，避免重复付费。'); }
    }
    item.encoding = encoded.encoding;
  }
  renderVibePanel();
}
async function restoreVibeSelection(items, model = '') {
  try {
  for(const item of Array.isArray(items)?items.slice(0,16):[]) {
    if(!vibeCache.some(asset=>asset.id===item.id)&&item.encoding) {
      const asset=normalizeVibeAsset({id:item.id,name:item.name||'图片中复用的 Vibe',encodings:[{model:item.model||model,information:item.information,encoding:item.encoding}]});
      await dbPut('vibes',asset);vibeCache.push(asset);
    }
  }
  vibeSelection = cleanVibeSelection(items);
  saveVibeSelection(); renderVibePanel();
  } catch(error) { toast(`Vibe 复用失败：${error.message}`); }
}
function normalizeVibeModel(key) {
  const compact = String(key).toLowerCase().replace(/[^a-z0-9]/g,'').replace('naidiffusion','').replace(/^v/,'');
  if (/^45/.test(compact)) return compact.includes('curated') ? 'nai-diffusion-4-5-curated' : 'nai-diffusion-4-5-full';
  if (/^4/.test(compact)) return compact.includes('curated') ? 'nai-diffusion-4-curated' : 'nai-diffusion-4-full';
  return compact === '3' ? 'nai-diffusion-3' : '';
}
function validVibeBase64(value, max = 12*1024*1024) {
  if (typeof value !== 'string' || !value.length || value.length > max || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4) throw new Error('Vibe 编码数据无效或过大');
  return value;
}
function safeVibeImage(value, max = MAX_IMAGE_BYTES*1.4) {
  if (!value) return '';
  if (typeof value !== 'string' || value.length > max || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(value)) throw new Error('Vibe 原图或缩略图格式无效');
  return value;
}
function normalizeVibeAsset(source) {
  if (!source || typeof source !== 'object') throw new Error('Vibe 素材无效');
  const encodings = [];
  if (Array.isArray(source.encodings)) {
    for (const item of source.encodings) {
      const model = normalizeVibeModel(item.model);
      if (model) encodings.push({model,information:vibeNumber(item.information,1),encoding:validVibeBase64(item.encoding)});
    }
  } else if (source.encodings && typeof source.encodings === 'object') {
    for (const [key,group] of Object.entries(source.encodings)) {
      const model = normalizeVibeModel(key); if (!model || !group || typeof group !== 'object') continue;
      for (const entry of Object.values(group)) if (entry?.encoding) encodings.push({model,information:vibeNumber(entry.params?.information_extracted,1),encoding:validVibeBase64(entry.encoding)});
    }
  }
  if (encodings.length > 64) throw new Error('一份 Vibe 包含过多编码版本');
  let image = source.image || '';
  if (image && !image.startsWith('data:')) image = 'data:image/png;base64,' + validVibeBase64(image,MAX_IMAGE_BYTES*1.4);
  image = safeVibeImage(image);
  if (!image && !encodings.length) throw new Error('文件里没有可用的原图或 Vibe 编码');
  return {id:String(source.id || makeId()),type:'asset',name:String(source.name || '导入的 Vibe').slice(0,200),tags:splitTags(Array.isArray(source.tags)?source.tags.join(','):source.tags),favorite:Boolean(source.favorite),image,thumbnail:safeVibeImage(source.thumbnail,1024*1024),encodings,createdAt:Number(source.createdAt)||Date.now(),updatedAt:Date.now()};
}
async function planVibeImport(sources) {
  if (!Array.isArray(sources) || sources.length>1000) throw new Error('Vibe 库格式无效或记录过多');
  const existing = await dbAll('vibes'), records=[], idMap=new Map();
  const byHash=new Map();
  for (const record of existing.filter(item=>item.type==='asset')) byHash.set(await blobFingerprint(new Blob([record.image||JSON.stringify(record.encodings)])),record);
  for (const source of sources.filter(item=>item?.type!=='bundle')) {
    const record=normalizeVibeAsset(source), hash=await blobFingerprint(new Blob([record.image||JSON.stringify(record.encodings)]));
    const matched=byHash.get(hash);
    if (matched) {
      idMap.set(String(source.id||record.id),matched.id);
      const merged={...matched,tags:[...new Set([...(matched.tags||[]),...record.tags])],favorite:matched.favorite||record.favorite,encodings:[...(matched.encodings||[])]};
      for(const entry of record.encodings) if(!vibeEncoding(merged,entry.model,entry.information))merged.encodings.push(entry);
      Object.assign(matched,merged);
      if(!records.includes(matched))records.push(matched);
    } else {
      if(existing.some(item=>item.id===record.id)||records.some(item=>item.id===record.id))record.id=makeId();
      idMap.set(String(source.id||record.id),record.id);records.push(record);byHash.set(hash,record);
    }
  }
  for(const source of sources.filter(item=>item?.type==='bundle')) {
    if(!Array.isArray(source.items)||source.items.length>16||source.items.some(item=>!item||typeof item.id!=='string'))throw new Error('Vibe 组合格式无效，每组最多 16 项');
    const items=cleanVibeSelection(source.items).map(item=>({...item,id:idMap.get(item.id)||item.id}));
    if(items.some(item=>![...existing,...records].some(record=>record.id===item.id&&record.type==='asset')))throw new Error('Vibe 组合缺少关联素材，请连同素材一起导入');
    const name=String(source.name||'导入组合').slice(0,200);
    const matched=[...existing,...records].find(item=>item.type==='bundle'&&item.name===name&&JSON.stringify(item.items)===JSON.stringify(items));
    const record={id:matched?.id||makeId(),type:'bundle',name,items,createdAt:matched?.createdAt||Date.now()};
    if(!records.some(item=>item.id===record.id))records.push(record);
    if(source.id)idMap.set(String(source.id),record.id);
  }
  records.idMap=idMap;
  records.newCount=records.filter(record=>!existing.some(item=>item.id===record.id)).length;
  return records;
}
async function importVibeRecords(sources) {
  const records=await planVibeImport(sources);
  await new Promise((resolve,reject)=>{const tx=db.transaction('vibes','readwrite');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||new Error('Vibe 导入失败'));try{for(const record of records)tx.objectStore('vibes').put(record);}catch(error){tx.abort();reject(error);}});
  await refreshVibes();return records;
}
async function importVibeDocument(data, filename = '导入组合') {
  if(!data||typeof data!=='object')throw new Error('Vibe 文件不是有效对象');
  if(Array.isArray(data.vibeRecords))return importVibeRecords(data.vibeRecords);
  if(Array.isArray(data.vibes)) {
    const assets=data.vibes.map(item=>({...item,id:String(item.id||makeId())}));
    return importVibeRecords([...assets,{type:'bundle',name:String(data.name||filename).replace(/\.[^.]+$/,''),items:assets.map(item=>({id:item.id,strength:vibeNumber(item.importInfo?.strength),information:vibeNumber(item.importInfo?.information_extracted,1),enabled:true}))}]);
  }
  return importVibeRecords([data]);
}
async function addVibeImage(file) {
  if(file.size>MAX_IMAGE_BYTES)throw new Error('参考图超过 64 MB');
  const blob=await validateGeneratedImage(file);
  const source=await imageSourceFromBlob(blob), canvas=document.createElement('canvas');
  const ratio=Math.min(1,128/Math.max(source.width,source.height));canvas.width=Math.max(1,Math.round(source.width*ratio));canvas.height=Math.max(1,Math.round(source.height*ratio));
  canvas.getContext('2d').drawImage(source,0,0,canvas.width,canvas.height);if(source.close)source.close();
  const records=await importVibeRecords([{name:file.name.replace(/\.[^.]+$/,''),image:await blobToDataURL(blob),thumbnail:canvas.toDataURL('image/jpeg',.8)}]);
  if(vibeSelection.length<16&&!vibeSelection.some(item=>item.id===records[0].id))vibeSelection.push({id:records[0].id,strength:.6,information:1,enabled:true});
  saveVibeSelection();renderVibePanel();
}
async function refreshVibes() { vibeCache=await dbAll('vibes');renderVibePanel();if($('vibeDialog').open)renderVibeLibrary(); }
function renderVibePanel() {
  if(!$('vibeSelection'))return;
  const supported=vibeSupported($('model').value);
  if ($('vibeSummaryCount')) $('vibeSummaryCount').textContent = !vibeSelection.length ? '未选择' : supported ? `${vibeSelection.filter(item => item.enabled && item.strength > 0).length} / ${vibeSelection.length} 份启用` : `${vibeSelection.length} 份已暂停`;
  $('vibeSupportNote').textContent=supported ? '可叠加多份参考；首次编码可能收费，已编码素材会复用缓存。' : '当前 V5 暂不支持 Vibe；已选素材保留，切回 V4.5 后可继续使用。';
  $('vibeSelection').innerHTML=vibeSelection.map((item,index)=>{
    const asset=vibeCache.find(record=>record.id===item.id),ready=!!vibeEncoding(asset,$('model').value,item.information);
    return `<div class="vibe-row">${asset?.thumbnail?`<img class="vibe-thumb" src="${escapeHTML(asset.thumbnail)}" alt="${escapeHTML(asset.name)}">`:'<span class="vibe-thumb" aria-hidden="true"></span>'}<div><b>${escapeHTML(asset?.name||'素材已删除，请移除')}</b><small>${!supported?'已暂停':ready?'已有编码':$('model').value==='nai-diffusion-3'?'使用参考原图':'需要编码'}</small><label class="check"><input type="checkbox" data-vibe-enabled="${index}" ${item.enabled?'checked':''}>本次使用</label><div class="vibe-controls"><label>参考强度<input aria-label="参考强度 ${escapeHTML(asset?.name||'')}" data-vibe-strength="${index}" type="number" min="0" max="1" step="0.05" value="${item.strength}"></label><label>信息提取量<input aria-label="信息提取量 ${escapeHTML(asset?.name||'')}" data-vibe-information="${index}" type="number" min="0" max="1" step="0.05" value="${item.information}"></label></div></div><button class="icon-btn" data-vibe-remove="${index}" aria-label="移除 ${escapeHTML(asset?.name||'Vibe')}">${icon('trash')}</button></div>`;
  }).join('');
  for(const field of ['strength','information','enabled'])$('vibeSelection').querySelectorAll(`[data-vibe-${field}]`).forEach(input=>input.onchange=()=>{const item=vibeSelection[Number(input.getAttribute(`data-vibe-${field}`))];item[field]=field==='enabled'?input.checked:vibeNumber(input.value,field==='information'?1:.6);saveVibeSelection();renderVibePanel();});
  $('vibeSelection').querySelectorAll('[data-vibe-remove]').forEach(button=>button.onclick=()=>{vibeSelection.splice(Number(button.dataset.vibeRemove),1);saveVibeSelection();renderVibePanel();});
}
function renderVibeLibrary() {
  const query=$('vibeSearch').value.trim().toLowerCase();
  const list=vibeCache.filter(item=>!query||searchableText(item.name,item.tags).includes(query)).sort((a,b)=>Number(b.favorite)-Number(a.favorite));
  $('vibeLibraryList').innerHTML=list.map(record=>`<section class="vibe-library-row"><div class="vibe-pick">${record.type==='asset'?`<input aria-label="选择 ${escapeHTML(record.name)}" type="checkbox" data-vibe-pick="${escapeHTML(record.id)}" ${vibeSelection.some(item=>item.id===record.id)?'checked':''}>`:''}${record.thumbnail?`<img class="vibe-thumb" src="${escapeHTML(record.thumbnail)}" alt="">`:''}<div><b>${escapeHTML(record.name)}</b><small>${record.type==='bundle'?`组合 · ${record.items.length} 份参考`:`素材 · ${(record.tags||[]).map(escapeHTML).join(' / ')||'无标签'}`}</small></div></div><div class="vibe-actions">${record.type==='bundle'?`<button class="secondary" data-vibe-mix="${escapeHTML(record.id)}">使用组合</button>`:`<button class="secondary" data-vibe-favorite="${escapeHTML(record.id)}">${record.favorite?'取消收藏':'收藏'}</button>`}<button class="secondary" data-vibe-edit="${escapeHTML(record.id)}">改名/标签</button><button class="secondary" data-vibe-export="${escapeHTML(record.id)}">导出</button><button class="danger-btn" data-vibe-delete="${escapeHTML(record.id)}">删除</button></div></section>`).join('')||'<p class="vibe-note">还没有匹配的素材。先上传参考图或导入 Vibe 文件。</p>';
  $('vibeLibraryList').querySelectorAll('[data-vibe-pick]').forEach(input=>input.onchange=()=>{if(input.checked){if(vibeSelection.length>=16){input.checked=false;toast('最多选择 16 份 Vibe');return;}const asset=vibeCache.find(item=>item.id===input.dataset.vibePick),encoded=asset.encodings.find(item=>item.model===$('model').value);vibeSelection.push({id:asset.id,strength:.6,information:encoded?.information??1,enabled:true});}else vibeSelection=vibeSelection.filter(item=>item.id!==input.dataset.vibePick);saveVibeSelection();renderVibePanel();});
  for(const action of ['mix','favorite','edit','export','delete'])$('vibeLibraryList').querySelectorAll(`[data-vibe-${action}]`).forEach(button=>button.onclick=async()=>{try{
    const record=vibeCache.find(item=>item.id===button.getAttribute(`data-vibe-${action}`));if(!record)return;
    if(action==='mix'){restoreVibeSelection(record.items);closeDialog('vibeDialog');return;}
    if(action==='export'){exportVibeRecords(record);return;}
    if(action==='delete'){if(!confirm(`删除“${record.name}”？本地素材删除后，引用它的组合将移除此项。`))return;const tx=db.transaction('vibes','readwrite');const done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});tx.objectStore('vibes').delete(record.id);for(const mix of vibeCache.filter(item=>item.type==='bundle'&&item.id!==record.id))tx.objectStore('vibes').put({...mix,items:mix.items.filter(item=>item.id!==record.id)});await done;vibeSelection=vibeSelection.filter(item=>item.id!==record.id);saveVibeSelection();}
    if(action==='favorite')await dbPut('vibes',{...record,favorite:!record.favorite});
    if(action==='edit'){const name=prompt('素材/组合名称',record.name);if(name===null)return;if(!name.trim())throw new Error('名称不能为空');const tags=record.type==='asset'?prompt('标签，用逗号分隔',(record.tags||[]).join(', ')):'';if(tags===null)return;await dbPut('vibes',{...record,name:name.trim().slice(0,200),tags:splitTags(tags),updatedAt:Date.now()});}
    await refreshVibes();
  }catch(error){toast(error.message);}});
}
function exportVibeRecords(record = null) {
  let records=record?[record]:vibeCache;
  if(record?.type==='bundle')records=[...vibeCache.filter(item=>item.type==='asset'&&record.items.some(entry=>entry.id===item.id)),record];
  triggerBlobDownload(new Blob([JSON.stringify({app:'NAI 镜头台 Vibe 库',version:1,vibeRecords:records})],{type:'application/json'}),`NAI_Vibe_${safeFilenamePart(record?.name||'全部素材与组合')}.json`);
}
async function initVibes() {
  const panel=document.createElement('section');panel.className='vibe-panel';panel.innerHTML='<div class="field-top"><label>Vibe 参考</label><span class="field-note">可多选与叠加</span></div><div class="vibe-tools"><button class="secondary" id="openVibeLibrary" type="button">从 Vibe 库选择</button><button class="secondary" id="uploadVibeImage" type="button">上传参考图</button><button class="secondary" id="normalizeVibes" type="button">归一化强度</button><button class="secondary" id="saveVibeMix" type="button">保存组合</button></div><p id="vibeSupportNote" class="vibe-note"></p><div class="vibe-list" id="vibeSelection"></div><details class="advanced"><summary>第三方 Vibe 连接设置</summary><label class="check"><input id="vibeProxySupported" type="checkbox">我已确认此站点支持官方 Vibe 参考数组</label><label for="vibeEncodeEndpoint">Vibe 编码接口（需要编码新图片时填写）</label><input id="vibeEncodeEndpoint" type="url" placeholder="https://你的站点/ai/encode-vibe"><p class="vibe-note">此地址会接收当前 Token 和参考图，请使用同一可信服务商。原生 /ai/generate-image 接口自动使用同路径的编码接口。</p></details><input id="vibeImageFile" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden>';
  document.querySelector('.prompt-sheet .actions').before(panel);
  const dialog=document.createElement('dialog');dialog.id='vibeDialog';dialog.className='dialog';dialog.innerHTML='<div class="dialog-inner"><div class="dialog-head"><div><h2>Vibe 素材与组合</h2><p>素材保存在当前浏览器，建议定期导出备份。</p></div><button class="icon-btn" id="closeVibeLibrary" aria-label="关闭">×</button></div><input id="vibeSearch" aria-label="搜索 Vibe" placeholder="搜索名称或标签"><div class="vibe-tools" style="margin-top:12px"><button class="secondary" id="importVibeFile">导入 Vibe / 备份</button><button class="secondary" id="exportVibeLibrary">导出全部</button></div><p class="vibe-note">支持镜头台 Vibe JSON、.naiv4vibe 和 .naiv4vibeBundle。只有编码的素材不能任意改变模型或信息提取量。</p><div id="vibeLibraryMessage" class="vibe-error" role="status"></div><div id="vibeLibraryList"></div><input id="vibeImportFile" type="file" accept=".json,.naiv4vibe,.naiv4vibebundle" hidden></div>';
  document.body.append(dialog);dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});
  try{vibeSelection=cleanVibeSelection(JSON.parse(localStorage.getItem(VIBE_SELECTION_KEY)||'[]'));}catch{vibeSelection=[];}
  $('openVibeLibrary').onclick=()=>{renderVibeLibrary();showDialog('vibeDialog');};$('closeVibeLibrary').onclick=()=>closeDialog('vibeDialog');$('vibeSearch').oninput=renderVibeLibrary;
  $('uploadVibeImage').onclick=()=>$('vibeImageFile').click();
  $('vibeImageFile').onchange=async event=>{if(vibeBusy)return;vibeBusy=true;try{for(const file of event.target.files)await addVibeImage(file);toast('参考图已保存；需要生成时才进行付费编码');}catch(error){toast(error.message);}finally{vibeBusy=false;event.target.value='';}};
  $('normalizeVibes').onclick=()=>{const enabled=vibeSelection.filter(item=>item.enabled),total=enabled.reduce((sum,item)=>sum+item.strength,0);let used=0;if(total>0)enabled.forEach((item,index)=>{const units=index===enabled.length-1?1000-used:Math.floor(item.strength/total*1000);used+=units;item.strength=units/1000;});saveVibeSelection();renderVibePanel();};
  $('saveVibeMix').onclick=async()=>{try{if(!vibeSelection.length)throw new Error('请先选择 Vibe');const name=prompt('为这套 Vibe 组合起个名字');if(!name?.trim())return;await dbPut('vibes',{id:makeId(),type:'bundle',name:name.trim().slice(0,200),items:cleanVibeSelection(vibeSelection),createdAt:Date.now()});await refreshVibes();toast('组合已保存，可以从 Vibe 库直接选用');}catch(error){toast(error.message);}};
  $('importVibeFile').onclick=()=>$('vibeImportFile').click();$('exportVibeLibrary').onclick=()=>exportVibeRecords();
  $('vibeImportFile').onchange=async event=>{try{const file=event.target.files[0];if(!file)return;if(file.size>128*1024*1024)throw new Error('Vibe 文件超过 128 MB');await importVibeDocument(JSON.parse(await file.text()),file.name);$('vibeLibraryMessage').textContent='已导入；素材可多选，组合可直接使用。';}catch(error){$('vibeLibraryMessage').textContent=error.message;}finally{event.target.value='';}};
  for(const id of ['endpoint','apiMode','apiPresetSelect'])$(id).addEventListener('change',()=>{$('vibeProxySupported').checked=false;$('vibeEncodeEndpoint').value='';});
  const updateViewport=()=>{
    const viewport=window.visualViewport;
    const focused=document.activeElement?.matches('input,textarea,select');
    document.documentElement.style.setProperty('--nai-viewport-height',`${viewport?.height||innerHeight}px`);
    document.documentElement.style.setProperty('--nai-viewport-top',`${viewport?.offsetTop||0}px`);
    document.documentElement.dataset.keyboardOpen=String(Boolean(focused&&viewport&&viewport.height<innerHeight*.75));
  };
  window.visualViewport?.addEventListener('resize',updateViewport);window.visualViewport?.addEventListener('scroll',updateViewport);
  window.addEventListener('resize',updateViewport);document.addEventListener('focusin',updateViewport);document.addEventListener('focusout',()=>requestAnimationFrame(updateViewport));updateViewport();
  await refreshVibes();
}

(async () => {
  applyTheme(document.documentElement.dataset.theme || 'studio');
  renderApiPresets();
  loadSettings();
  updateWordForm();
  switchView('create');
  renderWords();
  renderCharacters();
  try {
    document.documentElement.dataset.stage = 'opening-db';
    await openDB();
    await initVibes();
    await initWorkbenchFeatures();
    document.documentElement.dataset.stage = 'migrating';
    await migrateLegacyData();
    document.documentElement.dataset.stage = 'refreshing';
    await refreshData();
    document.documentElement.dataset.stage = 'ready';
    $('dbState').textContent = '本地配方档案已就绪';
  } catch (error) {
    $('dbState').textContent = '本地档案不可用';
    setStatus('无法打开本地档案', 'err', error.message);
  }
})();
