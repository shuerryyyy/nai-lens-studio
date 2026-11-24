'use strict';
/* Backup export, merge planning and transactional restore. Existing data formats are preserved. */

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

async function backupSelection(scope = 'all', startDate = '', endDate = '', selectedTypes = new Set(BACKUP_DATA_TYPES), metadataOnly = false) {
  const types = selectedTypes instanceof Set ? selectedTypes : new Set(selectedTypes || []);
  if (!types.size) throw new Error('请至少选择一类要备份的数据');
  const allArtworks = types.has('artworks') ? await (metadataOnly ? backupArtworkMetadata() : dbAll('artworks')) : [];
  const allRecipes = await dbAll('recipes');
  const allWords = types.has('words') ? words() : [];
  const allCharacters = types.has('characters') ? characters() : [];
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
  const selectedRecipes = types.has('recipes') ? allRecipes.filter(item => itemInDateRange(item, bounds) || linkedRecipeIds.has(String(item.id))) : [];
  const linkedCharacterIds = new Set(selectedArtworks.flatMap(artworkCharacterIds));
  const linkedWordIds = new Set(selectedArtworks.flatMap(item => [...(Array.isArray(item.wordSources) ? item.wordSources : []).filter(Boolean).map(source => String(source.wordId || '')), ...(Array.isArray(item.exampleWordIds) ? item.exampleWordIds.map(String) : [])]));
  const linkedVibeIds = new Set(selectedArtworks.flatMap(item => (item.vibes || []).map(entry => entry.id)));
  for (const recipe of allRecipes.filter(item => linkedRecipeIds.has(String(item.id)) || selectedRecipes.includes(item))) for (const item of recipe.defaultParams?.vibes || []) linkedVibeIds.add(item.id);
  for (const mix of allVibes.filter(item => item.type === 'bundle' && itemInDateRange(item,bounds))) for (const item of mix.items) linkedVibeIds.add(item.id);
  return {
    artworks: selectedArtworks,
    recipes: selectedRecipes,
    words: types.has('words') ? allWords.filter(item => itemInDateRange(item, bounds) || linkedWordIds.has(String(item.id))) : [],
    characters: types.has('characters') ? allCharacters.filter(item => itemInDateRange(item, bounds) || linkedCharacterIds.has(String(item.id))) : [],
    vibes: allVibes.filter(item => itemInDateRange(item,bounds) || linkedVibeIds.has(item.id)), collections
  };
}

function withTransferId(item, type, sourceDeviceId) {
  return { ...item, transferId: item.transferId || `${sourceDeviceId}:${type}:${item.id}` };
}

