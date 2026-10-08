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
const DB_VERSION = 2;

let db;
let recipesCache = [];
let artworksCache = [];
let currentRecipe = null;
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
let currentLibraryFilter = { type: 'all', value: '', label: '全部图片' };

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
  return model.replace('nai-diffusion-', '').replace('4-5', 'V4.5').replace('5-', 'V5 ').replaceAll('-', ' ');
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
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
  if ($('rememberToken').checked) localStorage.setItem(TOKEN_KEY, $('token').value);
  else localStorage.removeItem(TOKEN_KEY);
  updateApiStatus();
  updateAdvancedSummary();
}

function loadSettings() {
  let data = {};
  try { data = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch {}
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
    await Promise.all([dbClear('artworks'), dbClear('recipes')]);
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
  const model = $('model').value;
  const isV5 = model.startsWith('nai-diffusion-5-');
  $('modelBadge').textContent = isV5 ? 'V5' : model.includes('4-5') ? 'V4.5' : 'V3';
  $('modelHelp').textContent = isV5
    ? (model.endsWith('full') ? 'V5 Full · 长提示词、多角色与透明背景' : 'V5 Curated · 更干净、聚焦的训练集')
    : (model.includes('4-5') ? 'V4.5 · 兼容传统 TAG 与角色提示' : 'Anime V3 · 传统标签模型');
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
  document.querySelector('.app').scrollTo?.({ top: 0, behavior: 'smooth' });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      document.documentElement.dataset.stage = 'upgrading-db';
      const database = request.result;
      if (!database.objectStoreNames.contains('artworks')) {
        const artworks = database.createObjectStore('artworks', { keyPath: 'id', autoIncrement: true });
        artworks.createIndex('createdAt', 'createdAt');
      }
      if (!database.objectStoreNames.contains('recipes')) {
        const recipes = database.createObjectStore('recipes', { keyPath: 'id' });
        recipes.createIndex('updatedAt', 'updatedAt');
      }
    };
    request.onsuccess = () => { document.documentElement.dataset.stage = 'db-open'; db = request.result; resolve(); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('数据库升级被其他页面占用，请关闭旧页面后重试'));
  });
}

