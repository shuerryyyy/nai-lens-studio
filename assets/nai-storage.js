'use strict';
/* IndexedDB transactions and local record normalization. Shared state is initialized before boot. */

const DB_NAME = 'nai_shot_studio';
const DB_VERSION = 5;

let db;
function normalizeLibraryRecord(record, type, strict = false) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('备份中存在无效记录');
  const result = { ...record };
  result.id = String(record.id ?? makeId());
  for (const key of ['folderId', 'name', 'content', 'fullPrompt', 'artistPrompt', 'positivePrompt', 'negativePrompt', 'scenePrompt', 'clothingPrompt', 'characterPrompt', 'sourcePrompt', 'title', 'category', 'note', 'author', 'sourceUrl', 'transferId', 'recipeId', 'characterId', 'model', 'size', 'sampler', 'noiseSchedule', 'gender', 'hair', 'eyes', 'skin', 'body', 'features', 'outfit', 'naturalAppearance']) {
    if (key in result && typeof result[key] !== 'string') result[key] = String(result[key] ?? '');
  }
  result.tags = Array.isArray(record.tags) ? record.tags.filter(tag => typeof tag === 'string') : splitTags(record.tags);
  if (Array.isArray(record.characterIds)) result.characterIds = record.characterIds.map(String);
  if (Array.isArray(record.exampleWordIds)) result.exampleWordIds = record.exampleWordIds.map(String);
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
    if (!Array.isArray(list)) throw new Error('资料格式错误');
    return list.map(item => normalizeLibraryRecord(item, type));
  } catch {
    const message = `${type === 'word' ? '散词库' : '人物库'}读取失败，原始资料已保留；请勿清理网站数据，联系维护者协助恢复`;
    toast(message);
    throw new Error(message);
  }
}

function writeLocalLibrary(key, type, list) {
  readLocalLibrary(key, type);
  localStorage.setItem(key, JSON.stringify(list));
}

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

let storeArtworkAsBytes = false;
async function withArtworkStorage(operation) {
  const beganWithBytes = storeArtworkAsBytes;
  try { return await operation(); }
  catch (error) {
    if (beganWithBytes || !/Error preparing Blob\/File data to be stored in object store/i.test(error.message)) throw error;
    storeArtworkAsBytes = true;
    return operation();
  }
}

async function artworkForStorage(record) {
  // Only use bytes when this browser session has rejected Blob/File storage.
  if (!storeArtworkAsBytes || !(record.blob instanceof Blob)) return record;
  return { ...record, blob: { bytes: await record.blob.arrayBuffer(), type: record.blob.type } };
}

function artworkFromStorage(record) {
  if (!(record?.blob?.bytes instanceof ArrayBuffer)) return record;
  return { ...record, blob: new Blob([record.blob.bytes], { type: record.blob.type }) };
}

const dbAdd = (store, value) => withArtworkStorage(async () => {
  const record = store === 'artworks' ? await artworkForStorage(value) : value;
  return storeRequest(store, 'readwrite', objectStore => objectStore.add(record));
});
const dbPut = (store, value) => withArtworkStorage(async () => {
  const record = store === 'artworks' ? await artworkForStorage(value) : value;
  return storeRequest(store, 'readwrite', objectStore => objectStore.put(record));
});
const dbDelete = (store, id) => storeRequest(store, 'readwrite', objectStore => objectStore.delete(id));
const dbClear = store => storeRequest(store, 'readwrite', objectStore => objectStore.clear());
const dbGet = (store, id) => storeRequest(store, 'readonly', objectStore => objectStore.get(id)).then(record => store === 'artworks' ? artworkFromStorage(record) : record);
const dbAll = store => storeRequest(store, 'readonly', objectStore => objectStore.getAll()).then(records => store === 'artworks' ? records.map(artworkFromStorage) : records);

function writeGallery(operation) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['artworks', 'recipes'], 'readwrite');
    let result, failure;
    const run = callback => {
      try { callback(); } catch (error) { failure = error; tx.abort(); }
    };
    const onResult = (request, callback) => {
      request.onsuccess = () => run(() => callback(request.result));
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure || tx.error || new Error('图库写入失败，本次修改已撤销'));
    run(() => operation(tx.objectStore('artworks'), tx.objectStore('recipes'), onResult, value => { result = value; }));
  });
}