async function updateBackupSummary() {
  if (backupExportBusy || pendingBackupExport) return;
  const scope = document.querySelector('[name="backupScope"]:checked')?.value || 'all';
  const types = selectedBackupTypes();
  $('backupRange').hidden = scope !== 'range';
  $('backupStartDate').required = scope === 'range';
  $('backupEndDate').required = scope === 'range';
  $('backupSubmitBtn').disabled = !types.size;
  $('backupSummary').classList.toggle('is-warning', !types.size);
  try {
    const selected = await backupSelection(scope, $('backupStartDate').value, $('backupEndDate').value, types, true);
    if (backupExportBusy || pendingBackupExport) return;
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

$('importBtn').onclick = () => $('importFile').click();
function mergeCharacterRevision(existing, incoming) {
  // Stable backup identity distinguishes an edited character from a lookalike.
  if (!existing.transferId || existing.transferId !== incoming.transferId) return null;
  const revision = item => {
    const value = Number(item.updatedAt);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  const incomingRevision = revision(incoming), existingRevision = revision(existing);
  if (!incomingRevision || incomingRevision <= existingRevision) return { record: { ...existing }, changed: false };
  const record = { ...existing };
  const editable = ['name', 'fullPrompt', 'negativePrompt', ...Object.keys(characterFieldLabels), 'tags', 'favorite', 'note', 'sourceUrl', 'author'];
  for (const key of editable) {
    // An explicit empty value is an edit; a field absent in old formats is not.
    if (Object.prototype.hasOwnProperty.call(incoming, key)) record[key] = incoming[key];
  }
  record.updatedAt = incomingRevision;
  return { record, changed: JSON.stringify(record) !== JSON.stringify(existing) };
}

function mergeRecord(existing, incoming, type = '') {
  if (type === 'character') {
    const revision = mergeCharacterRevision(existing, incoming);
    if (revision) return revision;
  }
  const merged = { ...existing };
  const before = JSON.stringify(merged);
  merged.tags = [...new Set([...(existing.tags || []), ...(incoming.tags || [])])];
  ['name', 'category', 'note', 'author', 'sourceUrl', 'transferId', 'folderId'].forEach(key => {
    if (!merged[key] && incoming[key]) merged[key] = incoming[key];
  });
  if (existing.favorite || incoming.favorite) merged.favorite = true;
  if (type === 'character' && !merged.negativePrompt && incoming.negativePrompt) merged.negativePrompt = incoming.negativePrompt;
  if (existing.lastUsedAt || incoming.lastUsedAt) merged.lastUsedAt = Math.max(existing.lastUsedAt || 0, incoming.lastUsedAt || 0);
  if (type === 'recipe') merged.defaultParams = { ...(incoming.defaultParams || {}), ...(existing.defaultParams || {}) };
  if (type === 'collection' && Number.isSafeInteger(incoming.manualOrder) && (existing.manualOrder === undefined || existing.transferId && existing.transferId === incoming.transferId && Number(incoming.updatedAt) > Number(existing.updatedAt))) merged.manualOrder = incoming.manualOrder;
  if (type === 'recipe' && !merged.coverArtworkId && incoming.coverArtworkId) merged._incomingCoverArtworkId = incoming.coverArtworkId;
  if (type === 'artwork') {
    if (Array.isArray(existing.exampleWordIds) || Array.isArray(incoming.exampleWordIds)) merged.exampleWordIds = [...new Set([...(Array.isArray(existing.exampleWordIds) ? existing.exampleWordIds : []), ...(Array.isArray(incoming.exampleWordIds) ? incoming.exampleWordIds : [])])];
    if (!Array.isArray(existing.wordSources) && Array.isArray(incoming.wordSources)) merged.wordSources = incoming.wordSources;
    if (!promptOrder.valid(existing.promptOrder) && promptOrder.valid(incoming.promptOrder) && existing.fullPrompt === incoming.fullPrompt
      && incoming.promptOrder.every(id => (existing[id] || '') === (incoming[id] || ''))) {
      merged.promptOrder = incoming.promptOrder;
    }
    merged.characterIds = [...new Set([...artworkCharacterIds(existing), ...artworkCharacterIds(incoming)])];
    merged.characterId = merged.characterIds[0] || '';
  }
  const changed = before !== JSON.stringify(merged);
  if (changed) merged.updatedAt = Math.max(existing.updatedAt || 0, incoming.updatedAt || 0, type === 'character' ? 0 : Date.now());
  return { record: merged, changed };
}

function recipeBackupKey(recipe) {
  // Old backups lack transfer IDs. Require the original ID plus creation details.
  const originalId = String(recipe.backupSourceId ?? recipe.id ?? '');
  const createdAt = Number(recipe.createdAt);
  if (!originalId) return '';
  return JSON.stringify(Number.isFinite(createdAt) && createdAt > 0
    ? [originalId, createdAt]
    : [originalId, recipe.name || '', recipeContentKey(recipe)]);
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
    const fallback = contentKey && byContent.get(contentKey);
    const hasDifferentRecipeIdentity = type === 'recipe' && source.transferId && fallback?.transferId;
    const matched = (source.transferId && byTransferId.get(source.transferId)) || (!hasDifferentRecipeIdentity && fallback);
    if (matched) {
      if (oldKey) idMap.set(oldKey, matched.id);
      const merged = mergeRecord(matched, source, type);
      if (merged.changed) {
        const previousContentKey = keyFn(matched);
        Object.assign(matched, merged.record);
        if (previousContentKey && byContent.get(previousContentKey) === matched) byContent.delete(previousContentKey);
        const nextContentKey = keyFn(matched);
        if (nextContentKey) byContent.set(nextContentKey, matched);
        if (matched.transferId) byTransferId.set(matched.transferId, matched);
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
    if (type === 'recipe' && oldKey && String(newId) !== oldKey) record.backupSourceId = source.backupSourceId ?? oldKey;
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

async function analyzeBackupImport(data, restoreRecipeLinks = false) {
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
  const existingArtworks = data.artworks.length ? await backupArtworkMetadata() : [];
  const existingWords = words();
  const existingCharacters = characters();
  const characterPlan = prepareRecordPlan(data.characters, existingCharacters, characterContentKey, 'character');
  const recipePlan = prepareRecordPlan(data.recipes, existingRecipes, recipeBackupKey, 'recipe');
  const sourceRecipeNames = new Map(data.recipes.map(recipe => [String(recipe.id), recipe.name]));
  const wordPlan = prepareRecordPlan(data.words, existingWords, wordContentKey, 'word');
  for (const artwork of data.artworks) {
    if (Array.isArray(artwork.wordSources)) artwork.wordSources = artwork.wordSources.filter(source => source && typeof source.content === 'string').map(source => ({ ...source, wordId: wordPlan.idMap.get(String(source.wordId)) || '' }));
    if (Array.isArray(artwork.exampleWordIds)) artwork.exampleWordIds = artwork.exampleWordIds.map(id => wordPlan.idMap.get(String(id))).filter(Boolean);
  }
  const artworkIdMap = new Map();
  const additions = [];
  const merges = [];
  const restoredRecipeLinks = new Map();
  let artworkRecipeLinkCount = 0;
  let skipped = 0;
  const byHash = new Map();
  for (const item of existingArtworks) {
    const cached = crypto.subtle ? /^[a-f0-9]{64}$/.test(item.contentHash || '') : /^fnv-/.test(item.contentHash || '');
    const hash = cached ? item.contentHash : await blobFingerprint((await dbGet('artworks', item.id)).blob);
    const { _backupBlobSize, ...record } = item;
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(record);
  }
  for (const source of data.artworks) {
    const blob = await b64Blob(source.blob);
    const hash = await blobFingerprint(blob);
    const candidates = byHash.get(hash) || [];
    const oldKey = String(source.id ?? '');
    const sourceRecipeId = source.recipeId || '';
    const mappedRecipeId = recipePlan.idMap.get(String(sourceRecipeId));
    const recipeId = mappedRecipeId || sourceRecipeId;
    const sameArtwork = source.transferId && candidates.find(item => item.transferId === source.transferId);
    const matched = sameArtwork || candidates.find(item => !recipeId || item.recipeId === recipeId);
    const mappedCharacterIds = artworkCharacterIds(source).map(id => characterPlan.idMap.get(String(id)) || id);
    if (matched) {
      if (oldKey) {
        if (matched._oldIds) matched._oldIds.push(oldKey);
        else artworkIdMap.set(oldKey, matched.id);
      }
      const mappedSource = { ...source, characterIds: mappedCharacterIds, blob, contentHash: hash };
      const merged = mergeRecord(matched, mappedSource, 'artwork');
      if (sameArtwork && mappedRecipeId && matched.recipeId !== mappedRecipeId && !matched._oldIds) {
        artworkRecipeLinkCount += 1;
        if (restoreRecipeLinks) {
          restoredRecipeLinks.set(matched.id, { recipeId: matched.recipeId, updatedAt: matched.updatedAt });
          merged.record.recipeId = mappedRecipeId;
          merged.record.category = source.category || sourceRecipeNames.get(String(sourceRecipeId)) || '';
          merged.record.updatedAt = Date.now();
          merged.changed = true;
        }
      }
      if (merged.changed) {
        merged.record.blob = matched.blob || blob;
        merged.record.contentHash = hash;
        Object.assign(matched, merged.record);
        if (!matched._oldIds && !merges.includes(matched)) merges.push(matched);
      }
      else skipped += 1;
      continue;
    }
    const record = { ...source, id: undefined, recipeId, characterIds: mappedCharacterIds, characterId: mappedCharacterIds[0] || '', blob, contentHash: hash, _oldIds: oldKey ? [oldKey] : [] };
    additions.push(record);
    candidates.push(record);
    byHash.set(hash, candidates);
  }
  for (const recipe of existingRecipes) {
    const previous = restoredRecipeLinks.get(recipe.coverArtworkId);
    if (!previous || previous.recipeId !== recipe.id) continue;
    recipe.coverArtworkId = null;
    if (!recipePlan.merges.includes(recipe)) recipePlan.merges.push(recipe);
  }
  const plans = { data, collectionPlan, vibeRecords, characterPlan, recipePlan, wordPlan, artworkPlan: { additions, merges, skipped, idMap: artworkIdMap, restoredRecipeLinks } };
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
  plans.stats.artworkRecipeLinkCount = artworkRecipeLinkCount;
  plans.stats.artworkRecipeLinksRestored = restoredRecipeLinks.size;
  plans.stats.collectionCount = collectionPlan.additions.length;
  plans.stats.added += collectionPlan.additions.length;
  plans.stats.merged += collectionPlan.merges.length;
  plans.stats.skipped += collectionPlan.skipped;
  plans.stats.conflicts += collectionPlan.conflicts;
  plans.stats.added += vibeRecords.newCount;
  plans.stats.merged += vibeRecords.length-vibeRecords.newCount;
  return plans;
}

async function restoreBackupData(data, restoreRecipeLinks = false) {
  if (restoreInProgress) throw new Error('另一个备份正在恢复，请稍后再试');
  restoreInProgress = true;
  const previousCharacters = localStorage.getItem(CHARACTERS_KEY);
  const previousWords = localStorage.getItem(WORDS_KEY);
  let localWritten = false;
  try {
  const plan = await analyzeBackupImport(data, restoreRecipeLinks);
  const existingCharacters = characters();
  const existingWords = words();
  const replaceMerged = (existing, merges) => {
    const map = new Map(merges.map(item => [String(item.id), item]));
    return existing.map(item => map.get(String(item.id)) || item);
  };
  localWritten = true;
  if (plan.characterPlan.additions.length || plan.characterPlan.merges.length) writeLocalLibrary(CHARACTERS_KEY, 'character', [...plan.characterPlan.additions, ...replaceMerged(existingCharacters, plan.characterPlan.merges)]);
  if (plan.wordPlan.additions.length || plan.wordPlan.merges.length) writeLocalLibrary(WORDS_KEY, 'word', [...plan.wordPlan.additions, ...replaceMerged(existingWords, plan.wordPlan.merges)]);
  if (characters().length < existingCharacters.length + plan.characterPlan.additions.length) throw new Error('人物库写入没有完成，请检查浏览器存储空间');
  if (words().length < existingWords.length + plan.wordPlan.additions.length) throw new Error('散词库写入没有完成，请检查浏览器存储空间');
  await withArtworkStorage(async () => {
  const artworkAdditions = await Promise.all(plan.artworkPlan.additions.map(artworkForStorage));
  const artworkMerges = await Promise.all(plan.artworkPlan.merges.map(artworkForStorage));
  await new Promise((resolve, reject) => {
  const transaction = db.transaction(['artworks', 'recipes', 'vibes', 'collections'], 'readwrite');
  let failure;
  transaction.oncomplete = resolve;
  transaction.onabort = () => reject(failure || transaction.error || new Error('备份恢复写入失败，图片与配方已撤销'));
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
  for (const record of artworkMerges) {
    const previous = plan.artworkPlan.restoredRecipeLinks.get(record.id);
    if (!previous) {
      artworks.put(record);
      continue;
    }
    const request = artworks.get(record.id);
    request.onsuccess = () => {
      const current = request.result;
      if (!current || current.recipeId !== previous.recipeId || current.updatedAt !== previous.updatedAt) {
        failure = new Error('恢复期间图片归属或资料已修改，请重新预览备份');
        transaction.abort();
        return;
      }
      artworks.put(record);
    };
  }
  let remaining = artworkAdditions.length;
  if (!remaining) writeRecipes();
  for (const artwork of artworkAdditions) {
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
  pendingBackupImport = data;
  $('restoreRecipeLinks').checked = false;
  $('restoreRecipeLinksOption').hidden = !plan.stats.artworkRecipeLinkCount;
  $('restoreRecipeLinksLabel').textContent = `按备份恢复 ${plan.stats.artworkRecipeLinkCount} 张已有图片的配方归属（会移动图片）`;
  $('restorePreviewStats').innerHTML = [
    ['新增', plan.stats.added], ['更新/补全', plan.stats.merged], ['跳过重复', plan.stats.skipped]
  ].map(([label, count]) => `<div class="restore-stat"><b>${count}</b><span>${label}</span></div>`).join('');
  $('restorePreviewDetail').textContent = `新增：${plan.stats.artworkCount} 张图片、${plan.stats.recipeCount} 份配方、${plan.stats.characterCount} 个人物、${plan.stats.wordCount} 个词条。更新/补全：图片 ${plan.stats.artworkMerged}、配方 ${plan.stats.recipeMerged}、人物 ${plan.stats.characterMerged}、散词 ${plan.stats.wordMerged}。跳过重复：图片 ${plan.stats.artworkSkipped}、配方 ${plan.stats.recipeSkipped}、人物 ${plan.stats.characterSkipped}、散词 ${plan.stats.wordSkipped}${plan.stats.conflicts ? `。另有 ${plan.stats.conflicts} 个编号冲突会保留为新记录` : ''}`;
  showDialog('restorePreviewDialog');
  $('restorePreviewDetail').textContent += `。Vibe 素材/组合：${plan.stats.vibeCount || 0} 项。同一人物采用修改时间较新的版本；时间相同或缺失时保留本地内容`;
  const part = data.backupSet;
  if (Number.isSafeInteger(part?.index) && Number.isSafeInteger(part?.total) && part.index > 0 && part.index <= part.total && part.total > 1) $('restorePreviewDetail').textContent += `。这是第 ${part.index}/${part.total} 份备份，请继续逐份导入其余文件`;
}

$('cancelRestorePreview').onclick = () => { pendingBackupImport = null; closeDialog('restorePreviewDialog'); };
$('restorePreviewDialog').addEventListener('close', () => {
  if (!$('restorePreviewDialog').open) pendingBackupImport = null;
});
$('confirmRestorePreview').onclick = async () => {
  if (!pendingBackupImport) return;
  const button = $('confirmRestorePreview');
  button.disabled = true;
  try {
    // Recompute against current data: another tab may have edited records while
    // the preview was open. Never apply a stale overwrite plan.
    const restored = await restoreBackupData(pendingBackupImport, $('restoreRecipeLinks').checked);
    closeDialog('restorePreviewDialog');
    const restoredLinks = restored.artworkRecipeLinksRestored ? `，已恢复 ${restored.artworkRecipeLinksRestored} 张已有图片的配方归属` : '';
    toast(`已新增 ${restored.artworkCount} 张图片、${restored.recipeCount} 份配方；更新/补全 ${restored.mergedCount} 项，跳过 ${restored.skippedCount} 项重复${restoredLinks}`);
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