function storeRequest(storeName, mode, operation) {
  return new Promise((resolve, reject) => {
    const store = db.transaction(storeName, mode).objectStore(storeName);
    const request = operation(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const dbAdd = (store, value) => storeRequest(store, 'readwrite', objectStore => objectStore.add(value));
const dbPut = (store, value) => storeRequest(store, 'readwrite', objectStore => objectStore.put(value));
const dbDelete = (store, id) => storeRequest(store, 'readwrite', objectStore => objectStore.delete(id));
const dbClear = store => storeRequest(store, 'readwrite', objectStore => objectStore.clear());
const dbGet = (store, id) => storeRequest(store, 'readonly', objectStore => objectStore.get(id));
const dbAll = store => storeRequest(store, 'readonly', objectStore => objectStore.getAll());

function characters() {
  try { return JSON.parse(localStorage.getItem(CHARACTERS_KEY) || '[]'); } catch { return []; }
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
    character.naturalAppearance, ...(character.tags || [])
  ].join(' ').toLowerCase().includes(query));
  listElement.innerHTML = list.length ? list.map(character => {
    const prompt = characterPrompt(character);
    return `<article class="character-card"><div class="character-head"><div><h2>${escapeHTML(character.name)}</h2><div class="chips">${(character.tags || []).map(tag => `<span class="chip">${escapeHTML(tag)}</span>`).join('') || '<span class="chip">未添加标签</span>'}</div></div><button class="icon-btn${character.favorite ? ' favorite-active' : ''}" data-character-favorite="${escapeHTML(character.id)}" type="button" aria-label="${character.favorite ? '取消收藏' : '收藏'}${escapeHTML(character.name)}" aria-pressed="${Boolean(character.favorite)}">${icon('star')}</button></div><p class="character-prompt">${escapeHTML(prompt || '还没有完整人物提示词')}</p><div class="character-actions"><button class="primary" data-character-use="${escapeHTML(character.id)}" type="button">放入创作台</button><button class="secondary" data-character-copy="${escapeHTML(character.id)}" type="button">复制完整描述</button><button class="secondary" data-character-edit="${escapeHTML(character.id)}" type="button">修改</button><button class="danger-btn" data-character-delete="${escapeHTML(character.id)}" type="button">删除</button></div><details class="character-details"><summary>查看并复制分类资料</summary><div class="character-fields">${Object.keys(characterFieldLabels).map(key => characterDetailHTML(character, key)).join('')}</div></details></article>`;
  }).join('') : '<div class="empty"><div><b>人物库还是空的</b><span>把常用角色保存下来，以后可以一键放入创作台。</span></div></div>';
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
  event.preventDefault();
  const list = characters();
  const editId = $('characterEditId').value;
  const old = list.find(item => item.id === editId);
  const character = {
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
};

$('cancelCharacterEdit').onclick = resetCharacterForm;
$('characterSearch').addEventListener('input', debounce(renderCharacters));
$('clearCharacterLinks').onclick = () => {
  setSelectedCharacterIds([]);
  saveSettings();
  toast('已取消人物档案关联，提示词内容仍然保留');
};

function words() {
  try { return JSON.parse(localStorage.getItem(WORDS_KEY) || '[]'); } catch { return []; }
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
  ['model', 'size', 'steps', 'scale', 'sampler', 'noiseSchedule', 'transparentBg'].forEach(key => {
    if (source[key] !== undefined) result[key] = source[key];
  });
  return result;
}

async function refreshData() {
  recipesCache = (await dbAll('recipes')).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  artworksCache = (await dbAll('artworks')).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  renderRecipeOptions();
  renderRecipes();
  renderImageLibrary();
}

function renderRecipeOptions() {
  const current = $('recipeSelect').value;
  const options = recipesCache.map(recipe => `<option value="${escapeHTML(recipe.id)}">${escapeHTML(recipe.name)}</option>`).join('');
  $('recipeSelect').innerHTML = `<option value="">未分类</option>${options}`;
  $('importRecipeSelect').innerHTML = options || '<option value="">还没有配方</option>';
  $('moveRecipeSelect').innerHTML = `<option value="">未分类</option>${options}`;
  if (recipesCache.some(recipe => recipe.id === current)) $('recipeSelect').value = current;
  else if (current) $('recipeSelect').value = '';
  updateActiveRecipeLabel();
}

function updateActiveRecipeLabel() {
  currentRecipe = recipesCache.find(recipe => recipe.id === $('recipeSelect').value) || null;
  $('activeRecipeName').textContent = currentRecipe ? currentRecipe.name : '未选择配方档案';
  $('activeRecipeHint').textContent = currentRecipe
    ? '生成图片会自动保存到这份配方档案'
    : '生成后暂存到“未分类”，也可以先选择或新建配方';
}

function applyRecipe(recipe, includeParams = true) {
  if (!recipe) return;
  $('artistPrompt').value = recipe.artistPrompt || '';
  $('positivePrompt').value = recipe.positivePrompt || '';
  $('negativePrompt').value = recipe.negativePrompt || '';
  $('tags').value = (recipe.tags || []).join(', ');
  if (includeParams) {
    Object.entries(recipe.defaultParams || {}).forEach(([key, value]) => {
      const element = $(key);
      if (!element) return;
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
    updateActiveRecipeLabel();
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
  $('recipeNote').value = recipe?.note || '';
  $('recipeSourceUrl').value = recipe?.sourceUrl || '';
  $('recipeSteps').value = Number(params.steps) || 28;
  $('recipeSampler').value = params.sampler || 'k_euler_ancestral';
  showDialog('recipeDialog');
  setTimeout(() => $('recipeName').focus(), 50);
}

$('newRecipeBtn').onclick = () => openRecipeEditor(null, true);
$('galleryNewRecipeBtn').onclick = () => openRecipeEditor();
$('saveBundleBtn').onclick = () => openRecipeEditor(null, true);

$('recipeForm').onsubmit = async event => {
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
    note: $('recipeNote').value.trim(),
    sourceUrl: $('recipeSourceUrl').value.trim(),
    coverArtworkId: old?.coverArtworkId || null,
    createdAt: old?.createdAt || Date.now(),
    updatedAt: Date.now(),
    manualOrder: old?.manualOrder ?? -Date.now(),
    defaultParams: {
      ...(old?.defaultParams || pickParams(collectMeta())),
      steps: Number($('recipeSteps').value) || 28,
      sampler: $('recipeSampler').value
    }
  };
  await dbPut('recipes', recipe);
  closeDialog('recipeDialog');
  await refreshData();
  applyRecipe(recipesCache.find(item => item.id === recipe.id));
  toast(id ? '配方已更新' : '配方档案已创建');
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

function artworkSearchText(item) {
  const recipe = recipesCache.find(value => value.id === item.recipeId);
  return [
    item.title, item.scenePrompt, item.characterPrompt, item.sourcePrompt, item.fullPrompt, item.artistPrompt,
    item.positivePrompt, item.negativePrompt, item.category, ...(item.tags || []),
    recipe?.name, ...(recipe?.tags || [])
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
    id: '__uncategorized__', name: '未分类', artistPrompt: '', positivePrompt: '',
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
  return `<div class="batch-bar"><span>已选择 ${selectedArtworkIds.size} 张</span><button class="secondary" data-batch-all type="button">${visible.length && visibleSelected === visible.length ? '取消全选' : '全选当前'}</button><button class="secondary" data-batch-favorite type="button">收藏 / 取消</button><button class="secondary" data-batch-tag type="button">加标签</button><button class="secondary" data-batch-move type="button">移动</button><button class="danger-btn" data-batch-delete type="button">删除</button><button class="secondary" data-batch-cancel type="button">退出多选</button></div>`;
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
  document.querySelectorAll('.batch-bar span').forEach(span => { span.textContent = `已选择 ${selectedArtworkIds.size} 张`; });
}

async function batchFavoriteArtworks() {
  const items = selectedArtworks();
  if (!items.length) { toast('请先选择图片'); return; }
  const favorite = !items.every(item => item.favorite);
  for (const item of items) {
    item.favorite = favorite;
    item.updatedAt = Date.now();
    await dbPut('artworks', item);
  }
  await refreshData();
  toast(favorite ? `已收藏 ${items.length} 张图片` : `已取消收藏 ${items.length} 张图片`);
}

async function batchDeleteArtworks() {
  const items = selectedArtworks();
  if (!items.length) { toast('请先选择图片'); return; }
  if (!confirm(`永久删除选中的 ${items.length} 张图片？此操作无法撤销。`)) return;
  const ids = new Set(items.map(item => item.id));
  for (const item of items) await dbDelete('artworks', item.id);
  for (const recipe of recipesCache.filter(item => ids.has(item.coverArtworkId))) {
    recipe.coverArtworkId = null;
    recipe.updatedAt = Date.now();
    await dbPut('recipes', recipe);
  }
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
  root.querySelector('[data-batch-favorite]')?.addEventListener('click', batchFavoriteArtworks);
  root.querySelector('[data-batch-tag]')?.addEventListener('click', () => { $('batchTags').value = ''; showDialog('batchTagDialog'); });
  root.querySelector('[data-batch-move]')?.addEventListener('click', () => {
    if (!selectedArtworkIds.size) { toast('请先选择图片'); return; }
    batchMoveActive = true;
    $('moveRecipeSelect').value = '';
    showDialog('moveDialog');
  });
  root.querySelector('[data-batch-delete]')?.addEventListener('click', batchDeleteArtworks);
  root.querySelector('[data-batch-cancel]')?.addEventListener('click', () => setArtworkSelectionMode(false));
}

function collapseRecipeInspector() {
  currentGalleryRecipeId = '';
  const inspector = $('recipeInspector');
  restoreRecipeInspectorHome();
  inspector.hidden = true;
  document.querySelectorAll('[data-recipe-id]').forEach(button => button.classList.remove('active'));
}

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
    recipe.note, recipe.sourceUrl, ...(recipe.tags || [])
  ].join(' ').toLowerCase().includes(query));
  if (query && matchingArtworks.length) {
    const searchView = {
      id: '__search__', name: `图片搜索：${$('gallerySearch').value.trim()}`, artistPrompt: '',
      positivePrompt: '', negativePrompt: '', tags: [`${matchingArtworks.length} 张命中`], virtual: true,
      virtualKind: 'search', artworkIds: matchingArtworks.map(item => item.id)
    };
    list.unshift(searchView);
    views.unshift(searchView);
    currentGalleryRecipeId = searchView.id;
  } else if (currentGalleryRecipeId === '__search__') currentGalleryRecipeId = '';
  const grid = $('recipeGrid');
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
      return `<button class="recipe-card${currentGalleryRecipeId === recipe.id ? ' active' : ''}" data-recipe-id="${escapeHTML(recipe.id)}">${visual}<div class="recipe-card-body"><div class="recipe-card-title">${recipe.favorite ? `${icon('star')} ` : ''}${escapeHTML(recipe.name)}</div><div class="recipe-card-meta"><span>${count} 张立图</span><span>${escapeHTML((recipe.tags || [])[0] || '未标记')}</span></div></div></button>`;
    }).join('');
    grid.querySelectorAll('[data-recipe-id]').forEach(button => {
      button.onclick = () => currentGalleryRecipeId === button.dataset.recipeId ? collapseRecipeInspector() : inspectRecipe(list.find(recipe => recipe.id === button.dataset.recipeId));
    });
  }
  if (currentGalleryRecipeId) {
    const fresh = list.find(recipe => recipe.id === currentGalleryRecipeId);
    if (fresh) inspectRecipe(fresh, false);
  }
}

function inspectRecipe(recipe, scroll = true) {
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
    : `<div class="recipe-copy-list">${recipeCopyRow('画师串', recipe.artistPrompt, 'artistPrompt')}${recipeCopyRow('正面提示词', recipe.positivePrompt, 'positivePrompt')}${recipeCopyRow('负面提示词', recipe.negativePrompt, 'negativePrompt')}</div>${recipe.note || recipe.sourceUrl ? `<div class="recipe-notes"><b>备注与来源</b>${recipe.note ? `<p>${escapeHTML(recipe.note)}</p>` : ''}${safeHttpUrl(recipe.sourceUrl) ? `<a class="source-link" href="${escapeHTML(safeHttpUrl(recipe.sourceUrl))}" target="_blank" rel="noopener noreferrer">打开来源链接</a>` : recipe.sourceUrl ? `<p>${escapeHTML(recipe.sourceUrl)}</p>` : ''}</div>` : ''}`;
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
    $('moveRecipeFront').onclick = () => moveRecipeToFront(recipe);
    $('favoriteRecipe').onclick = async () => {
      recipe.favorite = !recipe.favorite;
      recipe.updatedAt = Date.now();
      await dbPut('recipes', recipe);
      await refreshData();
      inspectRecipe(recipesCache.find(item => item.id === recipe.id), false);
      toast(recipe.favorite ? '已收藏配方' : '已取消收藏');
    };
    $('editRecipe').onclick = $('editRecipeBottom').onclick = () => openRecipeEditor(recipe);
    $('importIntoRecipe').onclick = () => { $('imageImportFile').dataset.recipeId = recipe.id; $('imageImportFile').click(); };
    $('deleteRecipe').onclick = () => deleteRecipe(recipe);
  }
  inspector.querySelectorAll('[data-image-id]').forEach(button => bindImageAction(button, Number(button.dataset.imageId)));
  document.querySelectorAll('[data-recipe-id]').forEach(button => button.classList.toggle('active', button.dataset.recipeId === recipe.id));
  if (matchMedia('(max-width:760px)').matches) {
    const card = document.querySelector(`[data-recipe-id="${CSS.escape(String(recipe.id))}"]`);
    if (card) card.after(inspector);
  } else {
    restoreRecipeInspectorHome();
    if (scroll && matchMedia('(max-width:1100px)').matches) setTimeout(() => inspector.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30);
  }
}

