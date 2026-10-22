'use strict';
/* Vibe assets, encoding and selection state. Network access remains user-triggered. */

// Vibe assets and reusable mixes live in IndexedDB, not localStorage.
const VIBE_SELECTION_KEY = 'nai_studio_vibe_selection_v1';
let vibeCache = [];
let vibeSelection = [];
let vibeBusy = false;
let vibeSelectionRevision = 0;

function vibeSupported(model) { return /^nai-diffusion-(?:3$|4(?:-5)?-)/.test(model); }
function vibeNumber(value, fallback = 0.6) { const number = Number(value); return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback; }
function cleanVibeSelection(items) {
  const seen=new Set();
  return Array.isArray(items) ? items.filter(item => {if(!item||typeof item.id!=='string'||seen.has(item.id))return false;seen.add(item.id);return true;}).slice(0,16).map(item => ({id:item.id, strength:vibeNumber(item.strength), information:vibeNumber(item.information,1), enabled:item.enabled !== false})) : [];
}
function saveVibeSelection() { vibeSelectionRevision++; localStorage.setItem(VIBE_SELECTION_KEY, JSON.stringify(cleanVibeSelection(vibeSelection))); }
function vibeEncoding(asset, model, information) {
  return (asset?.encodings || []).find(item => item.model === model && Math.abs(item.information-information) < 0.00001);
}
function vibeRequestFields(meta) {
  if (!vibeSupported(meta.model) || !meta.vibes?.length) return {};
  if(meta.vibes.some(item=>typeof item.encoding!=='string'||!item.encoding)) throw new Error('Vibe 数据尚未准备完成');
  return {
    reference_image_multiple: meta.vibes.map(item => item.encoding),
    reference_information_extracted_multiple: meta.vibes.map(item => item.information),
    reference_strength_multiple: meta.vibes.map(item => item.strength)
  };
}
function vibeEndpoint() {
  const url = new URL($('endpoint').value.trim());
  if (!['https:','http:'].includes(url.protocol)) throw new Error('Vibe 接口必须是 HTTP/HTTPS 地址');
  if ($('apiMode').value === 'official' || /\/ai\/generate-image\/?$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/ai\/generate-image\/?$/, '/ai/encode-vibe');
    if (!/\/ai\/encode-vibe$/.test(url.pathname)) throw new Error('请使用官方格式的 /ai/generate-image 接口');
    return url.href;
  }
  const explicit = $('vibeEncodeEndpoint').value.trim();
  if (!safeHttpUrl(explicit)) throw new Error('这个兼容站点需要在 Vibe 设置中填写编码接口，或导入已编码的 Vibe 文件');
  return explicit;
}
async function prepareVibes(meta, signal, token = $('token').value.trim()) {
  if (!meta.vibes?.length) return;
  if (!vibeSupported(meta.model)) throw new Error('当前模型不支持 Vibe');
  if ($('apiMode').value === 'proxy' && !/\/ai\/generate-image\/?$/.test(new URL($('endpoint').value.trim()).pathname) && !$('vibeProxySupported').checked) {
    throw new Error('请先确认第三方站点支持 Vibe 参数；在 Vibe 设置中勾选后才能发送');
  }
  const missing = meta.vibes.filter(item => !vibeEncoding(vibeCache.find(asset => asset.id === item.id), meta.model, item.information) && meta.model !== 'nai-diffusion-3');
  if (missing.length && !confirm(`这次需要编码 ${missing.length} 份 Vibe，官方通常每份收取 2 Anlas（第三方以站点定价为准）。修改信息提取量或模型可能重新收费。是否继续？`)) throw new Error('已取消 Vibe 编码，未发送生成请求');
  if (meta.vibes.length > 4 && !confirm('超过 4 个 Vibe，官方 V4 及以上通常每多一个增加 2 Anlas 生图费用。继续生成？')) throw new Error('已取消生成');
  // Preflight every asset and route before any billable encoding request.
  for (const item of meta.vibes) {
    const asset = vibeCache.find(record => record.id === item.id && record.type === 'asset');
    if (!asset) throw new Error('有 Vibe 素材已删除，请重新从库选择');
    if ((meta.model === 'nai-diffusion-3' || !vibeEncoding(asset,meta.model,item.information)) && !asset.image) throw new Error(`“${asset.name}”没有此模型/提取量的编码，也没有原图；请使用已有提取量或重新导入原图`);
  }
  const encodeUrl = missing.length ? vibeEndpoint() : '';
  for (const item of meta.vibes) {
    if (signal?.aborted) throw new DOMException('已停止等待','AbortError');
    const asset = vibeCache.find(record => record.id === item.id);
    item.name = asset.name;
    item.model = meta.model;
    if (meta.model === 'nai-diffusion-3') { item.encoding = asset.image.replace(/^data:[^;]+;base64,/, ''); continue; }
    let encoded = vibeEncoding(asset,meta.model,item.information);
    if (!encoded) {
      setStatus('正在准备 Vibe', 'run', `编码：${asset.name}；完成后将继续生图`);
      const response = await fetch(encodeUrl, {method:'POST', signal, headers:{Authorization:`Bearer ${token}`, 'Content-Type':'application/json'}, body:JSON.stringify({image:asset.image.replace(/^data:[^;]+;base64,/, ''), model:meta.model, information_extracted:item.information})});
      if (!response.ok) throw new Error(explainHttpError(response.status, await response.text()));
      if ((response.headers.get('content-type') || '').includes('json')) throw new Error('编码接口返回 JSON，预期官方二进制编码格式；请核对站点协议');
      const bytes = new Uint8Array(await readLimitedResponse(response, 8*1024*1024));
      if (!bytes.length || /^(?:\s*<|\s*\{)/.test(new TextDecoder().decode(bytes.slice(0,32)))) throw new Error('编码接口没有返回有效的二进制 Vibe');
      let binary = ''; for (let i=0;i<bytes.length;i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
      encoded = {model:meta.model,information:item.information,encoding:btoa(binary)};
      const next = {...asset,encodings:[...asset.encodings,encoded],updatedAt:Date.now()};
      Object.assign(asset,next);
      try { await dbPut('vibes',next); }
      catch { renderVibePanel();throw new Error('Vibe 已编码，但浏览器缓存写入失败。请先从 Vibe 库导出这份素材；当前页面仍保留编码，避免重复付费。'); }
    }
    item.encoding = encoded.encoding;
  }
  renderVibePanel();
}
async function restoreVibeSelection(items, model = '') {
  const revision = ++vibeSelectionRevision;
  try {
  for(const item of Array.isArray(items)?items.slice(0,16):[]) {
    if(!vibeCache.some(asset=>asset.id===item.id)&&item.encoding) {
      const asset=normalizeVibeAsset({id:item.id,name:item.name||'图片中复用的 Vibe',encodings:[{model:item.model||model,information:item.information,encoding:item.encoding}]});
      await dbPut('vibes',asset);vibeCache.push(asset);
    }
  }
  if (revision !== vibeSelectionRevision) return;
  vibeSelection = cleanVibeSelection(items);
  saveVibeSelection(); renderVibePanel();
  } catch(error) { toast(`Vibe 复用失败：${error.message}`); }
}
function normalizeVibeModel(key) {
  const compact = String(key).toLowerCase().replace(/[^a-z0-9]/g,'').replace('naidiffusion','').replace(/^v/,'');
  if (/^45/.test(compact)) return compact.includes('curated') ? 'nai-diffusion-4-5-curated' : 'nai-diffusion-4-5-full';
  if (/^4/.test(compact)) return compact.includes('curated') ? 'nai-diffusion-4-curated' : 'nai-diffusion-4-full';
  return compact === '3' ? 'nai-diffusion-3' : '';
}
function validVibeBase64(value, max = 12*1024*1024) {
  if (typeof value !== 'string' || !value.length || value.length > max || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4) throw new Error('Vibe 编码数据无效或过大');
  return value;
}
function safeVibeImage(value, max = MAX_IMAGE_BYTES*1.4) {
  if (!value) return '';
  if (typeof value !== 'string' || value.length > max || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(value)) throw new Error('Vibe 原图或缩略图格式无效');
  return value;
}
function normalizeVibeAsset(source) {
  if (!source || typeof source !== 'object') throw new Error('Vibe 素材无效');
  const encodings = [];
  if (Array.isArray(source.encodings)) {
    for (const item of source.encodings) {
      const model = normalizeVibeModel(item.model);
      if (model) encodings.push({model,information:vibeNumber(item.information,1),encoding:validVibeBase64(item.encoding)});
    }
  } else if (source.encodings && typeof source.encodings === 'object') {
    for (const [key,group] of Object.entries(source.encodings)) {
      const model = normalizeVibeModel(key); if (!model || !group || typeof group !== 'object') continue;
      for (const entry of Object.values(group)) if (entry?.encoding) encodings.push({model,information:vibeNumber(entry.params?.information_extracted,1),encoding:validVibeBase64(entry.encoding)});
    }
  }
  if (encodings.length > 64) throw new Error('一份 Vibe 包含过多编码版本');
  let image = source.image || '';
  if (image && !image.startsWith('data:')) image = 'data:image/png;base64,' + validVibeBase64(image,MAX_IMAGE_BYTES*1.4);
  image = safeVibeImage(image);
  if (!image && !encodings.length) throw new Error('文件里没有可用的原图或 Vibe 编码');
  return {id:String(source.id || makeId()),type:'asset',name:String(source.name || '导入的 Vibe').slice(0,200),tags:splitTags(Array.isArray(source.tags)?source.tags.join(','):source.tags),favorite:Boolean(source.favorite),image,thumbnail:safeVibeImage(source.thumbnail,1024*1024),encodings,createdAt:Number(source.createdAt)||Date.now(),updatedAt:Date.now()};
}
async function planVibeImport(sources) {
  if (!Array.isArray(sources) || sources.length>1000) throw new Error('Vibe 库格式无效或记录过多');
  const existing = await dbAll('vibes'), records=[], idMap=new Map();
  const byHash=new Map();
  for (const record of existing.filter(item=>item.type==='asset')) byHash.set(await blobFingerprint(new Blob([record.image||JSON.stringify(record.encodings)])),record);
  for (const source of sources.filter(item=>item?.type!=='bundle')) {
    const record=normalizeVibeAsset(source), hash=await blobFingerprint(new Blob([record.image||JSON.stringify(record.encodings)]));
    const matched=byHash.get(hash);
    if (matched) {
      idMap.set(String(source.id||record.id),matched.id);
      const merged={...matched,tags:[...new Set([...(matched.tags||[]),...record.tags])],favorite:matched.favorite||record.favorite,encodings:[...(matched.encodings||[])]};
      for(const entry of record.encodings) if(!vibeEncoding(merged,entry.model,entry.information))merged.encodings.push(entry);
      Object.assign(matched,merged);
      if(!records.includes(matched))records.push(matched);
    } else {
      if(existing.some(item=>item.id===record.id)||records.some(item=>item.id===record.id))record.id=makeId();
      idMap.set(String(source.id||record.id),record.id);records.push(record);byHash.set(hash,record);
    }
  }
  for(const source of sources.filter(item=>item?.type==='bundle')) {
    if(!Array.isArray(source.items)||source.items.length>16||source.items.some(item=>!item||typeof item.id!=='string'))throw new Error('Vibe 组合格式无效，每组最多 16 项');
    const items=cleanVibeSelection(source.items).map(item=>({...item,id:idMap.get(item.id)||item.id}));
    if(items.some(item=>![...existing,...records].some(record=>record.id===item.id&&record.type==='asset')))throw new Error('Vibe 组合缺少关联素材，请连同素材一起导入');
    const name=String(source.name||'导入组合').slice(0,200);
    const matched=[...existing,...records].find(item=>item.type==='bundle'&&item.name===name&&JSON.stringify(item.items)===JSON.stringify(items));
    const record={id:matched?.id||makeId(),type:'bundle',name,items,createdAt:matched?.createdAt||Date.now()};
    if(!records.some(item=>item.id===record.id))records.push(record);
    if(source.id)idMap.set(String(source.id),record.id);
  }
  records.idMap=idMap;
  records.newCount=records.filter(record=>!existing.some(item=>item.id===record.id)).length;
  return records;
}
async function importVibeRecords(sources) {
  const records=await planVibeImport(sources);
  await new Promise((resolve,reject)=>{const tx=db.transaction('vibes','readwrite');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||new Error('Vibe 导入失败'));try{for(const record of records)tx.objectStore('vibes').put(record);}catch(error){tx.abort();reject(error);}});
  await refreshVibes();return records;
}
async function importVibeDocument(data, filename = '导入组合') {
  if(!data||typeof data!=='object')throw new Error('Vibe 文件不是有效对象');
  if(Array.isArray(data.vibeRecords))return importVibeRecords(data.vibeRecords);
  if(Array.isArray(data.vibes)) {
    const assets=data.vibes.map(item=>({...item,id:String(item.id||makeId())}));
    return importVibeRecords([...assets,{type:'bundle',name:String(data.name||filename).replace(/\.[^.]+$/,''),items:assets.map(item=>({id:item.id,strength:vibeNumber(item.importInfo?.strength),information:vibeNumber(item.importInfo?.information_extracted,1),enabled:true}))}]);
  }
  return importVibeRecords([data]);
}
async function addVibeImage(file) {
  if(file.size>MAX_IMAGE_BYTES)throw new Error('参考图超过 64 MB');
  const blob=await validateGeneratedImage(file);
  const source=await imageSourceFromBlob(blob), canvas=document.createElement('canvas');
  const ratio=Math.min(1,128/Math.max(source.width,source.height));canvas.width=Math.max(1,Math.round(source.width*ratio));canvas.height=Math.max(1,Math.round(source.height*ratio));
  canvas.getContext('2d').drawImage(source,0,0,canvas.width,canvas.height);if(source.close)source.close();
  const records=await importVibeRecords([{name:file.name.replace(/\.[^.]+$/,''),image:await blobToDataURL(blob),thumbnail:canvas.toDataURL('image/jpeg',.8)}]);
  if(vibeSelection.length<16&&!vibeSelection.some(item=>item.id===records[0].id))vibeSelection.push({id:records[0].id,strength:.6,information:1,enabled:true});
  saveVibeSelection();renderVibePanel();
}
async function refreshVibes() { vibeCache=await dbAll('vibes');renderVibePanel();if($('vibeDialog').open)renderVibeLibrary(); }
function renderVibePanel() {
  if(!$('vibeSelection'))return;
  const supported=vibeSupported($('model').value);
  if ($('vibeSummaryCount')) $('vibeSummaryCount').textContent = !vibeSelection.length ? '未选择' : supported ? `${vibeSelection.filter(item => item.enabled && item.strength > 0).length} / ${vibeSelection.length} 份启用` : `${vibeSelection.length} 份已暂停`;
  $('vibeSupportNote').textContent=supported ? '可叠加多份参考；首次编码可能收费，已编码素材会复用缓存。' : '当前 V5 暂不支持 Vibe；已选素材保留，切回 V4.5 后可继续使用。';
  $('vibeSelection').innerHTML=vibeSelection.map((item,index)=>{
    const asset=vibeCache.find(record=>record.id===item.id),ready=!!vibeEncoding(asset,$('model').value,item.information);
    return `<div class="vibe-row">${asset?.thumbnail?`<img class="vibe-thumb" src="${escapeHTML(asset.thumbnail)}" alt="${escapeHTML(asset.name)}">`:'<span class="vibe-thumb" aria-hidden="true"></span>'}<div><b>${escapeHTML(asset?.name||'素材已删除，请移除')}</b><small>${!supported?'已暂停':ready?'已有编码':$('model').value==='nai-diffusion-3'?'使用参考原图':'需要编码'}</small><label class="check"><input type="checkbox" data-vibe-enabled="${index}" ${item.enabled?'checked':''}>本次使用</label><div class="vibe-controls"><label>参考强度<input aria-label="参考强度 ${escapeHTML(asset?.name||'')}" data-vibe-strength="${index}" type="number" min="0" max="1" step="0.05" value="${item.strength}"></label><label>信息提取量<input aria-label="信息提取量 ${escapeHTML(asset?.name||'')}" data-vibe-information="${index}" type="number" min="0" max="1" step="0.05" value="${item.information}"></label></div></div><button class="icon-btn" data-vibe-remove="${index}" aria-label="移除 ${escapeHTML(asset?.name||'Vibe')}">${icon('trash')}</button></div>`;
  }).join('');
  for(const field of ['strength','information','enabled'])$('vibeSelection').querySelectorAll(`[data-vibe-${field}]`).forEach(input=>input.onchange=()=>{const item=vibeSelection[Number(input.getAttribute(`data-vibe-${field}`))];item[field]=field==='enabled'?input.checked:vibeNumber(input.value,field==='information'?1:.6);saveVibeSelection();renderVibePanel();});
  $('vibeSelection').querySelectorAll('[data-vibe-remove]').forEach(button=>button.onclick=()=>{vibeSelection.splice(Number(button.dataset.vibeRemove),1);saveVibeSelection();renderVibePanel();});
}
function renderVibeLibrary() {
  const query=$('vibeSearch').value.trim().toLowerCase();
  const list=vibeCache.filter(item=>!query||searchableText(item.name,item.tags).includes(query)).sort((a,b)=>Number(b.favorite)-Number(a.favorite));
  $('vibeLibraryList').innerHTML=list.map(record=>`<section class="vibe-library-row"><div class="vibe-pick">${record.type==='asset'?`<input aria-label="选择 ${escapeHTML(record.name)}" type="checkbox" data-vibe-pick="${escapeHTML(record.id)}" ${vibeSelection.some(item=>item.id===record.id)?'checked':''}>`:''}${record.thumbnail?`<img class="vibe-thumb" src="${escapeHTML(record.thumbnail)}" alt="">`:''}<div><b>${escapeHTML(record.name)}</b><small>${record.type==='bundle'?`组合 · ${record.items.length} 份参考`:`素材 · ${(record.tags||[]).map(escapeHTML).join(' / ')||'无标签'}`}</small></div></div><div class="vibe-actions">${record.type==='bundle'?`<button class="secondary" data-vibe-mix="${escapeHTML(record.id)}">使用组合</button>`:`<button class="secondary" data-vibe-favorite="${escapeHTML(record.id)}">${record.favorite?'取消收藏':'收藏'}</button>`}<button class="secondary" data-vibe-edit="${escapeHTML(record.id)}">改名/标签</button><button class="secondary" data-vibe-export="${escapeHTML(record.id)}">导出</button><button class="danger-btn" data-vibe-delete="${escapeHTML(record.id)}">删除</button></div></section>`).join('')||'<p class="vibe-note">还没有匹配的素材。先上传参考图或导入 Vibe 文件。</p>';
  $('vibeLibraryList').querySelectorAll('[data-vibe-pick]').forEach(input=>input.onchange=()=>{if(input.checked){if(vibeSelection.length>=16){input.checked=false;toast('最多选择 16 份 Vibe');return;}const asset=vibeCache.find(item=>item.id===input.dataset.vibePick),encoded=asset.encodings.find(item=>item.model===$('model').value);vibeSelection.push({id:asset.id,strength:.6,information:encoded?.information??1,enabled:true});}else vibeSelection=vibeSelection.filter(item=>item.id!==input.dataset.vibePick);saveVibeSelection();renderVibePanel();});
  for(const action of ['mix','favorite','edit','export','delete'])$('vibeLibraryList').querySelectorAll(`[data-vibe-${action}]`).forEach(button=>button.onclick=async()=>{try{
    const record=vibeCache.find(item=>item.id===button.getAttribute(`data-vibe-${action}`));if(!record)return;
    if(action==='mix'){restoreVibeSelection(record.items);closeDialog('vibeDialog');return;}
    if(action==='export'){exportVibeRecords(record);return;}
    if(action==='delete'){if(!confirm(`删除“${record.name}”？本地素材删除后，引用它的组合将移除此项。`))return;const tx=db.transaction('vibes','readwrite');const done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});tx.objectStore('vibes').delete(record.id);for(const mix of vibeCache.filter(item=>item.type==='bundle'&&item.id!==record.id))tx.objectStore('vibes').put({...mix,items:mix.items.filter(item=>item.id!==record.id)});await done;vibeSelection=vibeSelection.filter(item=>item.id!==record.id);saveVibeSelection();}
    if(action==='favorite')await dbPut('vibes',{...record,favorite:!record.favorite});
    if(action==='edit'){const name=prompt('素材/组合名称',record.name);if(name===null)return;if(!name.trim())throw new Error('名称不能为空');const tags=record.type==='asset'?prompt('标签，用逗号分隔',(record.tags||[]).join(', ')):'';if(tags===null)return;await dbPut('vibes',{...record,name:name.trim().slice(0,200),tags:splitTags(tags),updatedAt:Date.now()});}
    await refreshVibes();
  }catch(error){toast(error.message);}});
}
function exportVibeRecords(record = null) {
  let records=record?[record]:vibeCache;
  if(record?.type==='bundle')records=[...vibeCache.filter(item=>item.type==='asset'&&record.items.some(entry=>entry.id===item.id)),record];
  triggerBlobDownload(new Blob([JSON.stringify({app:'NAI 镜头台 Vibe 库',version:1,vibeRecords:records})],{type:'application/json'}),`NAI_Vibe_${safeFilenamePart(record?.name||'全部素材与组合')}.json`);
}
async function initVibes() {
  const panel=document.createElement('section');panel.className='vibe-panel';panel.innerHTML='<div class="field-top"><label>Vibe 参考</label><span class="field-note">可多选与叠加</span></div><div class="vibe-tools"><button class="secondary" id="openVibeLibrary" type="button">从 Vibe 库选择</button><button class="secondary" id="uploadVibeImage" type="button">上传参考图</button><button class="secondary" id="normalizeVibes" type="button">归一化强度</button><button class="secondary" id="saveVibeMix" type="button">保存组合</button></div><p id="vibeSupportNote" class="vibe-note"></p><div class="vibe-list" id="vibeSelection"></div><details class="advanced"><summary>第三方 Vibe 连接设置</summary><label class="check"><input id="vibeProxySupported" type="checkbox">我已确认此站点支持官方 Vibe 参考数组</label><label for="vibeEncodeEndpoint">Vibe 编码接口（需要编码新图片时填写）</label><input id="vibeEncodeEndpoint" type="url" placeholder="https://你的站点/ai/encode-vibe"><p class="vibe-note">此地址会接收当前 Token 和参考图，请使用同一可信服务商。原生 /ai/generate-image 接口自动使用同路径的编码接口。</p></details><input id="vibeImageFile" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden>';
  document.querySelector('.prompt-sheet .actions').before(panel);
  const dialog=document.createElement('dialog');dialog.id='vibeDialog';dialog.className='dialog';dialog.innerHTML='<div class="dialog-inner"><div class="dialog-head"><div><h2>Vibe 素材与组合</h2><p>素材保存在当前浏览器，建议定期导出备份。</p></div><button class="icon-btn" id="closeVibeLibrary" aria-label="关闭">×</button></div><input id="vibeSearch" aria-label="搜索 Vibe" placeholder="搜索名称或标签"><div class="vibe-tools" style="margin-top:12px"><button class="secondary" id="importVibeFile">导入 Vibe / 备份</button><button class="secondary" id="exportVibeLibrary">导出全部</button></div><p class="vibe-note">支持镜头台 Vibe JSON、.naiv4vibe 和 .naiv4vibeBundle。只有编码的素材不能任意改变模型或信息提取量。</p><div id="vibeLibraryMessage" class="vibe-error" role="status"></div><div id="vibeLibraryList"></div><input id="vibeImportFile" type="file" accept=".json,.naiv4vibe,.naiv4vibebundle" hidden></div>';
  document.body.append(dialog);dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});
  try{vibeSelection=cleanVibeSelection(JSON.parse(localStorage.getItem(VIBE_SELECTION_KEY)||'[]'));}catch{vibeSelection=[];}
  $('openVibeLibrary').onclick=()=>{renderVibeLibrary();showDialog('vibeDialog');};$('closeVibeLibrary').onclick=()=>closeDialog('vibeDialog');$('vibeSearch').oninput=renderVibeLibrary;
  $('uploadVibeImage').onclick=()=>$('vibeImageFile').click();
  $('vibeImageFile').onchange=async event=>{if(vibeBusy)return;vibeBusy=true;try{for(const file of event.target.files)await addVibeImage(file);toast('参考图已保存；需要生成时才进行付费编码');}catch(error){toast(error.message);}finally{vibeBusy=false;event.target.value='';}};
  $('normalizeVibes').onclick=()=>{const enabled=vibeSelection.filter(item=>item.enabled),total=enabled.reduce((sum,item)=>sum+item.strength,0);let used=0;if(total>0)enabled.forEach((item,index)=>{const units=index===enabled.length-1?1000-used:Math.floor(item.strength/total*1000);used+=units;item.strength=units/1000;});saveVibeSelection();renderVibePanel();};
  $('saveVibeMix').onclick=async()=>{try{if(!vibeSelection.length)throw new Error('请先选择 Vibe');const name=prompt('为这套 Vibe 组合起个名字');if(!name?.trim())return;await dbPut('vibes',{id:makeId(),type:'bundle',name:name.trim().slice(0,200),items:cleanVibeSelection(vibeSelection),createdAt:Date.now()});await refreshVibes();toast('组合已保存，可以从 Vibe 库直接选用');}catch(error){toast(error.message);}};
  $('importVibeFile').onclick=()=>$('vibeImportFile').click();$('exportVibeLibrary').onclick=()=>exportVibeRecords();
  $('vibeImportFile').onchange=async event=>{try{const file=event.target.files[0];if(!file)return;if(file.size>128*1024*1024)throw new Error('Vibe 文件超过 128 MB');await importVibeDocument(JSON.parse(await file.text()),file.name);$('vibeLibraryMessage').textContent='已导入；素材可多选，组合可直接使用。';}catch(error){$('vibeLibraryMessage').textContent=error.message;}finally{event.target.value='';}};
  for(const id of ['endpoint','apiMode','apiPresetSelect'])$(id).addEventListener('change',()=>{$('vibeProxySupported').checked=false;$('vibeEncodeEndpoint').value='';});
  const updateViewport=()=>{
    const viewport=window.visualViewport;
    const focused=document.activeElement?.matches('input,textarea,select');
    document.documentElement.style.setProperty('--nai-viewport-height',`${viewport?.height||innerHeight}px`);
    document.documentElement.style.setProperty('--nai-viewport-top',`${viewport?.offsetTop||0}px`);
    document.documentElement.dataset.keyboardOpen=String(Boolean(focused&&viewport&&viewport.height<innerHeight*.75));
  };
  window.visualViewport?.addEventListener('resize',updateViewport);window.visualViewport?.addEventListener('scroll',updateViewport);
  window.addEventListener('resize',updateViewport);document.addEventListener('focusin',updateViewport);document.addEventListener('focusout',()=>requestAnimationFrame(updateViewport));updateViewport();
  await refreshVibes();
}
