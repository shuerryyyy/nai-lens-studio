'use strict';
/* Image import preview and atomic archive controller. */

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
  const submit = $('imageImportForm').querySelector('[type="submit"]');
  if (submit.disabled) return;
  submit.disabled = true;
  const importing = pendingImport;
  let saved = false;
  try {
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
      manualOrder: -Date.now(), defaultParams: pickParams(importing.metadata || {}), source: 'png-import'
    };
    recipeId = recipe.id;
  } else if (mode === 'existing') {
    recipeId = $('importRecipeSelect').value;
    recipe = recipesCache.find(item => item.id === recipeId) || null;
    if (!recipe) { toast('请先选择一份已有配方'); return; }
  }
  const metadata = importing.metadata || {};
  const artwork = {
    title: importing.file.name.replace(/\.(png|webp|jpe?g)$/i, ''),
    scenePrompt: metadata.rawPrompt || '', sourcePrompt: metadata.rawPrompt || '',
    artistPrompt: $('importArtist').value.trim(), positivePrompt: $('importPositive').value.trim(),
    negativePrompt: $('importNegative').value.trim(), fullPrompt: metadata.rawPrompt || '',
    model: metadata.model || 'unknown', size: metadata.size || '', steps: metadata.steps || '',
    scale: metadata.scale ?? '', seed: metadata.seed || '', sampler: metadata.sampler || '',
    noiseSchedule: metadata.noiseSchedule || '', recipeId,
    category: recipe?.name || '未分类', tags: [], blob: importing.file,
    imported: true, importedAt: Date.now(), createdAt: Date.now(), rawMetadata: metadata.raw || {}
  };
  await withArtworkStorage(async () => {
  const storedArtwork = await artworkForStorage(artwork);
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['artworks', 'recipes'], 'readwrite');
    let failure;
    tx.oncomplete = resolve; tx.onabort = () => reject(failure || tx.error || new Error('导入失败，本次图片与配方写入已撤销')); tx.onerror = () => {};
    try {
      const request = tx.objectStore('artworks').add(storedArtwork);
      request.onsuccess = () => {
        try {
          if (!recipe) return;
          const store = tx.objectStore('recipes');
          if (mode === 'new') store.add({ ...recipe, coverArtworkId: request.result });
          else {
            const existing = store.get(recipeId);
            existing.onsuccess = () => {
              try {
                if (!existing.result) throw new Error('配方已被删除，请重新选择');
                if (!existing.result.coverArtworkId) store.put({ ...existing.result, coverArtworkId: request.result, updatedAt: Date.now() });
              } catch (error) { failure = error; tx.abort(); }
            };
          }
        } catch (error) { failure = error; tx.abort(); }
      };
    } catch (error) { failure = error; tx.abort(); }
  });
  });
  saved = true;
  if (pendingImport === importing) { closeDialog('imageImportDialog'); pendingImport = null; }
  await refreshData();
  if (recipeId) inspectRecipe(recipesCache.find(item => item.id === recipeId));
  switchView('gallery');
  toast(recipeId ? '图片与配方已归档' : '图片已保存，未关联配方');
  } catch (error) { toast(saved ? '图片已保存，但列表刷新未完成：' + error.message + '；请刷新查看。' : '导入失败：' + error.message + '；文件与表单已保留。'); }
  finally { submit.disabled = false; }
};