async function moveRecipeToFront(recipe) {
  const ranks = recipesCache.filter(item => item.id !== recipe.id).map(manualRecipeRank);
  recipe.manualOrder = (ranks.length ? Math.min(...ranks) : 0) - 1;
  recipe.updatedAt = Date.now();
  await dbPut('recipes', recipe);
  $('gallerySort').value = 'manual';
  saveSettings();
  await refreshData();
  inspectRecipe(recipesCache.find(item => item.id === recipe.id), false);
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
  if (!confirm(`删除配方“${recipe.name}”？其中 ${count} 张图片会移到“未分类”，不会删除图片。`)) return;
  for (const artwork of artworksCache.filter(item => item.recipeId === recipe.id)) {
    artwork.recipeId = '';
    artwork.category = '未分类';
    await dbPut('artworks', artwork);
  }
  await dbDelete('recipes', recipe.id);
  if ($('recipeSelect').value === recipe.id) $('recipeSelect').value = '';
  currentGalleryRecipeId = '';
  $('recipeInspector').className = 'sheet recipe-inspector empty-inspector';
  $('recipeInspector').textContent = '选择一份配方，查看封面立图与可复制内容';
  await refreshData();
  toast('配方已删除，图片已移到未分类');
}

function artworkCharacterIds(item) {
  const ids = Array.isArray(item.characterIds) ? item.characterIds.map(String) : (item.characterId ? [String(item.characterId)] : []);
  if (ids.length) return [...new Set(ids)];
  const prompt = String(item.characterPrompt || '');
  return characters().filter(character => {
    const savedPrompt = characterPrompt(character);
    return savedPrompt && prompt.includes(savedPrompt);
  }).map(character => character.id);
}

function artworkCharacterNames(item) {
  const savedNames = Array.isArray(item.characterNames) ? item.characterNames : (item.characterName ? [item.characterName] : []);
  if (savedNames.length) return [...new Set(savedNames.filter(Boolean))];
  return artworkCharacterIds(item).map(id => characters().find(character => character.id === id)?.name).filter(Boolean);
}

function countMap(values) {
  const map = new Map();
  values.flat().filter(Boolean).forEach(value => map.set(String(value), (map.get(String(value)) || 0) + 1));
  return map;
}

function libraryFilterGroup(title, type, entries, query) {
  const filtered = [...entries].filter(([name]) => !query || name.toLowerCase().includes(query));
  if (!filtered.length) return '';
  return `<section class="library-filter-group"><h3>${escapeHTML(title)}</h3><div class="library-filter-list">${filtered.map(([name, count]) => {
    const active = currentLibraryFilter.type === type && currentLibraryFilter.value === name;
    return `<button class="library-filter${active ? ' active' : ''}" data-library-type="${type}" data-library-value="${escapeHTML(name)}" type="button"><span>${escapeHTML(name)}</span><b>${count}</b></button>`;
  }).join('')}</div></section>`;
}

