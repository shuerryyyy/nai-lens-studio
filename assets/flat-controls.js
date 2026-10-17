/* Presentation adapter: no storage, network requests or generation logic. */
(() => {
  'use strict';
  const icon = name => `<svg class="icon" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;
  const fixed = {
    newWordBtn:['plus','新增词条'], closeWordEditor:['x','关闭编辑面板'],
    recipeMultiSelectBtn:['square-check-big','多选配方'], wordMultiSelectBtn:['square-check-big','多选词条'],
    importImageBtn:['image','解析图片'], exportBtn:['download','下载备份'], importBtn:['upload','恢复备份'],
    newRecipeBtn:['plus','新建配方'], saveBundleBtn:['save','保存为配方'],
    galleryNewRecipeBtn:['plus','新建配方'], galleryImportBtn:['image','解析外部图片'],
    editRecipeBottom:['pencil','编辑配方'], importIntoRecipe:['image','导入图片'],
    selectRecipeImages:['square-check-big','多选图片'],
    openVibeLibrary:['library','打开 Vibe 库'], uploadVibeImage:['upload','上传参考图'],
    normalizeVibes:['sliders-horizontal','归一化参考强度'], saveVibeMix:['save','保存参考组合'],
    importVibeFile:['upload','导入 Vibe'], exportVibeLibrary:['download','导出 Vibe 库'],
    closeVibeLibrary:['x','关闭'], librarySelectBtn:['square-check-big','多选图片'],
    imageDownload:['download','下载原图'], imageDownloadJpeg:['image-down','下载 JPG 分享版'],
    imageReuse:['arrow-right','带回创作台'], imageMove:['folder-input','更换关联配方'],
    imageSetCover:['image','设为配方封面'], imageDelete:['trash','删除图片'],
    useRecipe:['arrow-right','带回创作台'], moveRecipeFront:['arrow-up-to-line','移到最前'],
    editRecipe:['pencil','编辑配方'], deleteRecipe:['trash','删除配方'],
    saveApiPresetBtn:['save','保存站点预设'], deleteApiPresetBtn:['trash','删除站点预设'],
  };
  const dynamic = [
    ['[data-theme-toggle]','palette','外观'],
    ['[data-copy],[data-recipe-copy],[data-import-copy],[data-character-field],[data-character-copy]','copy','复制'],
    ['[data-pick],[data-recipe-pick]','library','从库中选择'],
    ['[data-character-use],[data-word-use]','arrow-right','带回创作台'],
    ['[data-character-edit],[data-word-edit],[data-vibe-edit]','pencil','编辑'],
    ['[data-character-delete],[data-word-del],[data-vibe-delete]','trash','删除'],
    ['[data-vibe-export]','download','导出'],
    ['[data-vibe-favorite]','star','收藏'],
    ['[data-vibe-mix]','arrow-right','使用组合'],
    ['[data-batch-all]','square-check-big','全选或取消全选'],
    ['[data-batch-favorite]','star','收藏或取消收藏'],
    ['[data-batch-tag]','tag','添加标签'],
    ['[data-batch-move]','folder-input','更换关联配方'],
    ['[data-batch-delete]','trash','删除所选图片'],
    ['[data-batch-cancel]','x','退出多选'],
    ['.icon-btn[data-close-dialog]','x','关闭'],
    ['[data-vibe-remove]','trash','移除参考'],
  ];
  function tool(button,name,label) {
    const existingLabel = button.getAttribute('aria-label');
    const text = button.textContent.trim();
    const accessible = existingLabel || (text && !['×','复制'].includes(text) ? text : label);
    if (!button.classList.contains('flat-tool')) {
      button.classList.add('flat-tool');
      button.setAttribute('aria-label',accessible);
      button.dataset.flatTooltip = accessible;
      button.removeAttribute('title');
    }
    if(['librarySelectBtn','selectRecipeImages','recipeMultiSelectBtn','wordMultiSelectBtn'].includes(button.id) && text) {
      const stateLabel=text.includes('退出')?'退出多选':button.id==='recipeMultiSelectBtn'?'多选配方':button.id==='wordMultiSelectBtn'?'多选词条':'多选图片';
      button.setAttribute('aria-label',stateLabel);button.dataset.flatTooltip=stateLabel;
    }
    if (button.dataset.flatIcon !== name || !button.querySelector('svg')) {
      button.dataset.flatIcon = name;
      button.innerHTML = icon(name);
    }
  }
  function decorate(root) {
    const buttons = root.matches?.('button') ? [root] : [];
    root.querySelectorAll?.('button').forEach(button=>buttons.push(button));
    for (const button of buttons) {
      let spec = fixed[button.id];
      if (!spec) {
        const row = dynamic.find(([selector])=>button.matches(selector));
        if (row) spec = row.slice(1);
      }
      if (spec) tool(button,...spec);
      else if (button.matches('.icon-btn,.copy-btn') && button.querySelector('svg')) {
        const label = button.getAttribute('aria-label') || button.title;
        if (label) {
          button.dataset.flatTooltip=label;
          button.removeAttribute('title');
        }
      }
    }
  }
  function contextualHelp(target) {
    if (target.dataset.flatHelp || !target.textContent.trim()) return;
    target.dataset.flatHelp='true';
    const help=document.createElement('button');
    help.type='button';help.className='flat-help flat-tool';
    help.setAttribute('aria-label','查看说明');
    help.dataset.flatTooltip=target.textContent.trim();
    help.innerHTML=icon('info');
    if (target.id) help.dataset.flatHelpTarget=target.id;
    const host=target.matches('.page-head p,.library-filter-panel>p') ? target.previousElementSibling : target.parentElement;
    if (!host) return;
    if(target.id==='activeRecipeHint')target.previousElementSibling.after(help);
    else host.append(help);
    target.classList.add('flat-explanation');
  }
  decorate(document);
  const helpSelector = '.section-head>span:not([id]),.page-head p,.library-filter-panel>p,#activeRecipeHint,#modelHelp,.dialog-head p:not(#importStatus),.import-note,.field-note,#vibeSupportNote';
  document.querySelectorAll(helpSelector).forEach(contextualHelp);
  document.querySelectorAll('.scene-input').forEach(input=>{
    input.title=input.placeholder;
    input.placeholder='画面描述（可留空）…';
  });
  const character=document.getElementById('characterPrompt');
  if(character){character.title=character.placeholder;character.placeholder='输入人物提示词…';}
  const observer = new MutationObserver(records=>{
    for(const record of records) for(const node of record.addedNodes) {
      if(node.nodeType===1) {
        decorate(node);
        if (node.matches?.(helpSelector)) contextualHelp(node);
        node.querySelectorAll?.(helpSelector).forEach(contextualHelp);
      }
      else if(node.nodeType===3) {
        if (record.target.matches?.('button.flat-tool')) decorate(record.target);
        else if (record.target.matches?.(helpSelector)) contextualHelp(record.target);
      }
    }
  });
  observer.observe(document.body,{childList:true,subtree:true});

  const tooltip=document.createElement('div');
  tooltip.id='flatTooltip';tooltip.className='flat-tooltip';tooltip.role='tooltip';tooltip.hidden=true;
  document.body.append(tooltip);
  let timer,owner;
  function hide(){clearTimeout(timer);tooltip.hidden=true;if(owner)owner.removeAttribute('aria-describedby');owner=null;}
  function show(button,delay){
    hide();
    if(button.disabled)return;
    owner=button;
    timer=setTimeout(()=>{
      const targetId=button.dataset.flatHelpTarget;
      const text=targetId?document.getElementById(targetId)?.textContent:button.getAttribute('aria-label')==='查看说明'?button.dataset.flatTooltip:button.getAttribute('aria-label')||button.dataset.flatTooltip;
      if(!text?.trim())return;
      owner=button;
      (button.closest('dialog[open]')||document.body).append(tooltip);
      tooltip.textContent=text;tooltip.hidden=false;
      button.setAttribute('aria-describedby',tooltip.id);
      const rect=button.getBoundingClientRect(),bounds=tooltip.getBoundingClientRect();
      tooltip.style.left=`${Math.max(8,Math.min(rect.left+rect.width/2-bounds.width/2,innerWidth-bounds.width-8))}px`;
      tooltip.style.top=`${rect.bottom+bounds.height+16<innerHeight?rect.bottom+8:Math.max(8,rect.top-bounds.height-8)}px`;
    },delay);
  }
  document.addEventListener('pointerover',event=>{const button=event.target.closest?.('[data-flat-tooltip]');if(button&&!button.contains(event.relatedTarget))show(button,220)});
  document.addEventListener('pointerout',event=>{if(owner&&!owner.contains(event.relatedTarget))hide()});
  document.addEventListener('focusin',event=>{const button=event.target.closest?.('[data-flat-tooltip]');if(button)show(button,0)});
  document.addEventListener('focusout',hide);
  document.addEventListener('click',event=>{
    const help=event.target.closest?.('.flat-help');
    if(help){event.preventDefault();show(help,0)}else hide();
  });
  document.addEventListener('keydown',event=>{if(event.key==='Escape')hide()});
  document.addEventListener('scroll',hide,true);
})();
