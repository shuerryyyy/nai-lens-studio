'use strict';
/* Library organization and metadata compatibility; no service credentials live here. */
const COLLECTION_TYPES = ['recipes', 'artworks', 'words', 'characters'];
let collectionsCache = [];

function normalizeCollection(item) {
  if (!item || !COLLECTION_TYPES.includes(item.libraryType) || typeof item.name !== 'string' || !item.name.trim()) throw new Error('备份中的文件夹资料无效');
  return { id: String(item.id || makeId()), libraryType: item.libraryType, name: item.name.trim().slice(0, 200), createdAt: Number(item.createdAt) || Date.now(), updatedAt: Number(item.updatedAt) || Date.now(), ...(typeof item.transferId === 'string' ? { transferId: item.transferId } : {}) };
}
async function refreshCollections() { collectionsCache = (await dbAll('collections')).map(normalizeCollection); }
function renderCollectionLibrary(type) {
  ({ recipes: renderRecipes, artworks: renderImageLibrary, words: renderWords, characters: renderCharacters })[type]();
}
async function createCollection(type, name) {
  name = String(name || '').trim().slice(0, 200);
  if (!name) throw new Error('请填写文件夹名称');
  if (collectionsCache.some(item => item.libraryType === type && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('这个资料库已有同名文件夹');
  const record = normalizeCollection({ id: makeId(), libraryType: type, name });
  await dbPut('collections', record);
  await refreshCollections();
  renderCollectionLibrary(type);
  return record;
}
async function moveToCollection(type, recordId, folderId) {
  if (folderId && !collectionsCache.some(item => item.id === folderId && item.libraryType === type)) throw new Error('目标文件夹不存在');
  if (type === 'words' || type === 'characters') {
    const list = type === 'words' ? words() : characters();
    const record = list.find(item => String(item.id) === String(recordId));
    if (!record) throw new Error('这条资料已不存在');
    record.folderId = folderId;
    record.updatedAt = Date.now();
    (type === 'words' ? saveWords : saveCharacters)(list);
  } else {
    const record = await dbGet(type, type === 'artworks' ? Number(recordId) : String(recordId));
    if (!record) throw new Error('这条资料已不存在');
    await dbPut(type, { ...record, folderId, updatedAt: Date.now() });
    await refreshData();
  }
}
async function removeCollection(folderId) {
  const folder = collectionsCache.find(item => item.id === folderId);
  if (!folder) return;
  const type = folder.libraryType;
  const localKey = type === 'words' ? WORDS_KEY : type === 'characters' ? CHARACTERS_KEY : '';
  const previous = localKey ? localStorage.getItem(localKey) : null;
  const records = localKey ? (type === 'words' ? words() : characters()) : await dbAll(type);
  const changed = records.filter(item => item.folderId === folderId).map(item => ({ ...item, folderId: '', updatedAt: Date.now() }));
  try {
    if (localKey) {
      const updates = new Map(changed.map(item => [item.id, item]));
      localStorage.setItem(localKey, JSON.stringify(records.map(item => updates.get(item.id) || item)));
    }
    await new Promise((resolve, reject) => {
      const tx = db.transaction(localKey ? ['collections'] : ['collections', type], 'readwrite');
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || new Error('文件夹删除失败，内容已保留'));
      tx.onerror = () => {};
      try {
        if (!localKey) for (const item of changed) tx.objectStore(type).put(item);
        tx.objectStore('collections').delete(folderId);
      } catch (error) { tx.abort(); reject(error); }
    });
  } catch (error) {
    if (localKey) previous === null ? localStorage.removeItem(localKey) : localStorage.setItem(localKey, previous);
    throw error;
  }
  await refreshCollections();
  if (!localKey) await refreshData();
  else renderCollectionLibrary(type);
}
function quietTool(name, label) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'icon-btn flat-tool';
  button.setAttribute('aria-label', label); button.dataset.flatTooltip = label;
  button.innerHTML = icon(name);
  return button;
}
function groupRenderedLibrary(type, list, host, selector) {
  const folders = collectionsCache.filter(item => item.libraryType === type);
  host.classList.toggle('folder-mode', folders.length > 0);
  if (!folders.length) return;
  const nodes = [...host.querySelectorAll(`:scope > ${selector}`)];
  const entries = list.map((record, index) => ({ record, node: nodes[index] })).filter(entry => entry.node);
  host.replaceChildren();
  const validIds = new Set(folders.map(item => item.id));
  const groups = [...folders.map(folder => ({ folder, entries: entries.filter(item => item.record.folderId === folder.id) })), { folder: { id: '', name: '未归入文件夹' }, entries: entries.filter(item => !validIds.has(item.record.folderId)) }];
  for (const { folder, entries: grouped } of groups) {
    if (!folder.id && !grouped.length) continue;
    const section = document.createElement('section'); section.className = 'folder-group';
    const header = document.createElement('div'); header.className = 'folder-heading';
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'folder-toggle';
    toggle.innerHTML = `${icon('chevron-right')}${icon('folder')}<span>${escapeHTML(folder.name)}</span><small>${grouped.length}</small>`;
    const body = document.createElement('div'); body.className = `folder-items ${type === 'artworks' ? 'library-images' : type === 'recipes' ? 'recipe-grid' : type === 'words' ? 'word-list' : 'character-list'}`;
    body.id = `folder-${type}-${folder.id || 'unfiled'}`; toggle.setAttribute('aria-controls', body.id);
    const stateKey = `nai_folder_open_${type}_${folder.id || 'unfiled'}`;
    let open = localStorage.getItem(stateKey) !== 'false';
    const setOpen = () => { body.hidden = !open; toggle.setAttribute('aria-expanded', String(open)); };
    setOpen(); toggle.onclick = () => { open = !open; localStorage.setItem(stateKey, String(open)); setOpen(); };
    header.append(toggle);
    if (folder.id) {
      const rename = quietTool('pencil', `重命名文件夹：${folder.name}`);
      rename.onclick = async () => {
        const name = prompt('文件夹名称', folder.name); if (name === null) return;
        try {
          if (!name.trim()) throw new Error('名称不能为空');
          if (folders.some(item => item.id !== folder.id && item.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase())) throw new Error('已有同名文件夹');
          await dbPut('collections', { ...folder, name: name.trim().slice(0, 200), updatedAt: Date.now() });
          await refreshCollections(); renderCollectionLibrary(type);
        } catch (error) { toast(error.message); }
      };
      const remove = quietTool('trash', `删除文件夹：${folder.name}`); remove.classList.add('danger-btn');
      remove.onclick = async () => {
        if (!confirm(`删除文件夹“${folder.name}”？其中的内容不会删除，将移回“未归入文件夹”。`)) return;
        try { await removeCollection(folder.id); toast('文件夹已删除，内容已保留'); } catch (error) { toast(error.message); }
      };
      header.append(rename, remove);
    }
    body.classList.toggle('single-row', type === 'artworks' && grouped.length > 0 && grouped.length <= 3);
    for (const { record, node } of grouped) {
      if (!record.virtual) {
        const move = quietTool('folder-input', '移动到文件夹');
        move.dataset.folderMove = String(record.id);
        move.onclick = () => openCollectionMove(type, record.id);
        if (type === 'words' || type === 'characters') node.querySelector(type === 'words' ? '.word-actions' : '.character-actions').append(move);
        else {
          const wrapper = document.createElement('div'); wrapper.className = 'folder-item'; wrapper.append(node, move); body.append(wrapper); continue;
        }
      }
      body.append(node);
    }
    if (!grouped.length) { const empty = document.createElement('p'); empty.className = 'folder-empty'; empty.textContent = '没有匹配的内容'; body.append(empty); }
    section.append(header, body); host.append(section);
  }
}
function openCollectionMove(type, recordId) {
  const record = (type === 'words' ? words() : type === 'characters' ? characters() : type === 'recipes' ? recipesCache : artworksCache).find(item => String(item.id) === String(recordId));
  const select = $('collectionMoveTarget');
  select.innerHTML = '<option value="">未归入文件夹</option>' + collectionsCache.filter(item => item.libraryType === type).map(item => `<option value="${escapeHTML(item.id)}">${escapeHTML(item.name)}</option>`).join('');
  select.value = record?.folderId || '';
  $('collectionMoveForm').onsubmit = async event => {
    event.preventDefault();
    try { await moveToCollection(type, recordId, select.value); closeDialog('collectionMoveDialog'); toast('已移动'); } catch (error) { toast(error.message); }
  };
  showDialog('collectionMoveDialog');
}
function pickerRecordInfo(record, libraryType) {
  return { recordId: record.id, libraryType, createdAt: Number(record.createdAt) || 0, updatedAt: Number(record.updatedAt) || 0, lastUsedAt: Number(record.lastUsedAt) || 0, manualOrder: Number(record.manualOrder) || 0 };
}
function sortPickerItems(items) {
  const mode = $('pickerSort').value;
  const byName = (a, b) => a.name.localeCompare(b.name, 'zh-CN') || String(a.id).localeCompare(String(b.id));
  const sorts = {
    favorite: (a, b) => Number(b.favorite) - Number(a.favorite) || byName(a, b),
    newest: (a, b) => b.createdAt - a.createdAt || byName(a, b),
    oldest: (a, b) => a.createdAt - b.createdAt || byName(a, b),
    name: byName,
    recent: (a, b) => b.lastUsedAt - a.lastUsedAt || byName(a, b),
    manual: (a, b) => a.manualOrder - b.manualOrder || byName(a, b)
  };
  return [...items].sort(sorts[mode] || sorts.favorite);
}
async function recordLibraryUse(type, id) {
  try {
    if (type === 'characters' || type === 'words') {
      const list = type === 'characters' ? characters() : words();
      const record = list.find(item => String(item.id) === String(id));
      if (!record) return;
      record.lastUsedAt = Date.now();
      localStorage.setItem(type === 'characters' ? CHARACTERS_KEY : WORDS_KEY, JSON.stringify(list));
    } else if (type === 'recipes') {
      const record = await dbGet('recipes', String(id));
      if (!record) return;
      const lastUsedAt = Date.now();
      await dbPut('recipes', { ...record, lastUsedAt });
      const cached = recipesCache.find(item => item.id === record.id); if (cached) cached.lastUsedAt = lastUsedAt;
    }
  } catch { toast('已取用；最近使用记录未能保存'); }
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

/* Install controls synchronously: the main program opens its database asynchronously. */
(() => {
  const modelField = document.createElement('div'); modelField.className = 'field';
  modelField.innerHTML = '<label for="recipeModel">适用模型</label><select id="recipeModel"><option value="">跟随创作台当前模型</option></select>';
  $('recipeSteps').closest('.row-2').before(modelField);
  for (const option of $('model').options) $('recipeModel').append(new Option(option.text, option.value));
  const pickerTools = document.createElement('div'); pickerTools.className = 'picker-tools';
  $('pickerDialog').querySelector('.picker-search').before(pickerTools);
  pickerTools.append($('pickerDialog').querySelector('.picker-search'));
  const sort = document.createElement('select'); sort.id = 'pickerSort'; sort.setAttribute('aria-label', '库内容排序');
  for (const [value, label] of [['favorite','收藏优先'],['newest','最新创建'],['oldest','最早创建'],['name','名称排序'],['recent','最近使用'],['manual','手动顺序']]) sort.append(new Option(label, value));
  sort.onchange = () => { localStorage.setItem(`nai_picker_sort_${pickerKind}`, sort.value); renderPickerList(); };
  pickerTools.append(sort);
  $('imageImportFile').accept = 'image/png,image/webp,image/jpeg,.png,.webp,.jpg,.jpeg';
})();
async function initWorkbenchFeatures() {
  const moveDialog = document.createElement('dialog'); moveDialog.id = 'collectionMoveDialog'; moveDialog.className = 'dialog compact-dialog';
  moveDialog.innerHTML = '<form class="dialog-inner" id="collectionMoveForm"><div class="dialog-head"><h2>移动到文件夹</h2><button class="icon-btn" type="button" data-close-dialog="collectionMoveDialog" aria-label="关闭">×</button></div><div class="field"><label for="collectionMoveTarget">目标文件夹</label><select id="collectionMoveTarget"></select></div><div class="dialog-actions"><button class="secondary" type="button" data-close-dialog="collectionMoveDialog">取消</button><button class="primary" type="submit">移动</button></div></form>';
  document.body.append(moveDialog);
  moveDialog.querySelectorAll('[data-close-dialog]').forEach(button => button.onclick = () => closeDialog(moveDialog.id));
  moveDialog.addEventListener('click', event => { if (event.target === moveDialog) closeDialog(moveDialog.id); });
  for (const [type, anchor] of [['recipes','gallerySearch'],['artworks','librarySelectBtn'],['words','wordSearch'],['characters','characterSearch']]) {
    const tool = quietTool('folder-plus', '新建文件夹'); tool.dataset.folderCreate = type;
    tool.onclick = async () => { const name = prompt('新文件夹名称'); if (name === null) return; try { await createCollection(type, name); toast('文件夹已创建'); } catch (error) { toast(error.message); } };
    if (type === 'artworks') $(anchor).before(tool); else $(anchor).closest('.tools').append(tool);
  }
  const panel = document.querySelector('.vibe-panel');
  const disclosure = document.createElement('details'); disclosure.className = 'vibe-panel vibe-disclosure'; disclosure.id = 'vibeDisclosure';
  disclosure.open = localStorage.getItem('nai_vibe_expanded') === 'true';
  disclosure.innerHTML = '<summary><span>Vibe 参考</span><small id="vibeSummaryCount">未选择</small></summary>';
  panel.firstElementChild.remove();
  const content = document.createElement('div'); content.className = 'vibe-disclosure-content';
  while (panel.firstChild) content.append(panel.firstChild);
  disclosure.append(content); panel.replaceWith(disclosure);
  disclosure.addEventListener('toggle', () => localStorage.setItem('nai_vibe_expanded', String(disclosure.open)));
  renderVibePanel();
  await refreshCollections(); renderWords(); renderCharacters();
}
// UI-only facets: recipe association, descriptive tags and storage folders stay separate.
const galleryFacets = { recipe: '', character: '', tag: '', model: '', favorite: false };
let galleryFiltersOpen = false;
function matchesGalleryFacets(item) {
  return (!galleryFacets.recipe || (galleryFacets.recipe === '__none__' ? !item.recipeId : String(item.recipeId) === galleryFacets.recipe))
    && (!galleryFacets.character || artworkCharacterNames(item).includes(galleryFacets.character))
    && (!galleryFacets.tag || (item.tags || []).includes(galleryFacets.tag))
    && (!galleryFacets.model || item.model === galleryFacets.model)
    && (!galleryFacets.favorite || Boolean(item.favorite));
}
function renderGalleryFacets(host) {
  const choices = {
    recipe: [['__none__', '未关联配方'], ...recipesCache.map(item => [String(item.id), item.name])],
    character: [...new Set(artworksCache.flatMap(artworkCharacterNames))].map(name => [name, name]),
    tag: [...new Set(artworksCache.flatMap(item => item.tags || []))].map(name => [name, name]),
    model: [...new Set(artworksCache.map(item => item.model).filter(Boolean))].map(name => [name, shortModel(name)])
  };
  const labels = { recipe: '配方', character: '人物', tag: '标签', model: '模型', favorite: '仅收藏' };
  for (const key of Object.keys(choices)) if (galleryFacets[key] && !choices[key].some(([value]) => value === galleryFacets[key])) galleryFacets[key] = '';
  const active = Object.keys(galleryFacets).filter(key => galleryFacets[key]);
  host.innerHTML = `<details class="gallery-facets" ${galleryFiltersOpen ? 'open' : ''}><summary>筛选图片${active.length ? ` · ${active.length} 项` : ''}</summary><div class="gallery-facet-fields">${Object.entries(choices).map(([key, values]) => `<label>${labels[key]}<select data-gallery-facet="${key}"><option value="">全部${labels[key]}</option>${values.map(([value, label]) => `<option value="${escapeHTML(value)}" ${galleryFacets[key] === value ? 'selected' : ''}>${escapeHTML(label)}</option>`).join('')}</select></label>`).join('')}<label class="gallery-favorite"><input type="checkbox" data-gallery-facet="favorite" ${galleryFacets.favorite ? 'checked' : ''}>仅收藏</label>${galleryFacets.tag ? '<button type="button" id="removeGalleryTag" class="danger-btn">从所有图片移除此标签</button>' : ''}</div></details><div class="gallery-active-filters" aria-label="当前筛选条件">${active.map(key => { const name = key === 'favorite' ? '仅收藏' : `${labels[key]}：${choices[key].find(([value]) => value === galleryFacets[key])?.[1] || galleryFacets[key]}`; return `<button class="secondary" type="button" data-clear-facet="${key}" aria-label="取消筛选：${escapeHTML(name)}">${escapeHTML(name)} ${icon('x')}</button>`; }).join('')}${active.length ? '<button type="button" class="secondary" id="clearGalleryFacets">清除筛选</button>' : '<span>全部图片</span>'}</div>`;
  host.querySelector('details').ontoggle = event => { galleryFiltersOpen = event.target.open; };
  host.querySelectorAll('[data-gallery-facet]').forEach(control => control.onchange = () => { galleryFiltersOpen = true; galleryFacets[control.dataset.galleryFacet] = control.type === 'checkbox' ? control.checked : control.value; renderImageLibrary(); });
  host.querySelectorAll('[data-clear-facet]').forEach(button => button.onclick = () => { const key = button.dataset.clearFacet; galleryFacets[key] = key === 'favorite' ? false : ''; renderImageLibrary(); });
  const clear = host.querySelector('#clearGalleryFacets');
  if (clear) clear.onclick = () => { Object.keys(galleryFacets).forEach(key => galleryFacets[key] = key === 'favorite' ? false : ''); renderImageLibrary(); };
  const remove = host.querySelector('#removeGalleryTag');
  if (remove) remove.onclick = () => deleteLibraryTag(galleryFacets.tag);
}