function artworkMatchesLibraryFilter(item) {
  const { type, value } = currentLibraryFilter;
  if (type === 'favorite') return Boolean(item.favorite);
  if (type === 'character') return artworkCharacterNames(item).includes(value) || artworkCharacterIds(item).includes(value);
  if (type === 'tag') return (item.tags || []).includes(value);
  if (type === 'category') return (item.category || '未分类') === value;
  return true;
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
  const characterCounts = countMap(artworksCache.map(artworkCharacterNames));
  const tagCounts = countMap(artworksCache.map(item => item.tags || []));
  const categoryCounts = countMap(artworksCache.map(item => [item.category || '未分类']));
  const allActive = currentLibraryFilter.type === 'all';
  const favoriteCount = artworksCache.filter(item => item.favorite).length;
  const favoriteActive = currentLibraryFilter.type === 'favorite';
  filterList.innerHTML = `<div class="library-filter-list"><button class="library-filter${allActive ? ' active' : ''}" data-library-type="all" data-library-value="" type="button"><span>全部图片</span><b>${artworksCache.length}</b></button><button class="library-filter${favoriteActive ? ' active' : ''}" data-library-type="favorite" data-library-value="" type="button"><span>收藏图片</span><b>${favoriteCount}</b></button></div>${libraryFilterGroup('人物', 'character', characterCounts, query)}${libraryFilterGroup('图片标签', 'tag', tagCounts, query)}${libraryFilterGroup('配方分类', 'category', categoryCounts, query)}`;
  filterList.querySelectorAll('[data-library-type]').forEach(button => button.onclick = () => {
    currentLibraryFilter = {
      type: button.dataset.libraryType,
      value: button.dataset.libraryValue,
      label: button.dataset.libraryType === 'all' ? '全部图片' : button.dataset.libraryType === 'favorite' ? '收藏图片' : button.dataset.libraryValue
    };
    renderImageLibrary();
  });
  let images = artworksCache.filter(artworkMatchesLibraryFilter).filter(item => !query || [
    artworkSearchText(item), ...artworkCharacterNames(item)
  ].join(' ').toLowerCase().includes(query));
  if ($('librarySort').value === 'oldest') images = [...images].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  else images = [...images].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  $('libraryActiveName').textContent = currentLibraryFilter.label;
  $('libraryCount').textContent = `${images.length} 张`;
  $('librarySelectBtn').textContent = artworkSelectionMode ? '退出多选' : '多选';
  $('librarySelectBtn').onclick = () => setArtworkSelectionMode(!artworkSelectionMode);
  $('libraryBatchBar').innerHTML = batchBarHTML(images.map(item => item.id));
  bindBatchBar($('libraryBatchBar'), images.map(item => item.id));
  imageGrid.innerHTML = images.length ? images.map(item => {
    const url = URL.createObjectURL(item.blob);
    libraryUrls.push(url);
    const people = artworkCharacterNames(item);
    const subtitle = [...people, ...(item.tags || [])].slice(0, 3).join(' · ') || item.category || '未分类';
    return `<button class="library-image${selectedArtworkIds.has(String(item.id)) ? ' selected' : ''}" data-library-image="${item.id}" type="button">${selectionMark(item)}<img loading="lazy" decoding="async" src="${url}" alt="${escapeHTML(item.title || '生成图片')}"><span class="library-image-body"><b>${item.favorite ? `${icon('star')} ` : ''}${escapeHTML(item.title || '未命名镜头')}</b><span>${escapeHTML(subtitle)}</span></span></button>`;
  }).join('') : '<div class="empty"><div><b>这个分类里还没有图片</b><span>生成图片后添加标签，或从人物库选择角色再生成。</span></div></div>';
  imageGrid.classList.toggle('selection-mode', artworkSelectionMode);
  imageGrid.querySelectorAll('[data-library-image]').forEach(button => button.onclick = () => artworkSelectionMode ? toggleArtworkSelection(button.dataset.libraryImage) : openImageDialog(artworksCache.find(item => item.id === Number(button.dataset.libraryImage))));
  if (matchMedia('(max-width:760px)').matches) {
    const active = filterList.querySelector('.library-filter.active');
    if (active) active.after($('libraryResults'));
  }
}

function openImageDialog(item) {
  if (!item) return;
  currentImage = item;
  const recipe = recipesCache.find(value => value.id === item.recipeId);
  $('imageDialogTitle').textContent = item.title || '图片记录';
  $('imageDialogMeta').textContent = `${recipe?.name || '未分类'} · ${shortModel(item.model || '未知模型')} · ${item.size || '未知尺寸'}`;
  $('imageDialogPreview').src = URL.createObjectURL(item.blob);
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
  $('imagePromptDetails').innerHTML = promptRows.map(([label, value]) => `<section class="image-prompt-row"><header><b>${label}</b></header><p>${escapeHTML(value || '—')}</p></section>`).join('');
  $('imageSetCover').disabled = !recipe;
  $('imageCopyCharacter').onclick = () => copyText(item.characterPrompt || '');
  $('imageCopyArtist').onclick = () => copyText(item.artistPrompt || '');
  $('imageCopyPositive').onclick = () => copyText(item.positivePrompt || '');
  $('imageCopyNegative').onclick = () => copyText(item.negativePrompt || '');
  $('imageMove').onclick = () => { batchMoveActive = false; $('moveRecipeSelect').value = item.recipeId || ''; showDialog('moveDialog'); };
  $('saveImageTags').onclick = async () => {
    item.tags = splitTags($('imageTags').value);
    await dbPut('artworks', item);
    await refreshData();
    toast('图片标签已保存，现在可以用它搜索');
  };
  $('imageSetCover').onclick = async () => {
    if (!recipe) return;
    recipe.coverArtworkId = item.id;
    recipe.updatedAt = Date.now();
    await dbPut('recipes', recipe);
    await refreshData();
    inspectRecipe(recipesCache.find(value => value.id === recipe.id), false);
    toast('已设为配方封面');
  };
  $('imageReuse').onclick = () => { reuseArtwork(item); closeDialog('imageDialog'); };
  $('imageDownload').onclick = () => downloadArtwork(item);
  $('imageDownloadJpeg').onclick = () => downloadArtworkJpeg(item, $('imageDownloadJpeg'));
  $('imageDelete').onclick = () => deleteArtwork(item);
  showDialog('imageDialog');
}

async function moveArtworkRecord(item, targetRecipeId) {
  const oldRecipeId = item.recipeId || '';
  item.recipeId = targetRecipeId;
  item.category = recipesCache.find(recipe => recipe.id === targetRecipeId)?.name || '未分类';
  item.updatedAt = Date.now();
  await dbPut('artworks', item);
  if (oldRecipeId) {
    const oldRecipe = await dbGet('recipes', oldRecipeId);
    if (oldRecipe?.coverArtworkId === item.id) {
      oldRecipe.coverArtworkId = null;
      oldRecipe.updatedAt = Date.now();
      await dbPut('recipes', oldRecipe);
    }
  }
  if (targetRecipeId) {
    const newRecipe = await dbGet('recipes', targetRecipeId);
    if (newRecipe && !newRecipe.coverArtworkId) {
      newRecipe.coverArtworkId = item.id;
      newRecipe.updatedAt = Date.now();
      await dbPut('recipes', newRecipe);
    }
  }
}

$('confirmMoveBtn').onclick = async () => {
  const targetRecipeId = $('moveRecipeSelect').value;
  if (batchMoveActive) {
    const items = selectedArtworks();
    if (!items.length) { toast('请先选择图片'); return; }
    for (const item of items) await moveArtworkRecord(item, targetRecipeId);
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
};

$('moveDialog').addEventListener('close', () => { batchMoveActive = false; });

$('confirmBatchTags').onclick = async () => {
  const tags = splitTags($('batchTags').value);
  const items = selectedArtworks();
  if (!tags.length) { toast('请先填写标签'); return; }
  if (!items.length) { toast('请先选择图片'); return; }
  for (const item of items) {
    item.tags = [...new Set([...(item.tags || []), ...tags])];
    item.updatedAt = Date.now();
    await dbPut('artworks', item);
  }
  closeDialog('batchTagDialog');
  await refreshData();
  toast(`已给 ${items.length} 张图片添加标签`);
};

async function deleteArtwork(item) {
  if (!confirm('删除这张图片及其生成记录？此操作不可恢复。')) return;
  await dbDelete('artworks', item.id);
  const owners = recipesCache.filter(recipe => recipe.coverArtworkId === item.id);
  for (const owner of owners) {
    owner.coverArtworkId = null;
    owner.updatedAt = Date.now();
    await dbPut('recipes', owner);
  }
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
  triggerBlobDownload(item.blob, `NAI_${item.id}_${safeFilenamePart(item.model)}.png`);
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
  ['scenePrompt', 'characterPrompt', 'artistPrompt', 'positivePrompt', 'negativePrompt', 'model', 'size', 'steps', 'scale', 'seed', 'sampler', 'noiseSchedule'].forEach(key => {
    if (item[key] !== undefined && $(key)) $(key).value = item[key];
  });
  $('tags').value = (item.tags || []).join(', ');
  setSelectedCharacterIds(artworkCharacterIds(item));
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
  const list = pickerItems.filter(item => !query || item.search.includes(query));
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
    const target = $(pickerTargetId);
    target.value = button.dataset.pickerMode === 'append' && target.value.trim() ? `${target.value.trim()}, ${item.value}` : item.value;
    if (pickerKind === 'scene') setAutoSceneTag(item.name);
    saveSettings();
    closeDialog('pickerDialog');
    toast(button.dataset.pickerMode === 'append' ? '已追加到输入框' : '已替换输入框内容');
  });
}

