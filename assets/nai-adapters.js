/* Declarative API adapter v1. Configurations contain data, never executable code. */
(() => {
  'use strict';
  const KEY = 'nai_studio_adapters_v1';
  const LIMIT = 64 * 1024;
  const BAD = new Set(['__proto__', 'constructor', 'prototype']);
  const SOURCES = ['model','fullPrompt','negativePrompt','scenePrompt','characterPrompt','artistPrompt','positivePrompt','size','width','height','steps','scale','sampler','seed','noiseSchedule','transparentBg'];
  const LABELS = {model:'模型',fullPrompt:'完整正向词',negativePrompt:'负面词',scenePrompt:'画面描述',characterPrompt:'人物词',artistPrompt:'画师串',positivePrompt:'固定正面词',size:'尺寸',width:'宽度',height:'高度',steps:'步数',scale:'Guidance',sampler:'采样器',seed:'Seed',noiseSchedule:'噪声调度',transparentBg:'透明背景'};
  const TYPES = ['string','number','integer','boolean'];
  const $ = id => document.getElementById(id);
  let onChange = () => {}, getPresets = () => [], loadIssue = '';
  const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
  const fail = message => { throw new Error(message); };
  function keys(value, allowed, at) {
    if (!plain(value)) fail(at + ' 必须是对象');
    for (const key of Object.keys(value)) if (BAD.has(key) || !allowed.includes(key)) fail(at + ' 包含不支持的字段：' + key);
  }
  function text(value, at, max = 200) {
    if (typeof value !== 'string' || !value.trim() || value.length > max) fail(at + ' 必须是1–' + max + '字的文本');
  }
  function parts(path, array = false) {
    text(path,'字段路径',200);
    const list = path.split('.');
    if (list.length > 8 || list.some(key => BAD.has(key) || !(array ? /^(?:[A-Za-z_][A-Za-z0-9_-]*|0|[1-9][0-9]*)$/ : /^[A-Za-z_][A-Za-z0-9_-]*$/).test(key))) fail('不支持的字段路径：' + path);
    return list;
  }
  function primitive(value) { return value === null || typeof value === 'number' && Number.isFinite(value) || ['string','boolean'].includes(typeof value); }
  function validate(input) {
    let serialized;
    try { serialized = JSON.stringify(input); } catch { fail('适配文件无法序列化'); }
    if (!serialized || new TextEncoder().encode(serialized).length > LIMIT) fail('适配文件超过64 KB或内容为空');
    keys(input,['format','version','id','name','description','allowedUrls','auth','request','response'],'适配文件');
    if (input.format !== 'nai-lens-adapter' || input.version !== 1) fail('只支持 nai-lens-adapter 第1版文件');
    if (typeof input.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.id)) fail('id须为1–64位字母、数字、下划线或短横线');
    text(input.name,'name',80);
    if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 600)) fail('description最长600字');
    if (!Array.isArray(input.allowedUrls) || !input.allowedUrls.length || input.allowedUrls.length > 12) fail('allowedUrls须包含1–12个完整接口地址');
    for (const address of input.allowedUrls) {
      text(address,'allowedUrls中的地址',500);
      let url; try { url = new URL(address); } catch { fail('不是有效接口地址：' + address); }
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || address.includes('*') || url.pathname === '/') fail('适用地址须是无账号、查询参数和片段的HTTP(S)完整接口路径');
    }
    keys(input.auth,['type','name'],'auth');
    if (!['bearer','header'].includes(input.auth.type)) fail('auth.type只支持bearer或header');
    if (input.auth.type === 'header') {
      if (typeof input.auth.name !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(input.auth.name) || /^(?:authorization|proxy-authorization|host|cookie|set-cookie|content-type|content-length|origin|referer|accept|connection|transfer-encoding|user-agent)$/i.test(input.auth.name) || /^(?:sec-|proxy-|access-control-)/i.test(input.auth.name)) fail('自定义认证头名称不受支持；Authorization请使用bearer');
    } else if (input.auth.name !== undefined) fail('bearer认证不需要name');
    keys(input.request,['fields'],'request');
    const fields = input.request.fields;
    if (!Array.isArray(fields) || !fields.length || fields.length > 96) fail('request.fields须包含1–96项映射');
    const targets = [], sources = new Set();
    for (const [index, field] of fields.entries()) {
      const at = 'fields[' + index + ']';
      keys(field,['target','source','type','map','value'],at);
      const list = parts(field.target);
      if (['n','n_samples'].includes(list.at(-1)) && field.value !== 1) fail('首版适配文件每次只生成1张图片');
      if (list.at(-1) === 'action' && field.value !== 'generate') fail('首版只支持generate文生图');
      if (list.some(key => /^(?:authorization|api[_-]?key|access[_-]?token|password|secret|token)$/i.test(key))) fail('认证密钥不能写进请求映射，请使用auth');
      if (targets.some(target => target === field.target || target.startsWith(field.target + '.') || field.target.startsWith(target + '.'))) fail('重复或冲突的目标路径：' + field.target);
      targets.push(field.target);
      const source = Object.hasOwn(field,'source'), value = Object.hasOwn(field,'value');
      if (source === value) fail(at + ' 必须只指定source或value其中一项');
      if (source) {
        if (!SOURCES.includes(field.source) || !TYPES.includes(field.type)) fail(at + ' 的source或type不受支持');
        sources.add(field.source);
        if (Object.hasOwn(field,'map')) {
          if (!plain(field.map) || !Object.keys(field.map).length || Object.keys(field.map).length > 40) fail(at + '.map须为1–40项的值映射');
          for (const [key,mapped] of Object.entries(field.map)) if (BAD.has(key) || key.length > 160 || !primitive(mapped)) fail(at + '.map包含无效值');
        }
      } else {
        if (field.type !== undefined || field.map !== undefined) fail(at + ' 的常量不能带type或map');
        if (!(primitive(field.value) || Array.isArray(field.value) && field.value.length <= 16 && field.value.every(primitive))) fail(at + ' 的value只支持基本值或基本值数组');
      }
    }
    for (const source of ['model','fullPrompt','negativePrompt','steps','scale','sampler','seed','noiseSchedule']) if (!sources.has(source)) fail('缺少必要参数映射：' + source);
    if (!sources.has('size') && !(sources.has('width') && sources.has('height'))) fail('必须映射size或同时映射width和height');
    keys(input.response,['format','imagePath','encoding'],'response');
    if (!['json','image','zip'].includes(input.response.format)) fail('response.format只支持json、image、zip');
    if (input.response.format === 'json') {
      parts(input.response.imagePath,true);
      if (!['base64','url'].includes(input.response.encoding)) fail('JSON返回的encoding须为base64或url');
    } else if (input.response.imagePath !== undefined || input.response.encoding !== undefined) fail('image/zip返回不需要imagePath或encoding');
    return JSON.parse(serialized);
  }
  function list() {
    loadIssue = '';
    try {
      const stored = JSON.parse(localStorage.getItem(KEY) || '[]');
      if (!Array.isArray(stored) || stored.length > 64) throw new Error();
      const valid = [];
      for (const config of stored) { try { valid.push(validate(config)); } catch { loadIssue = '部分已存适配文件无效，请重新导入。'; } }
      return valid;
    } catch { loadIssue = '已存适配文件无法读取，请重新导入。'; return []; }
  }
  function selectedId() { return $('apiAdapterSelect')?.value || ''; }
  function selected() {
    const id = selectedId();
    if (!id) return null;
    const config = list().find(item => item.id === id);
    if (!config) fail('选中的适配文件缺失或无效，请重新导入或切回默认格式');
    return config;
  }
  function matches(config, endpoint) {
    try {
      const current = new URL(endpoint);
      if (current.username || current.password) return false;
      const clean = path => path.replace(/\/$/,'');
      return config.allowedUrls.some(address => { const allowed = new URL(address); return current.origin === allowed.origin && clean(current.pathname) === clean(allowed.pathname); });
    } catch { return false; }
  }
  function requireFor(endpoint, mode, meta = null) {
    const config = selected();
    if (!config) return null;
    if (mode !== 'proxy') fail('导入的适配文件用于第三方/兼容站点，请先切换连接方式');
    if (!matches(config,endpoint)) fail('当前接口地址不在适配文件的适用范围内；请更换地址或适配文件');
    if (meta?.vibes?.length) fail('适配文件第1版暂不支持Vibe，请关闭本次Vibe或使用已有内置适配');
    if (meta?.transparentBg && !config.request.fields.some(field => field.source === 'transparentBg')) fail('这个适配文件没有透明背景映射，请关闭透明背景或补充映射');
    return config;
  }
  function build(config, meta) {
    config = validate(config);
    const dimensions = /^([0-9]+)x([0-9]+)$/.exec(meta.size || '');
    const source = { ...meta, width: dimensions ? Number(dimensions[1]) : undefined, height: dimensions ? Number(dimensions[2]) : undefined };
    const body = Object.create(null);
    for (const field of config.request.fields) {
      let value = field.value;
      if (Object.hasOwn(field,'source')) {
        value = source[field.source];
        if (value === undefined || value === null) fail('缺少请求参数：' + field.source);
        if (field.map) {
          if (!Object.hasOwn(field.map,String(value))) fail('值映射中缺少 ' + field.source + '：' + value);
          value = field.map[String(value)];
          if (value === null) fail(field.source + '的值映射不能为null');
        }
        if (field.type === 'string') value = String(value);
        else if (field.type === 'boolean') { if (typeof value !== 'boolean') fail(field.source + ' 不是布尔值'); }
        else {
          if (value === '' || typeof value === 'boolean') fail(field.source + ' 不是有效数字');
          value = Number(value);
          if (!Number.isFinite(value) || field.type === 'integer' && !Number.isInteger(value)) fail(field.source + ' 不是有效' + (field.type === 'integer' ? '整数' : '数字'));
        }
      }
      const path = parts(field.target); let target = body;
      for (const key of path.slice(0,-1)) target = target[key] ||= Object.create(null);
      target[path.at(-1)] = value;
    }
    return body;
  }
  function headers(config, token) {
    const result = {'Content-Type':'application/json',Accept: config.response.format === 'json' ? 'application/json' : config.response.format === 'zip' ? 'application/zip' : 'image/png,image/jpeg,image/webp'};
    result[config.auth.type === 'bearer' ? 'Authorization' : config.auth.name] = config.auth.type === 'bearer' ? 'Bearer ' + token : token;
    return result;
  }
  function imageValue(config, data) {
    let value = data;
    for (const key of parts(config.response.imagePath,true)) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value,key)) fail('返回中找不到图片路径：' + config.response.imagePath);
      value = value[key];
    }
    if (typeof value !== 'string' || !value) fail('图片路径没有返回有效文本');
    return value;
  }
  function populate(id = selectedId()) {
    const select = $('apiAdapterSelect'); select.replaceChildren(new Option('自动识别 / 默认格式',''));
    for (const item of list()) select.add(new Option(item.name,item.id));
    if (id && ![...select.options].some(option => option.value === id)) { const missing = new Option('适配文件缺失：' + id,id); missing.disabled = true; select.add(missing); }
    select.value = id; render();
  }
  function setSelected(id) { if ($('apiAdapterMessage')) $('apiAdapterMessage').textContent = ''; populate(typeof id === 'string' ? id : ''); }
  function render() {
    const status = $('apiAdapterStatus'), preview = $('apiAdapterPreview'); if (!status || !preview) return;
    preview.replaceChildren();
    $('apiAdapterSummary').textContent = selectedId() ? '已选择适配' : '自动识别';
    $('exportApiAdapter').disabled = $('removeApiAdapter').disabled = !selectedId();
    try {
      const config = selected();
      if (!config) { status.textContent = loadIssue || '按工具内置规则连接；也可导入站点适配文件。'; status.className = 'adapter-status'; return; }
      const match = matches(config,$('endpoint').value.trim()) && $('apiMode').value === 'proxy';
      $('apiAdapterSummary').textContent = config.name + (match ? '' : ' · 未匹配');
      status.textContent = (match ? '地址匹配 · 格式已检查，效果尚未核实。' : '当前连接方式或接口地址不匹配；生成前需修改。') + ' 选择后请保存 API 预设。';
      status.className = 'adapter-status' + (match ? '' : ' adapter-error');
      const info = document.createElement('p'); info.textContent = [config.description || '', '适用地址：' + config.allowedUrls.join('；'), '返回：' + config.response.format + (config.response.imagePath ? ' / ' + config.response.imagePath : '')].filter(Boolean).join('\n'); preview.append(info);
      const table = document.createElement('table'); const caption = document.createElement('caption'); caption.textContent = '参数对应关系'; table.append(caption);
      const head = document.createElement('tr'); for (const label of ['工具中的内容','发送到']) { const th = document.createElement('th'); th.textContent = label; th.scope = 'col'; head.append(th); } table.append(head);
      for (const field of config.request.fields) { const row = document.createElement('tr'); for (const value of [Object.hasOwn(field,'source') ? (LABELS[field.source] || field.source) + '（' + field.type + '）' + (field.map ? ' · 值映射：' + JSON.stringify(field.map) : '') : '固定值：' + JSON.stringify(field.value), field.target]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); } table.append(row); } preview.append(table);
    } catch (error) { status.textContent = error.message; status.className = 'adapter-status adapter-error'; }
  }
  function changed() { render(); try { onChange(); } catch (error) { $('apiAdapterMessage').textContent = '设置未能保存：' + error.message; } }
  function importConfig(input) {
    const config = validate(input), records = list();
    const same = records.find(item => item.id === config.id);
    if (same && JSON.stringify(same) === JSON.stringify(config)) { setSelected(config.id); changed(); return config; }
    if (records.length >= 64) fail('最多保存64个适配文件，请先移除不再使用的配置');
    if (same) { config.id = config.id.slice(0,48) + '-' + crypto.randomUUID().slice(0,8); config.name = config.name.slice(0,72) + '（副本）'; }
    localStorage.setItem(KEY,JSON.stringify([...records,config])); setSelected(config.id); changed(); return config;
  }
  function download(value, filename) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
  }
  const field = (target,source,type = 'string') => ({target,source,type});
  function example(kind) {
    const yes = kind !== 'aurora';
    const fields = [field('model','model'),field('prompt','fullPrompt'),field('size','size'),{target:'n',value:1},{target:'response_format',value:'b64_json'}];
    const prefix = yes ? 'nai.' : '';
    for (const [target,source,type] of [['negative_prompt','negativePrompt','string'],['steps','steps','integer'],['scale','scale','number'],['sampler','sampler','string'],['seed','seed',yes?'integer':'string'],['noise_schedule','noiseSchedule','string']]) fields.push(field(prefix+target,source,type));
    if (yes) fields.push({target:'nai.action',value:'generate'},{target:'nai.qualityToggle',value:false},{target:'nai.ucPreset',value:4});
    return {format:'nai-lens-adapter',version:1,id:yes?'yesnai-images-v1':'aurora-images-v1',name:yes?'YesNAI 兼容生图':'Aurora 兼容生图',description:yes?'依据公开文档；此文件仍需用你自己的返回原图核对。':'依据公开OpenAPI；尚未进行真实生成核验。',allowedUrls:yes?['https://ynai.rinko.ai/v1/images/generations','https://nai.rinko.ai/v1/images/generations']:['https://love.auroralove.cc/api/v1/images/generations','https://love.auroralove.cc/v1/images/generations'],auth:{type:'bearer'},request:{fields},response:{format:'json',imagePath:'data.0.b64_json',encoding:'base64'}};
  }
  function schema() {
    return {$schema:'https://json-schema.org/draft/2020-12/schema',title:'NAI 镜头台适配文件 v1',type:'object',additionalProperties:false,required:['format','version','id','name','allowedUrls','auth','request','response'],properties:{format:{const:'nai-lens-adapter'},version:{const:1},id:{type:'string',pattern:'^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$'},name:{type:'string',minLength:1,maxLength:80},description:{type:'string',maxLength:600},allowedUrls:{type:'array',minItems:1,maxItems:12,items:{type:'string',format:'uri',description:'完整HTTP(S)接口地址，不能包含账号、查询、片段或通配符'}},auth:{oneOf:[{type:'object',additionalProperties:false,required:['type'],properties:{type:{const:'bearer'}}},{type:'object',additionalProperties:false,required:['type','name'],properties:{type:{const:'header'},name:{type:'string',pattern:'^[A-Za-z][A-Za-z0-9-]{0,63}$'}}}]},request:{type:'object',additionalProperties:false,required:['fields'],properties:{fields:{type:'array',minItems:1,maxItems:96,items:{$ref:'#/$defs/field'}}}},response:{oneOf:[{type:'object',additionalProperties:false,required:['format','imagePath','encoding'],properties:{format:{const:'json'},imagePath:{type:'string',description:'如data.0.b64_json或images.0'},encoding:{enum:['base64','url']}}},{type:'object',additionalProperties:false,required:['format'],properties:{format:{enum:['image','zip']}}}]}},$defs:{field:{oneOf:[{type:'object',additionalProperties:false,required:['target','source','type'],properties:{target:{type:'string'},source:{enum:SOURCES},type:{enum:TYPES},map:{type:'object',maxProperties:40,additionalProperties:{type:['string','number','boolean','null']}}}},{type:'object',additionalProperties:false,required:['target','value'],properties:{target:{type:'string'},value:{oneOf:[{type:['string','number','boolean','null']},{type:'array',maxItems:16,items:{type:['string','number','boolean','null']}}]}}}]}}};
  }
  function aiInstructions() {
    return '请根据我随后提供的服务商公开接口文档，为NAI镜头台生成一个可导入的JSON适配文件。只输出单个JSON文件，不要Markdown代码围栏。\n'
      + '规范版本1：单次POST文生图请求；不支持脚本、表达式、流式、排队轮询、签名计算、Vibe或重试。n/n_samples如有，必须为常量1；action如有，必须为常量generate。若文档需要这些功能，或无法确认负面词/Guidance/采样器/Seed等必要字段，请先说明不支持或缺失的信息，不要猜测或假称已验证。不要索取、包含或编造API密钥。\n'
      + 'allowedUrls必须是文档中的完整接口地址（无账号、查询、片段、通配符），工具不会自动拼接或重写地址。auth只描述Bearer或自定义认证头，密钥由工具输入。\n'
      + 'request.fields逐项将source映射到target。source可用：'+SOURCES.join(', ')+'。width/height从size拆分；fullPrompt是完整拼接正向词。type为string/number/integer/boolean。可用map对模型名等做明确的值映射，缺失值会报错，不会静默回退。常量用value，不能同时出现source。target是点分对象路径，不支持数组写入。\n'
      + '必须映射model/fullPrompt/negativePrompt/steps/scale/sampler/seed/noiseSchedule，并映射size或width+height，避免生成时静默漏参。若站点不支持必要字段，请说明，不能省略后伪装支持。JSON大小64KB内，字段路径最深8层，禁止__proto__/prototype/constructor和请求体密钥字段。\n'
      + 'response.format为json/image/zip。json须提供imagePath（数组下标用点，如data.0.b64_json）和encoding（base64或url；url也允许data:image）。非JSON不写imagePath和encoding。不会自动尝试多种请求或收费重试。\n'
      + '以下JSON Schema是结构规范，工具还会执行上述语义校验。导入通过只表示格式可读取，效果需返回原图核对。\n'+JSON.stringify(schema(),null,2)
      + '\n完整示例一（YesNAI，NAI扩展在nai里）：\n'+JSON.stringify(example('yesnai'),null,2)
      + '\n完整示例二（Aurora，顶层参数、字符串Seed）：\n'+JSON.stringify(example('aurora'),null,2)
      + '\n请等待我提供接口文档或完整的去密钥请求/响应示例，再生成文件。';
  }
  function init(options) {
    onChange = options.onChange; getPresets = options.getPresets;
    populate('');
    $('apiAdapterSelect').onchange = () => { $('apiAdapterMessage').textContent = ''; changed(); };
    for (const id of ['endpoint','apiMode']) $(id).addEventListener('input',render);
    for (const id of ['endpoint','apiMode']) $(id).addEventListener('change',render);
    $('importApiAdapter').onclick = () => $('apiAdapterFile').click();
    $('apiAdapterFile').onchange = async event => {
      try { const file = event.target.files?.[0]; if (!file) return; if (file.size > LIMIT) fail('适配文件超过64 KB'); const config = importConfig(JSON.parse(await file.text())); $('apiAdapterMessage').textContent = '已导入“'+config.name+'”；请核对地址并保存API预设。'; }
      catch (error) { $('apiAdapterMessage').textContent = '导入失败：'+error.message; }
      finally { event.target.value = ''; }
    };
    $('exportApiAdapter').onclick = () => { try { const config = selected(); if (config) download(config,config.id+'.json'); } catch (error) { $('apiAdapterMessage').textContent = error.message; } };
    $('removeApiAdapter').onclick = () => {
      try {
        const id = selectedId(); if (!id) return;
        const used = getPresets().filter(preset => preset.adapterId === id);
        if (used.length) fail('适配文件仍被API预设使用：'+used.map(preset=>preset.name).join('、')+'。请先修改或删除这些预设。');
        localStorage.setItem(KEY,JSON.stringify(list().filter(item => item.id !== id))); setSelected(''); changed(); $('apiAdapterMessage').textContent = '适配文件已移除。';
      } catch (error) { $('apiAdapterMessage').textContent = error.message; }
    };
    $('downloadAdapterExample').onclick = () => { const config = example($('adapterExampleKind').value); download(config,config.id+'.json'); };
    $('downloadAdapterSchema').onclick = () => download(schema(),'nai-lens-adapter-v1.schema.json');
    $('copyAdapterInstructions').onclick = async () => {
      try { await navigator.clipboard.writeText(aiInstructions()); $('apiAdapterMessage').textContent = '适配说明已复制；把它和站点文档一起交给AI，不需要提供密钥。'; }
      catch { $('adapterInstructionsText').value = aiInstructions(); $('adapterInstructionsFallback').hidden = false; $('adapterInstructionsText').focus(); $('adapterInstructionsText').select(); $('apiAdapterMessage').textContent = '自动复制不可用，请复制下方已选中的完整说明。'; }
    };
  }
  window.NaiAdapters = Object.freeze({validate,list,selectedId,selected,setSelected,render,requireFor,build,headers,imageValue,importConfig,example,schema,aiInstructions,init});
})();
