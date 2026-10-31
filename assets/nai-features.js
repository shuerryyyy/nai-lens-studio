'use strict';
/* Library organization and metadata compatibility; no service credentials live here. */
const COLLECTION_TYPES = ['recipes', 'artworks', 'words', 'characters'];
let collectionsCache = [];
const collectionOrderSaving = new Set();
let cancelFolderDrag = null;

function normalizeCollection(item) {
  if (!item || !COLLECTION_TYPES.includes(item.libraryType) || typeof item.name !== 'string' || !item.name.trim()) throw new Error('备份中的文件夹资料无效');
  return { id: String(item.id || makeId()), libraryType: item.libraryType, name: item.name.trim().slice(0, 200), createdAt: Number(item.createdAt) || Date.now(), updatedAt: Number(item.updatedAt) || Date.now(), ...(Number.isSafeInteger(item.manualOrder) ? { manualOrder: item.manualOrder } : {}), ...(typeof item.transferId === 'string' ? { transferId: item.transferId } : {}) };
}
async function refreshCollections() { collectionsCache = (await dbAll('collections')).map(normalizeCollection); }
function orderedCollections(type) {
  return collectionsCache.filter(item => item.libraryType === type)
    .map((item, index) => ({ item, rank: item.manualOrder ?? index, index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index).map(entry => entry.item);
}
function renderCollectionLibrary(type) {
  ({ recipes: renderRecipes, artworks: renderImageLibrary, words: renderWords, characters: renderCharacters })[type]();
}
async function createCollection(type, name) {
  name = String(name || '').trim().slice(0, 200);
  if (!name) throw new Error('请填写文件夹名称');
  if (collectionsCache.some(item => item.libraryType === type && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('这个资料库已有同名文件夹');
  const folders = orderedCollections(type);
  const manualOrder = Math.max(-1, ...folders.map((item, index) => item.manualOrder ?? index)) + 1;
  const record = normalizeCollection({ id: makeId(), libraryType: type, name, manualOrder });
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
      writeLocalLibrary(localKey, type === 'words' ? 'word' : 'character', records.map(item => updates.get(item.id) || item));
    }
    await withArtworkStorage(async () => {
    const stored = type === 'artworks' ? await Promise.all(changed.map(artworkForStorage)) : changed;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(localKey ? ['collections'] : ['collections', type], 'readwrite');
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || new Error('文件夹删除失败，内容已保留'));
      tx.onerror = () => {};
      try {
        if (!localKey) for (const item of stored) tx.objectStore(type).put(item);
        tx.objectStore('collections').delete(folderId);
      } catch (error) { tx.abort(); reject(error); }
    });
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
// Store only order changes, using fresh records in one transaction so renames and
// other libraries cannot be overwritten by a stale drag snapshot.
async function saveCollectionOrder(type, ids) {
  if (collectionOrderSaving.has(type)) return;
  collectionOrderSaving.add(type);
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('collections', 'readwrite'), store = tx.objectStore('collections');
      let failure;
      tx.oncomplete = resolve;
      tx.onabort = () => reject(failure || tx.error || new Error('排序保存失败，原顺序已保留'));
      tx.onerror = () => {};
      const request = store.getAll();
      request.onsuccess = () => {
        try {
          const folders = request.result.filter(item => item.libraryType === type);
          if (ids.length !== folders.length || new Set(ids).size !== ids.length || folders.some(item => !ids.includes(item.id))) throw new Error('文件夹已变化，请重新排序');
          const order = new Map(ids.map((id, index) => [id, index]));
          for (const folder of folders) store.put({ ...folder, manualOrder: order.get(folder.id), updatedAt: Date.now() });
        } catch (error) { failure = error; tx.abort(); }
      };
    });
    if ($('collectionOrderStatus')) $('collectionOrderStatus').textContent = '文件夹顺序已保存';
  } catch (error) { toast(error.message); }
  finally {
    collectionOrderSaving.delete(type);
    try { await refreshCollections(); renderCollectionLibrary(type); }
    catch (error) { toast('无法刷新文件夹：' + error.message); }
  }
}
function bindCollectionSort(handle, section, host, type) {
  const groups = () => [...host.children].filter(node => node.dataset.folderId);
  const ids = () => groups().map(node => node.dataset.folderId);
  const restoreFocus = () => [...host.querySelectorAll('[data-folder-sort]')].find(node => node.dataset.folderSort === section.dataset.folderId)?.focus({ preventScroll: true });
  handle.onkeydown = async event => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (collectionOrderSaving.has(type) || cancelFolderDrag) return;
    const nodes = groups(), index = nodes.indexOf(section);
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? nodes.length - 1 : index + (event.key === 'ArrowUp' ? -1 : 1);
    if (target < 0 || target >= nodes.length || target === index) return;
    nodes.splice(index, 1); nodes.splice(target, 0, section);
    await saveCollectionOrder(type, nodes.map(node => node.dataset.folderId)); restoreFocus();
  };
  handle.onpointerdown = event => {
    if (!event.isPrimary || event.button !== 0 || collectionOrderSaving.has(type)) return;
    cancelFolderDrag?.();
    const before = ids(), pointerId = event.pointerId, startY = event.clientY;
    let dragging = false, lastY = startY, frame = 0;
    const reorderAt = y => {
      const next = groups().filter(node => node !== section).find(node => {
        const rect = node.querySelector('.folder-heading').getBoundingClientRect();
        return y < rect.top + rect.height / 2;
      });
      const anchor = next || [...host.children].find(node => node.dataset.folderId === '') || null;
      if (section.nextElementSibling !== anchor) { host.insertBefore(section, anchor); handle.setPointerCapture(pointerId); }
    };
    const scroll = () => {
      if (!dragging) return;
      const delta = lastY < 64 ? -12 : lastY > innerHeight - 80 ? 12 : 0;
      if (delta) { window.scrollBy(0, delta); reorderAt(lastY); }
      frame = requestAnimationFrame(scroll);
    };
    const move = e => {
      if (e.pointerId !== pointerId) return;
      if (!section.isConnected) { finish(false); return; }
      lastY = e.clientY;
      if (!dragging && Math.abs(lastY - startY) < 6) return;
      e.preventDefault();
      if (!dragging) { dragging = true; section.classList.add('folder-dragging'); handle.setAttribute('aria-pressed', 'true'); frame = requestAnimationFrame(scroll); }
      reorderAt(lastY);
    };
    const finish = commit => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel); window.removeEventListener('keydown', key);
      cancelFolderDrag = null;
      section.classList.remove('folder-dragging'); handle.setAttribute('aria-pressed', 'false');
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      if (!dragging) return;
      const after = ids();
      if (commit && JSON.stringify(after) !== JSON.stringify(before)) saveCollectionOrder(type, after).then(restoreFocus).catch(error => toast(error.message));
      else if (!commit) {
        const anchor = [...host.children].find(node => node.dataset.folderId === '') || null;
        for (const id of before) { const node = groups().find(node => node.dataset.folderId === id); if (node) host.insertBefore(node, anchor); }
      }
    };
    const up = e => { if (e.pointerId === pointerId) finish(true); };
    const cancel = () => finish(false);
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
    cancelFolderDrag = cancel;
    handle.setPointerCapture(pointerId);
    window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel); window.addEventListener('blur', cancel); window.addEventListener('keydown', key);
  };
}
function groupRenderedLibrary(type, list, host, selector) {
  if (type === 'recipes') cancelFolderDrag?.();
  const folders = orderedCollections(type);
  host.classList.toggle('folder-mode', folders.length > 0);
  if (!folders.length) return;
  const nodes = [...host.querySelectorAll(`:scope > ${selector}`)];
  const entries = list.map((record, index) => ({ record, node: nodes[index] })).filter(entry => entry.node);
  host.replaceChildren();
  const validIds = new Set(folders.map(item => item.id));
  const groups = [...folders.map(folder => ({ folder, entries: entries.filter(item => item.record.folderId === folder.id) })), { folder: { id: '', name: '未归入文件夹' }, entries: entries.filter(item => !validIds.has(item.record.folderId)) }];
  for (const { folder, entries: grouped } of groups) {
    if (!folder.id && !grouped.length) continue;
    const section = document.createElement('section'); section.className = 'folder-group'; section.dataset.folderId = folder.id;
    const header = document.createElement('div'); header.className = 'folder-heading';
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'folder-toggle';
    toggle.innerHTML = `${icon('chevron-right')}${icon('folder')}<span>${escapeHTML(folder.name)}</span><small>${grouped.length}</small>`;
    const body = document.createElement('div'); body.className = `folder-items ${type === 'artworks' ? 'library-images' : type === 'recipes' ? 'recipe-grid' : type === 'words' ? 'word-list' : 'character-list'}`;
    body.id = `folder-${type}-${folder.id || 'unfiled'}`; toggle.setAttribute('aria-controls', body.id);
    const stateKey = `nai_folder_open_${type}_${folder.id || 'unfiled'}`;
    let open = localStorage.getItem(stateKey) !== 'false';
    const setOpen = () => { body.hidden = !open; toggle.setAttribute('aria-expanded', String(open)); };
    setOpen(); toggle.onclick = () => { open = !open; setOpen(); try { localStorage.setItem(stateKey, String(open)); } catch { toast('已切换展开状态，但浏览器未能记住设置'); } };
    if (type === 'recipes' && folder.id) {
      const handle = quietTool('grip-vertical', `拖动排序：${folder.name}；也可用上下方向键、Home 或 End 调整`);
      handle.classList.add('folder-sort-handle'); handle.dataset.folderSort = folder.id;
      handle.setAttribute('aria-pressed', 'false'); handle.disabled = folders.length < 2;
      bindCollectionSort(handle, section, host, type); header.append(handle);
    }
    header.append(toggle);
    if (folder.id) {
      const rename = quietTool('pencil', `重命名文件夹：${folder.name}`);
      rename.onclick = async () => {
        const input = prompt('文件夹名称', folder.name); if (input === null) return;
        const name = input.trim().slice(0, 200);
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
      writeLocalLibrary(type === 'characters' ? CHARACTERS_KEY : WORDS_KEY, type === 'characters' ? 'character' : 'word', list);
    } else if (type === 'recipes') {
      const record = await dbGet('recipes', String(id));
      if (!record) return;
      const lastUsedAt = Date.now();
      await dbPut('recipes', { ...record, lastUsedAt });
      const cached = recipesCache.find(item => item.id === record.id); if (cached) cached.lastUsedAt = lastUsedAt;
    }
  } catch { toast('已取用；最近使用记录未能保存'); }
}

/* Install shared UI controls before the final boot script starts the database. */
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
  const orderStatus = document.createElement('p'); orderStatus.id = 'collectionOrderStatus'; orderStatus.className = 'sr-only'; orderStatus.setAttribute('role', 'status'); document.body.append(orderStatus);
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
  if (remove) remove.onclick = () => deleteLibraryTag(galleryFacets.tag).catch(error => toast(error.message));
}