function applyPickedCharacters(mode) {
  const pickedIds = [...pickerCharacterSelection];
  if (!pickedIds.length) return;
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
  pickerTargetId = targetId;
  $('pickerSearch').value = '';
  const fieldName = { scene: '画面描述词', character: '人物提示词', artist: '画师串', positive: '正面词', negative: '负面词' }[kind];
  $('pickerTitle').textContent = `选择${fieldName}`;
  $('pickerHelp').textContent = kind === 'character' ? '可以同时勾选多个人物；切换搜索词不会丢失勾选。' : '收藏内容优先显示；“替换”会清空当前字段，“追加”会接在后面。';
  $('pickerMultiActions').hidden = kind !== 'character';
  if (kind === 'character') {
    pickerCharacterSelection = new Set(selectedCharacterIds());
    pickerItems = characters().filter(character => characterPrompt(character)).map(character => ({
      id: character.id, name: character.name, value: characterPrompt(character), favorite: Boolean(character.favorite),
      search: searchableText(character.name, characterPrompt(character), character.tags, character.note, character.sourceUrl)
    })).sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name, 'zh-CN'));
  } else {
    const recipeItems = ['scene', 'character'].includes(kind) ? [] : recipesCache.map(recipe => ({
      id: `recipe-${recipe.id}`, name: recipe.name, source: '配方档案', value: recipe[`${kind}Prompt`] || '', favorite: Boolean(recipe.favorite),
      search: searchableText(recipe.name, recipe[`${kind}Prompt`], recipe.tags, recipe.note, recipe.sourceUrl)
    }));
    const wordItems = words().flatMap(word => {
      const value = word.kind === kind ? word.content || '' : word.kind === 'bundle' ? bundleData(word)[`${kind}Prompt`] || '' : '';
      if (!value) return [];
      return [{ id: `${word.kind}-${word.id}`, name: word.name, source: word.kind === 'bundle' ? '整套配方' : '散词库', value, favorite: Boolean(word.favorite), search: searchableText(word.name, value, word.category, word.tags, word.note, word.sourceUrl) }];
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
  return ({ scene: '画面描述词', artist: '画师串', positive: '正面词', negative: '负面词', bundle: '整套配方' })[kind] || kind;
}

function renderWords() {
  const query = $('wordSearch').value.trim().toLowerCase();
  const filter = $('wordFilter').value;
  const list = words().filter(word => {
    const bundle = word.kind === 'bundle' ? bundleData(word) : {};
    return (!filter || word.kind === filter) && (!query || [
      word.name, word.content, bundle.artistPrompt, bundle.positivePrompt, bundle.negativePrompt,
      word.category, word.note, word.sourceUrl, ...(word.tags || [])
    ].join(' ').toLowerCase().includes(query));
  });
  $('wordList').innerHTML = list.length ? list.map(word => {
    const bundle = word.kind === 'bundle' ? bundleData(word) : null;
    const summary = bundle
      ? `<div class="word-summary"><span>画师：${escapeHTML(bundle.artistPrompt || '—')}</span><span>正面：${escapeHTML(bundle.positivePrompt || '—')}</span><span>负面：${escapeHTML(bundle.negativePrompt || '—')}</span></div>`
      : `<p>${escapeHTML(word.content || '')}</p>`;
    const copyActions = bundle
      ? `<button class="secondary" data-bundle-copy="artistPrompt" data-word-id="${word.id}" type="button">画师</button><button class="secondary" data-bundle-copy="positivePrompt" data-word-id="${word.id}" type="button">正面</button><button class="secondary" data-bundle-copy="negativePrompt" data-word-id="${word.id}" type="button">负面</button>`
      : `<button class="copy-btn" data-word-copy="${word.id}" aria-label="复制${escapeHTML(word.name)}">${icon('copy')}</button>`;
    const safeSource = safeHttpUrl(word.sourceUrl);
    const provenance = word.note || word.sourceUrl
      ? `<div class="word-provenance">${word.note ? `<span title="${escapeHTML(word.note)}">备注：${escapeHTML(word.note)}</span>` : ''}${safeSource ? `<a class="source-link" href="${escapeHTML(safeSource)}" target="_blank" rel="noopener noreferrer">打开来源</a>` : word.sourceUrl ? `<span>来源：${escapeHTML(word.sourceUrl)}</span>` : ''}</div>`
      : '';
    return `<article class="word-row${expandedWordId === String(word.id) ? ' expanded' : ''}"><button class="word-mobile-summary" data-word-expand="${escapeHTML(word.id)}" type="button" aria-expanded="${expandedWordId === String(word.id)}"><span><b>${escapeHTML(word.name)}</b> · ${kindName(word.kind)}</span><span>${expandedWordId === String(word.id) ? '收起' : '展开'}</span></button><div class="word-row-details"><div class="word-kind"><span class="kind-dot ${word.kind}"></span>${kindName(word.kind)}</div><div class="word-content"><b>${escapeHTML(word.name)}</b>${summary}${provenance}</div><div class="word-actions">${copyActions}<button class="icon-btn${word.favorite ? ' favorite-active' : ''}" data-word-favorite="${word.id}" type="button" aria-label="${word.favorite ? '取消收藏' : '收藏'}${escapeHTML(word.name)}" aria-pressed="${Boolean(word.favorite)}">${icon('star')}</button><button class="secondary" data-word-use="${word.id}" type="button" style="padding:7px 10px">使用</button><button class="secondary" data-word-edit="${word.id}" type="button" style="padding:7px 10px">修改</button><button class="icon-btn" data-word-del="${word.id}" type="button" aria-label="删除${escapeHTML(word.name)}">${icon('trash')}</button></div></div></article>`;
  }).join('') : '<div class="empty"><div><b>散词库还是空的</b><span>保存单独词条，或用结构化表单保存整套配方。</span></div></div>';
  document.querySelectorAll('[data-word-copy]').forEach(button => button.onclick = () => {
    const word = words().find(item => item.id === button.dataset.wordCopy);
    copyText(word?.content || '', button);
  });
  document.querySelectorAll('[data-bundle-copy]').forEach(button => button.onclick = () => {
    const word = words().find(item => item.id === button.dataset.wordId);
    copyText(bundleData(word)[button.dataset.bundleCopy] || '', button);
  });
  document.querySelectorAll('[data-word-use]').forEach(button => button.onclick = () => useWord(button.dataset.wordUse));
  document.querySelectorAll('[data-word-expand]').forEach(button => button.onclick = () => {
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
  $('wordNote').value = word.note || '';
  $('wordSourceUrl').value = word.sourceUrl || '';
  $('wordFormTitle').textContent = '修改词条';
  $('saveWordBtn').querySelector('span').textContent = '保存修改';
  $('cancelWordEdit').hidden = false;
  updateWordForm();
  $('wordForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('wordName').focus();
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
$('cancelWordEdit').onclick = resetWordForm;

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
    id: editId || makeId(), name: $('wordName').value.trim(), kind,
    content: bundle ? JSON.stringify(bundle) : $('wordContent').value.trim(), bundle,
    category: $('wordCategory').value.trim() || '未分类', tags: splitTags($('wordTags').value),
    note: $('wordNote').value.trim(), sourceUrl: $('wordSourceUrl').value.trim(),
    favorite: Boolean(old?.favorite), createdAt: old?.createdAt || Date.now(), updatedAt: Date.now()
  };
  if (old) list.splice(list.findIndex(item => item.id === editId), 1, word);
  else list.unshift(word);
  saveWords(list);
  resetWordForm();
  toast(old ? '词条已更新' : '词条已保存');
};

function useWord(id) {
  const word = words().find(item => item.id === id);
  if (!word) return;
  if (word.kind === 'bundle') {
    const bundle = bundleData(word);
    ['artistPrompt', 'positivePrompt', 'negativePrompt'].forEach(key => {
      if (bundle[key] !== undefined) $(key).value = bundle[key];
    });
  } else {
    $(`${word.kind}Prompt`).value = word.content || '';
    if (word.kind === 'scene') setAutoSceneTag(word.name);
  }
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
    provider: $('apiMode').value
  };
}

function randomSeed() {
  return Math.floor(Math.random() * 4294967295);
}

function naiRequest(meta) {
  const [width, height] = meta.size.split('x').map(Number);
  const seed = meta.seed ? Number(meta.seed) : randomSeed();
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
      ...(isV5 && meta.transparentBg ? { transparent_background: true } : {})
    }
  };
}

function proxyRequest(meta) {
  return {
    model: meta.model, prompt: meta.fullPrompt, negative_prompt: meta.negativePrompt,
    size: meta.size, n: 1, steps: meta.steps, scale: meta.scale,
    sampler: meta.sampler, seed: meta.seed ? Number(meta.seed) : undefined
  };
}

async function b64Blob(base64) {
  const clean = base64.replace(/^data:[^;]+;base64,/, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: 'image/png' });
}

