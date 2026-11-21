'use strict';
/* Bounded JSON volumes; each volume carries its related records for independent restore. */

const BACKUP_PART_BYTES = 300 * 1024 * 1024;
const BACKUP_ARRAYS = ['artworks', 'recipes', 'words', 'characters', 'vibeRecords', 'collections'];
let pendingBackupExport = null;
let backupExportBusy = false;
let backupExportRevision = 0;

async function prepareBackupIdentities(selected, sourceDeviceId) {
  for (const recipe of selected.recipes) {
    if (recipe.transferId) continue;
    recipe.transferId = withTransferId(recipe, 'recipe', sourceDeviceId).transferId;
    await dbPut('recipes', recipe);
  }
  for (const [type, key, read] of [['words', WORDS_KEY, words], ['characters', CHARACTERS_KEY, characters]]) {
    const ids = new Map();
    selected[type] = selected[type].map(record => {
      const exported = withTransferId(record, type === 'words' ? 'word' : 'character', sourceDeviceId);
      if (!record.transferId) ids.set(String(record.id), exported.transferId);
      return exported;
    });
    if (ids.size) writeLocalLibrary(key, type === 'words' ? 'word' : 'character', read().map(record => ids.has(String(record.id)) ? { ...record, transferId: ids.get(String(record.id)) } : record));
  }
  selected.collections = selected.collections.map(record => withTransferId(record, 'collection', sourceDeviceId));
}

function planBackupVolumes(selected, targetBytes = BACKUP_PART_BYTES) {
  const libraries = { ...selected, vibeRecords: selected.vibes };
  const indexes = new Map(BACKUP_ARRAYS.map(type => [type, new Map(libraries[type].map(record => [String(record.id), record]))]));
  const sizes = new Map(), covered = new Set(), volumes = [];
  const key = (type, record) => `${type}:${record.id}`;
  const size = (type, record) => {
    const id = key(type, record);
    if (!sizes.has(id)) {
      const { _backupBlobSize, ...metadata } = record;
      sizes.set(id, new Blob([JSON.stringify(metadata)]).size + (type === 'artworks' ? 4 * Math.ceil((_backupBlobSize || 0) / 3) + 128 : 0) + 1);
    }
    return sizes.get(id);
  };
  const empty = () => ({ records: new Map(BACKUP_ARRAYS.map(type => [type, new Map()])), bytes: 2048 });
  let current = empty();
  for (const type of BACKUP_ARRAYS) for (const record of libraries[type]) {
    if (covered.has(key(type, record))) continue;
    const unit = empty();
    const add = (kind, item) => {
      if (!item || unit.records.get(kind).has(String(item.id))) return;
      unit.records.get(kind).set(String(item.id), item);
      const dependency = (library, id) => add(library, indexes.get(library).get(String(id || '')));
      if (item.folderId) dependency('collections', item.folderId);
      if (kind === 'artworks') {
        dependency('recipes', item.recipeId);
        artworkCharacterIds(item).forEach(id => dependency('characters', id));
        for (const source of Array.isArray(item.wordSources) ? item.wordSources : []) if (source) dependency('words', source.wordId);
        for (const id of Array.isArray(item.exampleWordIds) ? item.exampleWordIds : []) dependency('words', id);
      }
      const references = kind === 'recipes' ? item.defaultParams?.vibes : kind === 'artworks' ? item.vibes : kind === 'vibeRecords' && item.type === 'bundle' ? item.items : [];
      for (const reference of Array.isArray(references) ? references : []) dependency('vibeRecords', reference.id);
    };
    add(type, record);
    const extraBytes = () => BACKUP_ARRAYS.reduce((total, library) => total + [...unit.records.get(library).values()].filter(item => !current.records.get(library).has(String(item.id))).reduce((sum, item) => sum + size(library, item), 0), 0);
    let extra = extraBytes();
    // shortcut: keep one image and its dependencies intact; split binary records if a single group exceeds phone memory.
    if (current.bytes > 2048 && current.bytes + extra > targetBytes) {
      volumes.push(current); current = empty(); extra = extraBytes();
    }
    for (const library of BACKUP_ARRAYS) for (const item of unit.records.get(library).values()) {
      current.records.get(library).set(String(item.id), item);
      covered.add(key(library, item));
    }
    current.bytes += extra;
  }
  if (current.bytes > 2048 || !volumes.length) volumes.push(current);
  return volumes;
}

async function exportBackupRecord(type, record, state) {
  if (type !== 'artworks') return record;
  const stored = await dbGet('artworks', record.id);
  if (!stored || !(stored.blob instanceof Blob)) throw new Error('图片已不存在或无法读取，请重新开始备份');
  if (stored.updatedAt !== record.updatedAt) throw new Error('备份期间图片被修改，请重新开始备份');
  const artwork = { ...withTransferId(stored, 'artwork', state.sourceDeviceId), contentHash: stored.contentHash || await blobFingerprint(stored.blob) };
  if (!stored.transferId || !stored.contentHash) {
    const updated = await changeGalleryArtworks([record.id], current => {
      if (current.updatedAt !== record.updatedAt) throw new Error('备份期间图片被修改，请重新开始备份');
      return { transferId: artwork.transferId, contentHash: artwork.contentHash };
    }, { touch: false });
    if (!updated.length) throw new Error('备份期间图片被删除，请重新开始备份');
  }
  const { blob, ...exported } = artwork;
  if (Array.isArray(exported.wordSources)) exported.wordSources = exported.wordSources.filter(Boolean).map(source => {
    const word = state.wordIndex.get(String(source.wordId));
    return word ? { ...source, author: word.author || '', sourceUrl: word.sourceUrl || '', name: word.name || '' } : source;
  });
  if (!state.types.has('recipes')) exported.recipeId = '';
  if (!state.types.has('words')) exported.exampleWordIds = [];
  if (!state.types.has('characters')) { exported.characterId = ''; exported.characterIds = []; }
  return { ...exported, blob: await blobToDataURL(blob) };
}