async function archiveGeneratedArtwork(artwork) {
  return withArtworkStorage(async () => {
    const stored = await artworkForStorage(artwork);
    return writeGallery((artworks, recipes, onResult, finish) => {
      const save = recipe => {
        const association = { recipeId: recipe?.id || '', category: recipe?.name || '未分类' };
        onResult(artworks.add({ ...stored, ...association }), id => {
          if (recipe) {
            const now = Date.now();
            recipes.put({ ...recipe, coverArtworkId: recipe.coverArtworkId || id, lastUsedAt: now, updatedAt: now });
          }
          finish({ id, ...association });
        });
      };
      if (artwork.recipeId) onResult(recipes.get(artwork.recipeId), save);
      else save(null);
    });
  });
}

async function legacyArtworkBytes(ids) {
  // Existing image bytes are immutable. Read legacy Blobs before opening the write transaction.
  const fallbackBlobs = new Map();
  for (const id of ids) {
    const record = await storeRequest('artworks', 'readonly', store => store.get(id));
    if (record?.blob instanceof Blob) fallbackBlobs.set(id, (await artworkForStorage(record)).blob);
  }
  return fallbackBlobs;
}

function changeGalleryArtworks(ids, change, { remove = false, targetRecipeId, touch = true } = {}) {
  return withArtworkStorage(async () => {
    const fallbackBlobs = storeArtworkAsBytes && !remove ? await legacyArtworkBytes(ids) : null;
    return writeGallery((artworks, recipes, onResult, finish) => {
      const now = Date.now(), updated = [], clearCovers = new Set();
      const moving = targetRecipeId !== undefined;
      const apply = owners => {
        const target = moving && targetRecipeId ? owners.find(recipe => recipe.id === targetRecipeId) : null;
        if (moving && targetRecipeId && !target) throw new Error('目标配方已不存在');
        let remaining = ids.length;
        const complete = () => {
          for (const recipe of owners) {
            let cover = clearCovers.has(recipe.coverArtworkId) ? null : recipe.coverArtworkId;
            if (recipe === target && !cover && updated.length) cover = updated[0].id;
            if (cover !== recipe.coverArtworkId) recipes.put({ ...recipe, coverArtworkId: cover, updatedAt: now });
          }
          finish(updated);
        };
        if (!remaining) complete();
        for (const id of ids) onResult(artworks.get(id), record => {
          if (record) {
            if (remove) {
              artworks.delete(id);
              clearCovers.add(id);
              updated.push(record);
            } else {
              const patch = moving ? { recipeId: targetRecipeId, category: target?.name || '未分类' } : change(record);
              if (moving && record.recipeId !== targetRecipeId) clearCovers.add(id);
              const next = { ...record, ...patch };
              if (next.blob instanceof Blob && fallbackBlobs?.has(id)) next.blob = fallbackBlobs.get(id);
              if (touch) next.updatedAt = now;
              artworks.put(next);
              updated.push(next);
            }
          }
          if (!--remaining) complete();
        });
      };
      if (remove || moving) onResult(recipes.getAll(), apply);
      else apply([]);
    });
  }).then(records => records.map(artworkFromStorage));
}

function deleteGalleryRecipe(recipeId) {
  return withArtworkStorage(async () => {
    const fallbackBlobs = storeArtworkAsBytes
      ? await legacyArtworkBytes((await backupArtworkMetadata()).filter(item => item.recipeId === recipeId).map(item => item.id))
      : null;
    return writeGallery((artworks, recipes, onResult) => {
      recipes.delete(recipeId);
      onResult(artworks.openCursor(), cursor => {
        if (!cursor) return;
        const artwork = cursor.value;
        if (artwork.recipeId === recipeId) {
          const blob = artwork.blob instanceof Blob ? fallbackBlobs?.get(artwork.id) || artwork.blob : artwork.blob;
          cursor.update({ ...artwork, blob, recipeId: '', category: '未分类', updatedAt: Date.now() });
        }
        cursor.continue();
      });
    });
  });
}

function backupArtworkMetadata() {
  return new Promise((resolve, reject) => {
    const records = [], tx = db.transaction('artworks', 'readonly');
    const request = tx.objectStore('artworks').openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const { blob, ...record } = cursor.value;
      records.push({ ...record, _backupBlobSize: blob?.size ?? blob?.bytes?.byteLength ?? 0 });
      cursor.continue();
    };
    tx.oncomplete = () => resolve(records);
    tx.onabort = tx.onerror = () => reject(tx.error || request.error || new Error('读取图片资料失败'));
  });
}

// Commit related records together; caches are refreshed only after success.
async function commitRecords(writes = {}, removals = {}) {
  return withArtworkStorage(async () => {
  if (writes.artworks) writes = { ...writes, artworks: await Promise.all(writes.artworks.map(artworkForStorage)) };
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
  });
}