async function parseImageResponse(response, mode) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('json')) {
    const data = await response.json();
    const item = data?.data?.[0] || data;
    if (item?.b64_json) return b64Blob(item.b64_json);
    if (item?.url) return (await fetch(item.url)).blob();
    throw new Error(data?.message || data?.error?.message || '返回中没有图片数据');
  }
  if (contentType.includes('zip') || mode === 'official') {
    if (typeof JSZip === 'undefined') throw new Error('ZIP 解析组件未加载');
    try {
      const zip = await JSZip.loadAsync(await response.arrayBuffer());
      const name = Object.keys(zip.files).find(fileName => /\.(png|webp)$/i.test(fileName));
      if (!name) throw new Error('压缩包中没有图片');
      return zip.files[name].async('blob');
    } catch (error) {
      if (error.message.includes('图片')) throw error;
      throw new Error('无法解析 NovelAI 返回的图片包');
    }
  }
  if (contentType.includes('text/event-stream') || contentType.includes('text/plain')) {
    const raw = await response.text();
    const candidates = raw.split(/\r?\n/).map(line => line.replace(/^data:\s*/, '').trim()).filter(Boolean);
    for (const candidate of candidates.reverse()) {
      try {
        const data = JSON.parse(candidate);
        const item = data?.data?.[0] || data?.image || data;
        const base64 = item?.b64_json || item?.base64 || item?.image_base64;
        if (base64) return b64Blob(base64);
        if (item?.url) return (await fetch(item.url)).blob();
      } catch {}
    }
    const base64Match = raw.match(/(?:b64_json|image_base64|base64)["']?\s*[:=]\s*["']([A-Za-z0-9+/=]{100,})/i);
    if (base64Match) return b64Blob(base64Match[1]);
    throw new Error('站点返回了流式文本，但没有找到可识别的图片数据');
  }
  return response.blob();
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
  if (!meta.scenePrompt) {
    setStatus('画面描述为空', 'err', '直接生图仍需要填写这一次的主体与场景');
    $('scenePrompt').focus();
    return;
  }
  const button = $('generateBtn');
  button.disabled = true;
  button.querySelector('span').textContent = '正在生成';
  document.querySelector('.result-sheet').classList.add('generating');
  setStatus('请求已发送', 'run', `${meta.model} · ${meta.size}`);
  try {
    const mode = $('apiMode').value;
    const response = await fetch($('endpoint').value.trim(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, image/png, application/zip' },
      body: JSON.stringify(mode === 'official' ? naiRequest(meta) : proxyRequest(meta))
    });
    if (!response.ok) throw new Error(explainHttpError(response.status, await response.text(), mode));
    const blob = await parseImageResponse(response, mode);
    const id = await dbAdd('artworks', { ...meta, blob, createdAt: Date.now(), imported: false });
    if (meta.recipeId) {
      const recipe = await dbGet('recipes', meta.recipeId);
      if (recipe) {
        if (!recipe.coverArtworkId) recipe.coverArtworkId = id;
        recipe.lastUsedAt = Date.now();
        recipe.updatedAt = Date.now();
        await dbPut('recipes', recipe);
      }
    }
    if (latestUrl) URL.revokeObjectURL(latestUrl);
    latestUrl = URL.createObjectURL(blob);
    latestArtwork = { id, ...meta, blob };
    $('resultImage').src = latestUrl;
    $('resultImage').hidden = false;
    $('emptyStage').hidden = true;
    $('downloadLatest').href = latestUrl;
    $('downloadLatest').download = `NAI_${id}_${meta.model}.png`;
    $('downloadLatest').hidden = false;
    $('downloadLatestJpeg').hidden = false;
    setStatus('生成成功，已归档', 'ok', `${meta.category} · ${meta.tags.join(' / ') || '无标签'}`);
    await refreshData();
    toast('图片与当次完整参数已保存');
  } catch (error) {
    const cors = /Failed to fetch|NetworkError/i.test(error.message);
    setStatus('生成失败', 'err', cors ? '浏览器可能拦截了官方跨域请求，请改用可信反代。' : error.message);
  } finally {
    button.disabled = false;
    button.querySelector('span').textContent = '生成并归档';
    document.querySelector('.result-sheet').classList.remove('generating');
  }
};

function readNullTerminated(bytes, start) {
  let end = start;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return { bytes: bytes.slice(start, end), next: end + 1 };
}

async function inflateText(bytes) {
  if (typeof DecompressionStream === 'undefined') return '';
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new TextDecoder('utf-8').decode(await new Response(stream).arrayBuffer());
}

function decodeText(bytes) {
  return new TextDecoder('utf-8').decode(bytes).replace(/\u0000+$/g, '');
}

async function parsePNG(file) {
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)) throw new Error('请选择 PNG 图片');
  const text = {};
  let width = 0;
  let height = 0;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = new TextDecoder('ascii').decode(bytes.slice(offset + 4, offset + 8));
    const data = bytes.slice(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
      height = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4);
    }
    if (type === 'tEXt') {
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

function parseJSONCandidates(textMap) {
  const parsed = [];
  Object.values(textMap).forEach(value => {
    try {
      const candidate = JSON.parse(value);
      if (candidate && typeof candidate === 'object') parsed.push(candidate);
    } catch {}
  });
  return Object.assign({}, ...parsed);
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
  if (model.includes('5') && model.includes('curated')) return 'nai-diffusion-5-curated';
  if (model.includes('5')) return 'nai-diffusion-5-full';
  if (model.includes('4.5') || model.includes('4-5')) return model.includes('curated') ? 'nai-diffusion-4-5-curated' : 'nai-diffusion-4-5-full';
  return model.includes('v3') || model.includes('diffusion-3') ? 'nai-diffusion-3' : '';
}

function extractNovelAIMetadata(png) {
  const json = parseJSONCandidates(png.text);
  const prompt = json.prompt || json.input || json.description || png.text.Description || png.text.description || '';
  const negative = json.uc || json.negative_prompt || json.negativePrompt || png.text.Negative || '';
  const split = extractArtistPrompt(prompt);
  const model = normalizeModel(json.model || json.source || png.text.Source || png.text.Software || '');
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
  $('importPreview').src = URL.createObjectURL(file);
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
    const png = await parsePNG(file);
    const metadata = extractNovelAIMetadata(png);
    pendingImport.metadata = metadata;
    $('importArtist').value = metadata.artistPrompt;
    $('importPositive').value = metadata.positivePrompt;
    $('importNegative').value = metadata.negativePrompt;
    $('importRawPrompt').value = metadata.rawPrompt;
    $('importRawMeta').textContent = JSON.stringify(metadata.raw, null, 2);
    const artistName = metadata.artistPrompt.replace(/[{}[\]]/g, '').slice(0, 36);
    $('importRecipeName').value = artistName || file.name.replace(/\.png$/i, '');
    $('importStatus').textContent = metadata.rawPrompt || metadata.negativePrompt
      ? '已读取图片内嵌信息；自动拆分后请确认三项内容。'
      : '图片中没有可识别的 NovelAI 提示词，可能经过截图或平台转码；仍可手动填写并归档。';
  } catch (error) {
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
    title: pendingImport.file.name.replace(/\.png$/i, ''),
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
  if (recipeId) inspectRecipe(recipesCache.find(item => item.id === recipeId), false);
  switchView('gallery');
  toast(recipeId ? '图片与配方已归档' : '图片已保存到未分类');
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

const BACKUP_DATA_TYPES = ['artworks', 'recipes', 'characters', 'words'];
const BACKUP_TYPE_LABELS = { artworks: '图库', recipes: '配方', characters: '人物', words: '散词' };

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
  if (scope !== 'range') {
    return {
      artworks: types.has('artworks') ? allArtworks : [],
      recipes: types.has('recipes') ? allRecipes : [],
      words: types.has('words') ? allWords : [],
      characters: types.has('characters') ? allCharacters : []
    };
  }
  const bounds = dateBounds(startDate, endDate);
  const selectedArtworks = types.has('artworks') ? allArtworks.filter(item => itemInDateRange(item, bounds)) : [];
  const linkedRecipeIds = new Set(selectedArtworks.map(item => String(item.recipeId || '')).filter(Boolean));
  const linkedCharacterIds = new Set(selectedArtworks.flatMap(artworkCharacterIds));
  return {
    artworks: selectedArtworks,
    recipes: types.has('recipes') ? allRecipes.filter(item => itemInDateRange(item, bounds) || linkedRecipeIds.has(String(item.id))) : [],
    words: types.has('words') ? allWords.filter(item => itemInDateRange(item, bounds)) : [],
    characters: types.has('characters') ? allCharacters.filter(item => itemInDateRange(item, bounds) || linkedCharacterIds.has(String(item.id))) : []
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
    $('backupSummary').textContent = `将备份 ${selected.artworks.length} 张图片、${selected.recipes.length} 份配方、${selected.characters.length} 个人物和 ${selected.words.length} 个词条`;
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
      app: 'NAI 镜头台', version: 7, exportedAt: new Date().toISOString(),
      scope: scope === 'range' ? { type: 'range', startDate, endDate } : { type: 'all' },
      includedTypes: BACKUP_DATA_TYPES.filter(type => types.has(type)),
      artworks: packed,
      recipes: packedRecipes,
      words: packedWords,
      characters: packedCharacters
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
    toast(`已备份 ${packed.length} 张图片、${payload.recipes.length} 份配方、${payload.characters.length} 个人物和 ${payload.words.length} 个词条`);
  } catch (error) {
    toast(`备份失败：${error.message}`);
  }
};

$('importBtn').onclick = () => $('importFile').click();
function mergeRecord(existing, incoming, type = '') {
  const merged = { ...existing };
  const before = JSON.stringify(merged);
  merged.tags = [...new Set([...(existing.tags || []), ...(incoming.tags || [])])];
  ['name', 'category', 'note', 'sourceUrl', 'transferId'].forEach(key => {
    if (!merged[key] && incoming[key]) merged[key] = incoming[key];
  });
  if (existing.favorite || incoming.favorite) merged.favorite = true;
  if (existing.lastUsedAt || incoming.lastUsedAt) merged.lastUsedAt = Math.max(existing.lastUsedAt || 0, incoming.lastUsedAt || 0);
  if (type === 'recipe') merged.defaultParams = { ...(incoming.defaultParams || {}), ...(existing.defaultParams || {}) };
  if (type === 'recipe' && !merged.coverArtworkId && incoming.coverArtworkId) merged._incomingCoverArtworkId = incoming.coverArtworkId;
  if (type === 'artwork') {
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
  incoming.forEach(source => {
    const oldKey = String(source.id ?? '');
    const contentKey = keyFn(source);
    const matched = (source.transferId && byTransferId.get(source.transferId)) || (contentKey && byContent.get(contentKey));
    if (matched) {
      if (oldKey) idMap.set(oldKey, matched.id);
      const merged = mergeRecord(matched, source, type);
      if (merged.changed) {
        merges.push(merged.record);
        if (contentKey) byContent.set(contentKey, merged.record);
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
  const recognized = artworkSource.length || recipeSource.length || wordSource.length || characterSource.length || source.app || source.version;
  if (!recognized) throw new Error('没有找到图片、配方、人物或散词数据，请确认选择的是镜头台 JSON 备份');
  return {
    ...source,
    artworks: artworkSource,
    recipes: recipeSource.map(item => ({ ...item, artistPrompt: item.artistPrompt ?? item.artist ?? '', positivePrompt: item.positivePrompt ?? item.positive ?? '', negativePrompt: item.negativePrompt ?? item.negative ?? '' })),
    words: wordSource.map(item => ({ ...item, kind: item.kind || item.type || 'artist', content: item.content ?? item.value ?? item.prompt ?? '' })),
    characters: characterSource.map(item => ({ ...item, fullPrompt: item.fullPrompt ?? item.prompt ?? item.description ?? '' }))
  };
}

async function analyzeBackupImport(data) {
  data = normalizeBackupPayload(data);
  const existingRecipes = await dbAll('recipes');
  const existingArtworks = await dbAll('artworks');
  const existingWords = words();
  const existingCharacters = characters();
  const characterPlan = prepareRecordPlan(data.characters, existingCharacters, characterContentKey, 'character');
  const recipePlan = prepareRecordPlan(data.recipes, existingRecipes, recipeContentKey, 'recipe');
  const wordPlan = prepareRecordPlan(data.words, existingWords, wordContentKey, 'word');
  const artworkIdMap = new Map();
  const additions = [];
  const merges = [];
  let skipped = 0;
  const byTransfer = new Map(existingArtworks.filter(item => item.transferId).map(item => [item.transferId, item]));
  const byHash = new Map();
  for (const item of existingArtworks) {
    const hash = item.contentHash || await blobFingerprint(item.blob);
    byHash.set(hash, item);
  }
  for (const source of data.artworks) {
    const blob = await b64Blob(source.blob);
    const hash = source.contentHash || await blobFingerprint(blob);
    const matched = (source.transferId && byTransfer.get(source.transferId)) || byHash.get(hash);
    const oldKey = String(source.id ?? '');
    if (matched) {
      if (oldKey) artworkIdMap.set(oldKey, matched.id);
      const merged = mergeRecord(matched, { ...source, blob: matched.blob, contentHash: hash }, 'artwork');
      if (merged.changed) merges.push(merged.record);
      else skipped += 1;
      continue;
    }
    const mappedCharacterIds = artworkCharacterIds(source).map(id => characterPlan.idMap.get(String(id)) || id);
    additions.push({ ...source, id: undefined, recipeId: recipePlan.idMap.get(String(source.recipeId || '')) || source.recipeId || '', characterIds: mappedCharacterIds, characterId: mappedCharacterIds[0] || '', blob, contentHash: hash, _oldId: oldKey });
    byHash.set(hash, additions[additions.length - 1]);
  }
  const plans = { data, characterPlan, recipePlan, wordPlan, artworkPlan: { additions, merges, skipped, idMap: artworkIdMap } };
  plans.stats = {
    added: additions.length + recipePlan.additions.length + wordPlan.additions.length + characterPlan.additions.length,
    merged: merges.length + recipePlan.merges.length + wordPlan.merges.length + characterPlan.merges.length,
    skipped: skipped + recipePlan.skipped + wordPlan.skipped + characterPlan.skipped,
    conflicts: recipePlan.conflicts + wordPlan.conflicts + characterPlan.conflicts,
    artworkCount: additions.length, recipeCount: recipePlan.additions.length, wordCount: wordPlan.additions.length, characterCount: characterPlan.additions.length,
    artworkMerged: merges.length, recipeMerged: recipePlan.merges.length, wordMerged: wordPlan.merges.length, characterMerged: characterPlan.merges.length,
    artworkSkipped: skipped, recipeSkipped: recipePlan.skipped, wordSkipped: wordPlan.skipped, characterSkipped: characterPlan.skipped
  };
  return plans;
}

async function restoreBackupData(data, suppliedPlan = null) {
  const plan = suppliedPlan || await analyzeBackupImport(data);
  const existingCharacters = characters();
  const existingWords = words();
  const replaceMerged = (existing, merges) => {
    const map = new Map(merges.map(item => [String(item.id), item]));
    return existing.map(item => map.get(String(item.id)) || item);
  };
  if (plan.characterPlan.additions.length || plan.characterPlan.merges.length) saveCharacters([...plan.characterPlan.additions, ...replaceMerged(existingCharacters, plan.characterPlan.merges)]);
  if (plan.wordPlan.additions.length || plan.wordPlan.merges.length) saveWords([...plan.wordPlan.additions, ...replaceMerged(existingWords, plan.wordPlan.merges)]);
  if (characters().length < existingCharacters.length + plan.characterPlan.additions.length) throw new Error('人物库写入没有完成，请检查浏览器存储空间');
  if (words().length < existingWords.length + plan.wordPlan.additions.length) throw new Error('散词库写入没有完成，请检查浏览器存储空间');
  for (const record of plan.artworkPlan.merges) await dbPut('artworks', record);
  for (const artwork of plan.artworkPlan.additions) {
    const oldId = artwork._oldId;
    const record = { ...artwork };
    delete record.id;
    delete record._oldId;
    const newId = await dbAdd('artworks', record);
    if (oldId) plan.artworkPlan.idMap.set(oldId, newId);
  }
  for (const record of plan.recipePlan.merges) {
    const recipe = { ...record };
    if (!recipe.coverArtworkId && recipe._incomingCoverArtworkId) recipe.coverArtworkId = plan.artworkPlan.idMap.get(String(recipe._incomingCoverArtworkId)) || null;
    delete recipe._incomingCoverArtworkId;
    await dbPut('recipes', recipe);
  }
  for (const source of plan.recipePlan.additions) {
    const recipe = { ...source, coverArtworkId: plan.artworkPlan.idMap.get(String(source.coverArtworkId ?? '')) || null };
    await dbPut('recipes', recipe);
  }
  await refreshData();
  return { ...plan.stats, skippedCount: plan.stats.skipped, mergedCount: plan.stats.merged };
}

function showRestorePreview(data, plan) {
  pendingBackupImport = { data: plan.data || data, plan };
  $('restorePreviewStats').innerHTML = [
    ['新增', plan.stats.added], ['补全', plan.stats.merged], ['跳过重复', plan.stats.skipped]
  ].map(([label, count]) => `<div class="restore-stat"><b>${count}</b><span>${label}</span></div>`).join('');
  $('restorePreviewDetail').textContent = `新增：${plan.stats.artworkCount} 张图片、${plan.stats.recipeCount} 份配方、${plan.stats.characterCount} 个人物、${plan.stats.wordCount} 个词条。补全：图片 ${plan.stats.artworkMerged}、配方 ${plan.stats.recipeMerged}、人物 ${plan.stats.characterMerged}、散词 ${plan.stats.wordMerged}。跳过重复：图片 ${plan.stats.artworkSkipped}、配方 ${plan.stats.recipeSkipped}、人物 ${plan.stats.characterSkipped}、散词 ${plan.stats.wordSkipped}${plan.stats.conflicts ? `。另有 ${plan.stats.conflicts} 个编号冲突会保留为新记录` : ''}`;
  showDialog('restorePreviewDialog');
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
