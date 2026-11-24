'use strict';
/* Image import preview and atomic archive controller. */

function resetImageImport() {
  if (importPreviewUrl) URL.revokeObjectURL(importPreviewUrl);
  importPreviewUrl = '';
  pendingImport = null;
  $('importPreview').removeAttribute('src');
}

async function beginImageImport(file, targetRecipeId = '', targetWordId = '') {
  resetImageImport();
  const filename = file.name.replace(/\.(png|webp|jpe?g)$/i, '');
  const importing = { file, targetWordId, filename, metadata: null, validImage: false };
  pendingImport = importing;
  $('saveRecipeBtn').disabled = true;
  fillRecipeEditor({ name: filename });
  importPreviewUrl = URL.createObjectURL(file);
  $('importPreview').src = importPreviewUrl;
  $('importStatus').textContent = '正在读取图片的生成信息……';
  $('importRawPrompt').value = '';
  $('importRawMeta').textContent = '';
  $('importRawDetails').querySelector('details').open = false;
  $('importImageSize').value = '';
  $('importImageSeed').value = '';
  $('importRecipeMode').value = targetRecipeId ? 'existing' : targetWordId ? 'none' : 'new';
  $('importRecipeSelect').value = targetRecipeId || recipesCache[0]?.id || '';
  updateImportMode();
  showDialog('recipeDialog');
  $('recipeDialog').scrollTop = 0;
  try {
    const image = await readImageMetadata(file);
    if (pendingImport !== importing || !$('recipeDialog').open) return;
    const metadata = extractNovelAIMetadata(image);
    importing.metadata = metadata;
    importing.validImage = true;
    const artistName = metadata.artistPrompt.replace(/[{}[\]]/g, '').slice(0, 36);
    fillRecipeEditor({ ...metadata, name: artistName || filename, defaultParams: pickParams(metadata) });
    $('importImageSize').value = metadata.size || '';
    $('importImageSeed').value = metadata.seed || '';
    $('importRawPrompt').value = metadata.rawPrompt;
    $('importRawMeta').textContent = JSON.stringify(metadata.raw, null, 2);
    $('importStatus').textContent = metadata.rawPrompt || metadata.negativePrompt
      ? '已填入图片中的提示词与生成参数，保存前可以修改。'
      : '图片中没有可识别的 NovelAI 提示词，可能经过截图或平台转码；仍可手动填写并归档。';
    if (metadata.splitWarning) $('importStatus').textContent += ` ${metadata.splitWarning}`;
    if (image.text.ReadWarning) $('importStatus').textContent += ` ${image.text.ReadWarning}。`;
  } catch (error) {
    try { await validateGeneratedImage(file); importing.validImage = true; } catch {}
    if (pendingImport !== importing || !$('recipeDialog').open) return;
    $('importStatus').textContent = importing.validImage
      ? `解析失败：${error.message}。仍可手动填写配方后保存图片。`
      : '无法解码图片，请选择有效的 PNG、JPEG 或 WebP 文件。';
  } finally {
    if (pendingImport === importing && $('recipeDialog').open) {
      updateImportMode();
      $('saveRecipeBtn').disabled = !importing.validImage;
    }
  }
}