async function serializeBackupVolume(state, volume, ensureActive) {
  const header = {
    app: 'NAI 镜头台', version: 9, exportedAt: state.exportedAt, scope: state.scope,
    includedTypes: BACKUP_DATA_TYPES.filter(type => state.types.has(type)),
    backupSet: { id: state.id, index: state.index + 1, total: state.volumes.length }
  };
  const pieces = [JSON.stringify(header).slice(0, -1)];
  let completed = 0;
  const total = BACKUP_ARRAYS.reduce((count, type) => count + volume.records.get(type).size, 0);
  for (const type of BACKUP_ARRAYS) {
    pieces.push(`,"${type}":[`);
    let first = true;
    for (const record of volume.records.get(type).values()) {
      ensureActive();
      if (!first) pieces.push(',');
      first = false;
      pieces.push(new Blob([JSON.stringify(await exportBackupRecord(type, record, state))]));
      ensureActive();
      $('backupSummary').textContent = `正在准备第 ${state.index + 1}/${state.volumes.length} 份：${++completed}/${total} 项。请保持页面打开。`;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    pieces.push(']');
  }
  pieces.push('}');
  return new Blob(pieces, { type: 'application/json' });
}

function resetBackupExport() {
  backupExportRevision++;
  pendingBackupExport = null;
  $('backupForm').querySelectorAll('input').forEach(input => { input.disabled = false; });
  $('backupSubmitBtn').innerHTML = `${icon('download')}下载备份`;
  $('backupSubmitBtn').disabled = backupExportBusy;
}

$('backupDialog').addEventListener('close', () => { if (!$('backupDialog').open) resetBackupExport(); });
$('backupForm').onsubmit = async event => {
  event.preventDefault();
  if (backupExportBusy) return;
  backupExportBusy = true;
  const revision = backupExportRevision;
  const ensureActive = () => {
    if (revision !== backupExportRevision || !$('backupDialog').open) throw new DOMException('备份已取消', 'AbortError');
  };
  const button = $('backupSubmitBtn'); button.disabled = true; button.textContent = '正在准备…';
  $('backupForm').querySelectorAll('input').forEach(input => { input.disabled = true; });
  try {
    if (!pendingBackupExport) {
      $('backupSummary').textContent = '正在读取备份范围，图片将逐份处理…';
      const scope = document.querySelector('[name="backupScope"]:checked')?.value || 'all';
      const startDate = $('backupStartDate').value, endDate = $('backupEndDate').value, types = selectedBackupTypes();
      const selected = await backupSelection(scope, startDate, endDate, types, true);
      ensureActive();
      const sourceDeviceId = deviceId();
      await prepareBackupIdentities(selected, sourceDeviceId);
      ensureActive();
      const typeLabel = types.size === BACKUP_DATA_TYPES.length ? '全部内容' : BACKUP_DATA_TYPES.filter(type => types.has(type)).map(type => BACKUP_TYPE_LABELS[type]).join('+');
      const rangeLabel = scope === 'range' ? `${startDate}至${endDate}` : `全部_${localDateString()}`;
      pendingBackupExport = {
        id: makeId(), index: 0, sourceDeviceId, types, exportedAt: new Date().toISOString(),
        scope: scope === 'range' ? { type: 'range', startDate, endDate } : { type: 'all' },
        wordIndex: new Map(currentWordSourceIndex().map(entry => [String(entry.word.id), entry.word])),
        filename: `NAI镜头台备份_${typeLabel}_${rangeLabel}`, volumes: planBackupVolumes(selected)
      };
    }
    const state = pendingBackupExport, volume = state.volumes[state.index];
    if (state.downloadUrl) { URL.revokeObjectURL(state.downloadUrl); state.downloadUrl = ''; }
    const blob = await serializeBackupVolume(state, volume, ensureActive);
    ensureActive();
    const suffix = state.volumes.length > 1 ? `_第${state.index + 1}份_共${state.volumes.length}份` : '';
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${state.filename}${suffix}.json`; anchor.click();
    state.downloadUrl = url;
    // Browsers do not report download completion; keep the URL briefly for mobile saves.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    state.index++;
    if (state.index === state.volumes.length) {
      closeDialog('backupDialog');
      toast(`已发起 ${state.volumes.length} 份备份下载，请确认文件均已保存。恢复时可逐份导入。`);
    } else {
      button.textContent = `下载下一份（${state.index + 1}/${state.volumes.length}）`;
      $('backupSummary').textContent = `已发起第 ${state.index}/${state.volumes.length} 份下载。确认文件已保存后，再下载下一份；恢复时逐份导入。${volume.bytes > BACKUP_PART_BYTES ? '本份含较大的单项素材，文件可能超过 300 MB。' : ''}`;
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      $('backupSummary').textContent = `备份失败：${error.message}。已下载的文件仍可恢复，原资料保留。`;
      button.textContent = pendingBackupExport ? `重试第 ${pendingBackupExport.index + 1} 份` : '重试备份';
      if (!pendingBackupExport) $('backupForm').querySelectorAll('input').forEach(input => { input.disabled = false; });
    }
  } finally {
    backupExportBusy = false;
    button.disabled = !selectedBackupTypes().size;
    if (!$('backupDialog').open) resetBackupExport();
  }
};
