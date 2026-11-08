'use strict';
/* Two views share the existing word records, controls and image library. */

const WORD_FORMAT_KEY = 'nai_studio_word_format_v1';
let wordGalleryUrls = new Map();
let wordGalleryImages = new Map();
let wordGalleryArtworks = null, wordGallerySourceIndex = null;

function resetWordGalleryInspector() {
  const inspector = $('wordInspector');
  if (inspector.parentElement !== $('wordGalleryLayout')) $('wordGalleryLayout').append(inspector);
  inspector.hidden = true;
  inspector.replaceChildren();
}

function wordLibraryFormat() {
  try { return localStorage.getItem(WORD_FORMAT_KEY) === 'gallery' ? 'gallery' : 'list'; }
  catch { return 'list'; }
}

$('wordLibraryFormat').value = wordLibraryFormat();
$('wordLibraryFormat').onchange = () => {
  try { localStorage.setItem(WORD_FORMAT_KEY, $('wordLibraryFormat').value); }
  catch { $('wordLibraryFormat').value = wordLibraryFormat(); toast('无法保存散词库格式，请检查浏览器存储空间'); return; }
  renderWords();
};

function releaseWordGalleryUrls() {
  wordGalleryUrls.forEach(url => URL.revokeObjectURL(url));
  wordGalleryUrls.clear();
}

function wordGalleryUrl(blob) {
  if (!wordGalleryUrls.has(blob)) wordGalleryUrls.set(blob, URL.createObjectURL(blob));
  return wordGalleryUrls.get(blob);
}

function updateWordGalleryImages() {
  const index = currentWordSourceIndex();
  if (wordGalleryArtworks === artworksCache && wordGallerySourceIndex === index) return;
  if (wordGalleryArtworks !== artworksCache) releaseWordGalleryUrls();
  wordGalleryArtworks = artworksCache;
  wordGallerySourceIndex = index;
  wordGalleryImages = new Map(index.map(({ word }) => [String(word.id), []]));
  for (const image of artworksCache) {
    const sources = Array.isArray(image.wordSources) ? image.wordSources : inferredWordSources(image);
    const ids = new Set([...sources.map(source => String(source?.wordId || '')), ...(Array.isArray(image.exampleWordIds) ? image.exampleWordIds.map(String) : [])]);
    for (const id of ids) wordGalleryImages.get(id)?.push(image);
  }
}

function renderWordGallery(list) {
  updateWordGalleryImages();
  $('wordList').innerHTML = list.map(word => {
    const images = wordGalleryImages.get(String(word.id));
    const selected = authorSelections.words.active && authorSelections.words.ids.has(String(word.id));
    const active = !authorSelections.words.active && expandedWordId === String(word.id);
    const visual = images.length
      ? `<img class="recipe-cover" loading="lazy" decoding="async" src="${wordGalleryUrl(images[0].blob)}" alt="${escapeHTML(word.name)}例图">`
      : '<div class="recipe-cover empty-cover">等待第一张立图</div>';
    return `<article class="word-gallery-card"><button class="recipe-card${active ? ' active' : ''}${selected ? ' selected' : ''}" type="button" data-word-gallery-id="${escapeHTML(word.id)}" ${authorSelections.words.active ? `aria-pressed="${selected}"` : `aria-expanded="${active}" aria-controls="wordInspector"`}>${authorSelections.words.active ? `<span class="select-mark" aria-hidden="true">${icon('check')}</span>` : ''}${visual}<div class="recipe-card-body"><div class="recipe-card-title">${word.favorite ? `${icon('star')} ` : ''}${escapeHTML(word.name)}</div><div class="recipe-card-meta"><span>${images.length} 张立图</span><span>${escapeHTML((word.tags || [])[0] || '未标记')}</span></div></div></button><div class="word-actions"></div></article>`;
  }).join('') || '<div class="empty"><div><b>散词库还是空的</b><span>保存单独词条，或用结构化表单保存整套配方。</span></div></div>';
  $('wordList').querySelectorAll('[data-word-gallery-id]').forEach(button => button.onclick = () => {
    const id = button.dataset.wordGalleryId;
    if (authorSelections.words.active) { toggleAuthorSelection('words', id); return; }
    expandedWordId = expandedWordId === id ? '' : id;
    renderWordGalleryInspector(list);
    bindWordActions();
    button.focus({ preventScroll: true });
  });
}

function renderWordGalleryInspector(list) {
  resetWordGalleryInspector();
  if (authorSelections.words.active) return;
  $('wordList').querySelectorAll('[data-word-gallery-id]').forEach(button => {
    const active = button.dataset.wordGalleryId === expandedWordId;
    button.classList.toggle('active', active);
    button.setAttribute('aria-expanded', String(active));
  });
  const word = list.find(item => String(item.id) === expandedWordId);
  if (!word) return;
  const images = wordGalleryImages.get(String(word.id)) || [];
  const ids = images.map(item => item.id);
  const inspector = $('wordInspector');
  inspector.hidden = false;
  inspector.setAttribute('aria-label', `${word.name}的内容和例图`);
  const hero = images.length ? `<img src="${wordGalleryUrl(images[0].blob)}" alt="${escapeHTML(word.name)}封面">` : '<div class="recipe-hero-placeholder">暂无立图</div>';
  inspector.innerHTML = `<div class="recipe-hero">${hero}<div><h2>${escapeHTML(word.name)}</h2><div class="chips">${(word.tags || []).map(tag => `<span class="chip">${escapeHTML(tag)}</span>`).join('') || '<span class="chip">未添加标签</span>'}</div></div></div>${wordRowHTML(word)}<div class="recipe-images-head"><b>立图 · ${images.length}</b><div class="tools"><button class="mini-action" id="selectWordImages" type="button">${artworkSelectionMode ? '退出多选' : '多选'}</button><button class="mini-action" id="importWordExample" type="button">导入例图</button></div></div>${batchBarHTML(ids)}<div class="recipe-images${images.length <= 3 ? ' single-row' : ''}${artworkSelectionMode ? ' selection-mode' : ''}">${images.map(item => `<button class="recipe-image${selectedArtworkIds.has(String(item.id)) ? ' selected' : ''}" data-image-id="${item.id}" aria-label="${artworkSelectionMode ? '选择' : '查看'}${escapeHTML(item.title || '图片')}">${selectionMark(item)}<img draggable="false" loading="lazy" decoding="async" src="${wordGalleryUrl(item.blob)}" alt="${escapeHTML(item.title || word.name)}">${artworkSelectionMode ? '' : '<span class="recipe-image-more" aria-hidden="true">•••</span>'}</button>`).join('') || '<div class="empty-inline">还没有立图。使用这个词条生成，或导入例图。</div>'}</div>`;
  if (matchMedia('(max-width:1100px)').matches) $('wordList').querySelector(`[data-word-gallery-id="${CSS.escape(String(word.id))}"]`).closest('.word-gallery-card').after(inspector);
  $('selectWordImages').onclick = () => setArtworkSelectionMode(!artworkSelectionMode);
  $('importWordExample').onclick = () => { $('wordExampleFile').dataset.wordId = word.id; $('wordExampleFile').click(); };
  inspector.querySelectorAll('[data-image-id]').forEach(button => bindImageAction(button, Number(button.dataset.imageId)));
  bindBatchBar(inspector, ids);
}

$('wordExampleFile').onchange = event => {
  const file = event.target.files[0], id = event.target.dataset.wordId;
  event.target.value = '';
  if (file) beginImageImport(file, '', id);
};
