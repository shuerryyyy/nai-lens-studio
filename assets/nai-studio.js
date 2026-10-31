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
const pickerViewStates = {};
let originalSeed = '';
let pickerTargetId = '';
let pickerItems = [];
let pickerCharacterSelection = new Set();
let pickerExistingCharacterIds = new Set();
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
const WORD_KINDS = ['scene', 'clothing', 'artist', 'positive', 'negative', 'bundle'];

const fields = [
  'scenePrompt', 'clothingPrompt', 'characterPrompt', 'characterSelectIds', 'artistPrompt', 'positivePrompt', 'negativePrompt', 'model',
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

function recordTimeText(record, label = '保存时间') {
  const timestamp = Number(record.createdAt);
  const date = new Date(timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0 || Number.isNaN(date.getTime())) return `${label}：未记录`;
  const pad = value => String(value).padStart(2, '0');
  return `${label}：${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function recordTimeButton(record) {
  return `<button type="button" class="flat-help flat-tool secondary" aria-label="查看说明" data-flat-tooltip="${escapeHTML(recordTimeText(record))}">${icon('info')}</button>`;
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
  if (dialog?.open) {
    if (id === 'pickerDialog') rememberPickerView();
    dialog.close();
  }
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
  return [$('positivePrompt').value.trim(), $('characterPrompt').value.trim(), $('clothingPrompt').value.trim(), $('scenePrompt').value.trim(), $('artistPrompt').value.trim()]
    .filter(Boolean).join(', ');
}

function seedReference(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  return /^\d+$/.test(text) && Number(text) <= 4294967295 ? String(Number(text)) : '';
}
function renderOriginalSeed() {
  $('originalSeedHint').textContent = `原始种子：${originalSeed || '未记录'}`;
}
function resetSeedForSource(source = {}, keepPrevious = true) {
  const reference = seedReference(source.seed) || seedReference(source.defaultParams?.seed) || seedReference(source.requestedSeed);
  originalSeed = reference || (keepPrevious ? seedReference($('seed').value) || originalSeed : '');
  $('seed').value = '';
  renderOriginalSeed();
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
  data.originalSeed = originalSeed;
  data.adapterId = NaiAdapters.selectedId();
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
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
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
  originalSeed = seedReference(data.originalSeed);
  // Retire seeds remembered by older builds; only later manual input stays fixed.
  if (!Object.prototype.hasOwnProperty.call(data, 'originalSeed')) {
    originalSeed = seedReference(data.seed);
    $('seed').value = '';
    data.seed = '';
    data.originalSeed = originalSeed;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
  }
  renderOriginalSeed();
  NaiAdapters.setSelected(data.adapterId || '');
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
  try {
    const list = JSON.parse(localStorage.getItem(API_PRESETS_KEY) || '[]');
    return Array.isArray(list) ? list.filter(item => item && typeof item === 'object' && typeof item.id === 'string' && typeof item.name === 'string') : [];
  } catch { return []; }
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
  NaiAdapters.setSelected(preset.adapterId || '');
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
  try { NaiAdapters.requireFor(endpoint, $('apiMode').value); } catch (error) { toast(error.message); return; }
  const list = apiPresets();
  const selectedId = $('apiPresetSelect').value;
  const existingIndex = list.findIndex(item => item.id === selectedId);
  const preset = {
    id: selectedId || makeId(), name, mode: $('apiMode').value, endpoint, adapterId: NaiAdapters.selectedId(),
    token: $('presetSaveToken').checked ? $('token').value.trim() : '', updatedAt: Date.now()
  };
  if (existingIndex >= 0) list.splice(existingIndex, 1, preset);
  else list.unshift(preset);
  try { saveApiPresets(list); } catch (error) { toast(`预设保存失败：${error.message}`); return; }
  $('apiPresetSelect').value = preset.id;
  $('deleteApiPresetBtn').disabled = false;
  updateApiStatus();
  toast(existingIndex >= 0 ? 'API 预设已更新' : 'API 预设已保存');
};

$('deleteApiPresetBtn').onclick = () => {
  const id = $('apiPresetSelect').value;
  const preset = apiPresets().find(item => item.id === id);
  if (!preset || !confirm(`删除 API 预设“${preset.name}”？`)) return;
  try { saveApiPresets(apiPresets().filter(item => item.id !== id)); }
  catch (error) { toast(`预设删除失败：${error.message}`); return; }
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
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['artworks', 'recipes', 'vibes', 'collections'], 'readwrite');
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error || new Error('清除失败，数据库内容已保留')); tx.onerror = () => {};
      try { for (const name of ['artworks', 'recipes', 'vibes', 'collections']) tx.objectStore(name).clear(); }
      catch (error) { tx.abort(); reject(error); }
    });
    collectionsCache = [];
    Object.keys(localStorage).filter(key => key.startsWith('nai_studio_') || key.startsWith('nai_folder_open_') || key === 'nai_vibe_expanded').forEach(key => localStorage.removeItem(key));
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

function characters() {
  return readLocalLibrary(CHARACTERS_KEY, 'character');
}

function saveCharacters(list) {
  writeLocalLibrary(CHARACTERS_KEY, 'character', list);
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
  resetSeedForSource(character);
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
  writeLocalLibrary(WORDS_KEY, 'word', list);
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
    await commitRecords({ recipes: [recipe], artworks: items.map(artwork => ({ ...artwork, recipeId: recipe.id })) });
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
  resetSeedForSource(recipe);
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
  $('recipeScale').value = params.scale ?? '';
  $('recipeModel').value = params.model || '';
  $('recipeSampler').value = params.sampler || 'k_euler_ancestral';
  showDialog('recipeDialog');
  setTimeout(() => $('recipeName').focus(), 50);
}

$('newRecipeBtn').onclick = () => openRecipeEditor(null, true);
$('galleryNewRecipeBtn').onclick = () => openRecipeEditor();
$('saveBundleBtn').onclick = () => openRecipeEditor(null, true);

$('recipeForm').onsubmit = async event => {
  event.preventDefault();
  const submit = $('recipeForm').querySelector('[type="submit"]');
  if (submit.disabled) return;
  if (!$('recipeScale').checkValidity()) { $('recipeScale').reportValidity(); return; }
  submit.disabled = true;
  let saved = false;
  try {
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
      scale: $('recipeScale').value.trim() === '' ? undefined : Number($('recipeScale').value),
      steps: Number($('recipeSteps').value) || 28,
      sampler: $('recipeSampler').value
    }
  };
  await dbPut('recipes', recipe);
  saved = true;
  closeDialog('recipeDialog');
  await refreshData();
  applyRecipe(recipesCache.find(item => item.id === recipe.id));
  toast(id ? '配方已更新' : '配方档案已创建');
  } catch (error) { toast(saved ? `配方已保存，但后续更新未完成：${error.message}。请刷新查看。` : `操作失败：${error.message}`); }
  finally { submit.disabled = false; }
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

const WORD_PROMPT_FIELDS = ['clothingPrompt', 'scenePrompt', 'artistPrompt', 'positivePrompt', 'negativePrompt'];
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
    item.positivePrompt, item.clothingPrompt, item.negativePrompt, item.category, ...(item.tags || []),
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
    writeLocalLibrary(WORDS_KEY, 'word', list);
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
  const authors = new Set(recipesCache.map(recipe => String(recipe.author || '').trim().toLowerCase()).filter(Boolean));
  const matchingAuthors = new Set([...authors].filter(author => authors.has(query) ? author === query : query && author.includes(query)));
  const authorSearch = matchingAuthors.size > 0;
  const matchingArtworks = query && !authorSearch ? artworksCache.filter(item => artworkSearchText(item).includes(query)) : [];
  const matchingRecipeIds = new Set(matchingArtworks.map(item => item.recipeId || '__uncategorized__'));
  let list = views.filter(recipe => authorSearch ? matchingAuthors.has(String(recipe.author || '').trim().toLowerCase()) : !query || matchingRecipeIds.has(recipe.id) || [
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
    : `<div class="tools">${recordTimeButton(recipe)}<button class="secondary" id="useRecipe" type="button">去创作台</button><button class="secondary" id="moveRecipeFront" type="button">移到最前</button><button class="icon-btn${recipe.favorite ? ' favorite-active' : ''}" id="favoriteRecipe" type="button" aria-label="${recipe.favorite ? '取消收藏' : '收藏'}配方" aria-pressed="${Boolean(recipe.favorite)}">${icon('star')}</button><button class="icon-btn" id="editRecipe" type="button" aria-label="编辑配方">${icon('settings')}</button></div>`;
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
  $('imageDialogMeta').textContent = `${recipe?.name || '未关联配方'} · ${shortModel(item.model || '未知模型')} · ${item.size || '未知尺寸'} · ${recordTimeText(item, item.imported ? '导入时间' : '生成时间')}`;
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
    ['画师串', item.artistPrompt], ['正面提示词', item.positivePrompt], ['负面提示词', item.negativePrompt],
    ['服装', item.clothingPrompt]
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
  resetSeedForSource(item, false);
  $('clothingPrompt').value = item.clothingPrompt || '';
  trackedWordSources = structuredClone(Array.isArray(item.wordSources) ? item.wordSources : inferredWordSources(item));
  restoreVibeSelection(item.vibes || [], item.model);
  ['scenePrompt', 'clothingPrompt', 'characterPrompt', 'artistPrompt', 'positivePrompt', 'negativePrompt', 'model', 'size', 'steps', 'scale', 'sampler', 'noiseSchedule'].forEach(key => {
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
  $('pickerSelectedCount').textContent = count ? `本次已选 ${count} 个新人物` : '请选择新人物';
  $('replaceCharactersBtn').disabled = !count;
  $('appendCharactersBtn').disabled = !count;
}

function renderPickerList() {
  const query = $('pickerSearch').value.trim().toLowerCase();
  const list = sortPickerItems(pickerItems.filter(item => !query || item.search.includes(query)));
  if (pickerKind === 'character') {
    $('pickerList').innerHTML = list.length ? list.map(item => `<label class="picker-check"><input type="checkbox" value="${escapeHTML(item.id)}"${pickerExistingCharacterIds.has(item.id) ? ' checked disabled' : pickerCharacterSelection.has(item.id) ? ' checked' : ''}><span><b>${escapeHTML(item.name)}</b><span>${escapeHTML(item.value)}</span>${pickerExistingCharacterIds.has(item.id) ? '<span class="picker-badge">当前使用</span>' : ''}${item.favorite ? '<span class="picker-badge">已收藏</span>' : ''}</span></label>`).join('') : '<div class="empty"><div><b>没有匹配的人物</b><span>试试人物名称、标签或描述中的关键词。</span></div></div>';
    $('pickerList').querySelectorAll('input').forEach(input => input.onchange = () => {
      if (input.disabled) return;
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
    if (WORD_PROMPT_FIELDS.includes(pickerTargetId)) {
      const source = item.libraryType === 'recipes'
        ? recipesCache.find(record => String(record.id) === String(item.recordId))
        : words().find(record => String(record.id) === String(item.recordId));
      resetSeedForSource(source);
    }
    saveSettings();
    closeDialog('pickerDialog');
    toast(button.dataset.pickerMode === 'append' ? '已追加到输入框' : '已替换输入框内容');
  });
}

function applyPickedCharacters(mode) {
  const availableIds = new Set(pickerItems.map(item => String(item.id)));
  const pickedIds = [...pickerCharacterSelection].filter(id => !pickerExistingCharacterIds.has(id) && availableIds.has(id));
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
  resetSeedForSource();
  saveSettings();
  closeDialog('pickerDialog');
  toast(`${pickedIds.length} 个人物已${mode === 'append' ? '追加' : '放入'}创作台`);
}

function rememberPickerView() {
  const state = {
    search: $('pickerSearch').value,
    scrollTop: $('pickerList').scrollTop,
    dialogScrollTop: $('pickerDialog').scrollTop
  };
  pickerViewStates[pickerKind] = state;
  try { localStorage.setItem(`nai_picker_view_${pickerKind}`, JSON.stringify(state)); } catch { /* Browsing can continue without persistent preferences. */ }
}
$('pickerDialog').addEventListener('cancel', rememberPickerView);

function openPicker(kind, targetId = `${kind}Prompt`) {
  if ($('pickerDialog').open) rememberPickerView();
  if (!pickerViewStates[kind]) {
    try { pickerViewStates[kind] = JSON.parse(localStorage.getItem(`nai_picker_view_${kind}`)); } catch { /* Ignore invalid browsing preferences. */ }
  }
  const viewState = pickerViewStates[kind] || {};
  pickerKind = kind;
  $('pickerSort').value = localStorage.getItem(`nai_picker_sort_${kind}`) || 'favorite';
  pickerTargetId = targetId;
  $('pickerSearch').value = typeof viewState.search === 'string' ? viewState.search : '';
  const fieldName = { scene: '画面描述词', clothing: '服装', character: '人物提示词', artist: '画师串', positive: '正面词', negative: '负面词' }[kind];
  $('pickerTitle').textContent = `选择${fieldName}`;
  $('pickerHelp').textContent = kind === 'character' ? '当前使用的人物已勾选并锁定，不计入本次选择。另选人物后，可替换当前人物或追加；搜索和排序会保留新选择。' : '收藏内容优先显示；“替换”会清空当前字段，“追加”会接在后面。';
  $('pickerMultiActions').hidden = kind !== 'character';
  if (kind === 'character') {
    pickerExistingCharacterIds = new Set(selectedCharacterIds());
    pickerCharacterSelection = new Set();
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
  requestAnimationFrame(() => {
    if (pickerKind !== kind || !$('pickerDialog').open) return;
    $('pickerSearch').focus({ preventScroll: true });
    $('pickerList').scrollTop = Number.isFinite(viewState.scrollTop) ? viewState.scrollTop : 0;
    $('pickerDialog').scrollTop = Number.isFinite(viewState.dialogScrollTop) ? viewState.dialogScrollTop : 0;
  });
}

$('pickerSearch').addEventListener('input', renderPickerList);

document.querySelectorAll('[data-pick]').forEach(button => button.onclick = () => openPicker(button.dataset.pick));
document.querySelectorAll('[data-recipe-pick]').forEach(button => button.onclick = () => openPicker(button.dataset.recipePick, `recipe${button.dataset.recipePick[0].toUpperCase()}${button.dataset.recipePick.slice(1)}`));

function kindName(kind) {
  return ({ scene: '画面描述词', clothing: '服装', artist: '画师串', positive: '正面词', negative: '负面词', bundle: '整套配方' })[kind] || '散词';
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
    return `<article class="word-row${authorSelections.words.active ? ' word-selection-mode' : ''}${authorSelections.words.active && authorSelections.words.ids.has(String(word.id)) ? ' selected' : ''}${expandedWordId === String(word.id) ? ' expanded' : ''}">${authorSelections.words.active ? `<label class="word-bulk-select"><input type="checkbox" data-word-select="${escapeHTML(word.id)}" aria-label="选择${escapeHTML(word.name)}" ${authorSelections.words.ids.has(String(word.id)) ? 'checked' : ''}></label>` : ''}<button class="word-mobile-summary" data-word-expand="${escapeHTML(word.id)}" type="button" ${authorSelections.words.active ? `aria-pressed="${authorSelections.words.ids.has(String(word.id))}"` : `aria-expanded="${expandedWordId === String(word.id)}"`}><span><b>${escapeHTML(word.name)}</b> · ${kindName(word.kind)}</span><span>${authorSelections.words.active ? (authorSelections.words.ids.has(String(word.id)) ? '已选择' : '未选择') : expandedWordId === String(word.id) ? '收起' : '展开'}</span></button><div class="word-row-details"><div class="word-kind"><span class="kind-dot ${word.kind}"></span>${kindName(word.kind)}</div><div class="word-content"><b>${escapeHTML(word.name)}</b>${summary}${provenance}</div><div class="word-actions">${recordTimeButton(word)}${copyActions}<button class="icon-btn${word.favorite ? ' favorite-active' : ''}" data-word-favorite="${escapeHTML(word.id)}" type="button" aria-label="${word.favorite ? '取消收藏' : '收藏'}${escapeHTML(word.name)}" aria-pressed="${Boolean(word.favorite)}">${icon('star')}</button><button class="secondary" data-word-use="${escapeHTML(word.id)}" type="button" style="padding:7px 10px">使用</button><button class="secondary" data-word-edit="${escapeHTML(word.id)}" type="button" style="padding:7px 10px">修改</button><button class="icon-btn" data-word-del="${escapeHTML(word.id)}" type="button" aria-label="删除${escapeHTML(word.name)}">${icon('trash')}</button></div></div></article>`;
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
  resetSeedForSource(word);
  saveSettings();
  switchView('create');
  toast('已放入创作台');
}

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