function updateImportMode() {
  const mode = pendingImport ? $('importRecipeMode').value : '';
  const showRecipeFields = !mode || mode === 'new';
  $('recipeImport').hidden = !mode;
  $('recipeEditorBody').hidden = Boolean(pendingImport && !pendingImport.validImage);
  $('importExistingWrap').hidden = mode !== 'existing';
  $('recipeNameWrap').hidden = $('recipeOptions').hidden = !showRecipeFields;
  $('recipeName').disabled = !showRecipeFields;
  $('recipeOptions').querySelectorAll('input, select, textarea').forEach(input => { input.disabled = !showRecipeFields; });
  $('importImageSizeWrap').hidden = !$('importImageSize').value;
  $('importImageSeedWrap').hidden = !$('importImageSeed').value;
  $('importImageParams').hidden = !mode || ($('importImageSizeWrap').hidden && $('importImageSeedWrap').hidden);
  $('importRawDetails').hidden = !mode;
  document.querySelectorAll('[data-import-copy]').forEach(button => { button.hidden = !mode; });
  document.querySelectorAll('[data-recipe-pick]').forEach(button => { button.hidden = !showRecipeFields; });
  if (mode) $('recipeDialogTitle').textContent = mode === 'new' ? '从图片新建配方' : '解析 NovelAI 图片';
  $('saveRecipeBtn').textContent = !mode ? '保存配方' : mode === 'new' ? '保存图片与配方' : '保存图片';
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

async function saveImageImport(importing) {
  if (!importing.validImage) return;
  const submit = $('saveRecipeBtn');
  submit.disabled = true;
  let saved = false;
  try {
  if (importing.targetWordId && !words().some(word => word.id === importing.targetWordId)) throw new Error('词条已不存在，请重新选择例图归属');
  const mode = $('importRecipeMode').value;
  let recipeId = '';
  let recipe = null;
  if (mode === 'new') {
    if (!$('recipeName').value.trim()) { toast('请填写新配方名称'); return; }
    recipe = { ...readRecipeEditor(null, pickParams(importing.metadata || {})), source: 'png-import' };
    recipeId = recipe.id;
  } else if (mode === 'existing') {
    recipeId = $('importRecipeSelect').value;
    recipe = recipesCache.find(item => item.id === recipeId) || null;
    if (!recipe) { toast('请先选择一份已有配方'); return; }
  }
  const metadata = importing.metadata || {};
  const captions = imageCharacterCaptions(metadata.raw?.parsed);
  const artwork = {
    title: importing.filename,
    scenePrompt: '', sourcePrompt: metadata.rawPrompt || '',
    characterPrompt: captions.positive.map(item => item.char_caption).filter(Boolean).join(', '),
    artistPrompt: $('recipeArtist').value.trim(), positivePrompt: $('recipePositive').value.trim(),
    negativePrompt: $('recipeNegative').value.trim(), fullPrompt: metadata.rawPrompt || '',
    model: metadata.model || '', size: metadata.size || '', steps: metadata.steps ?? '',
    scale: metadata.scale ?? '', seed: metadata.seed || '', sampler: metadata.sampler || '',
    noiseSchedule: metadata.noiseSchedule || '', recipeId,
    varietyPlus: metadata.varietyPlus,
    category: recipe?.name || '未分类', tags: [], blob: importing.file,
    imported: true, importedAt: Date.now(), createdAt: Date.now(), rawMetadata: metadata.raw || {},
    ...(importing.targetWordId ? { exampleWordIds: [importing.targetWordId] } : {})
  };
  await withArtworkStorage(async () => {
    const storedArtwork = await artworkForStorage(artwork);
    await writeGallery((artworks, recipes, onResult) => {
      onResult(artworks.add(storedArtwork), id => {
        if (!recipe) return;
        if (mode === 'new') { recipes.add({ ...recipe, coverArtworkId: id }); return; }
        onResult(recipes.get(recipeId), existing => {
          if (!existing) throw new Error('配方已被删除，请重新选择');
          if (!existing.coverArtworkId) recipes.put({ ...existing, coverArtworkId: id, updatedAt: Date.now() });
        });
      });
    });
  });
  saved = true;
  if (pendingImport === importing) {
    closeDialog('recipeDialog');
    resetImageImport();
  }
  await refreshData();
  if (importing.targetWordId) { expandedWordId = importing.targetWordId; switchView('words'); }
  else { if (recipeId) inspectRecipe(recipesCache.find(item => item.id === recipeId)); switchView('gallery'); }
  toast(importing.targetWordId ? '例图已保存到词条' : recipeId ? '图片与配方已归档' : '图片已保存，未关联配方');
  } catch (error) { toast(saved ? '图片已保存，但列表刷新未完成：' + error.message + '；请刷新查看。' : '导入失败：' + error.message + '；文件与表单已保留。'); }
  finally { if (pendingImport === importing || !$('recipeDialog').open) submit.disabled = false; }
}
