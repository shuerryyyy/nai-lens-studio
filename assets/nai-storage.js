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
