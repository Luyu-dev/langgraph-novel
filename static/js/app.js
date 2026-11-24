// ── hash routing ──
const routes = {home:'page-home',create:'page-create',import:'page-import',library:'page-library',trash:'page-trash',novel:'page-novel'};
const ROUTE_NAMES = new Set(Object.keys(routes));
let currentNovelId = null;
let menuReturnFocus = null;

function byId(...ids) {
  for (const id of ids) {
    const node = document.getElementById(id);
    if (node) return node;
  }
  return null;
}

function pageNode(page) {
  return (
    document.querySelector(`.page[data-page="${page}"]`) ||
    byId(routes[page] || '')
  );
}

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const page = ROUTE_NAMES.has(parts[0]) ? parts[0] : 'home';
  const param = parts[1] ? decodeURIComponent(parts[1]) : null;
  return {page, param};
}

function navigate(page, param) {
  const safePage = ROUTE_NAMES.has(page) ? page : 'home';
  const hash = param ? `#/${safePage}/${encodeURIComponent(param)}` : `#/${safePage}`;
  history.pushState(null, '', hash);
  render();
}

function normalizeUiBridge() {
  const detail = document.querySelector('.detail-content') || document.querySelector('.detail-main');
  if (detail && !document.getElementById('detail-content')) detail.id = 'detail-content';
  const tabs = document.querySelector('.detail-sidebar');
  if (tabs && !document.getElementById('detail-tabs')) tabs.id = 'detail-tabs';
  const trashList = document.querySelector('.trash-list');
  if (trashList && !document.getElementById('trash-grid')) trashList.id = 'trash-grid';
  document.querySelectorAll('[data-detail-tab]').forEach((tab) => {
    tab.classList.add('tab');
    tab.dataset.tab = tab.dataset.detailTab;
  });
  const createButton = byId('btn-create', 'create-submit');
  if (createButton) createButton.id = 'btn-create';
  const importButton = byId('btn-import', 'import-submit');
  if (importButton) importButton.id = 'btn-import';
  const reconstruct = byId('import-ai-reconstruct', 'import-reconstruct');
  if (reconstruct) reconstruct.id = 'import-ai-reconstruct';
}

function render() {
  normalizeUiBridge();
  const {page, param} = parseRoute();
  document.body.dataset.route = page;
  document.querySelectorAll('.page').forEach((section) => {
    const active = section.dataset.page === page || section.id === routes[page];
    section.classList.toggle('active', active);
    section.classList.toggle('is-active', active);
  });
  document.querySelectorAll('[data-nav]').forEach((button) => {
    const active = button.dataset.nav === page || (page === 'novel' && button.dataset.nav === 'library');
    button.classList.toggle('active', active);
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.querySelectorAll('header nav a').forEach((a) => a.classList.remove('active', 'is-active'));
  const nav = byId('nav-' + page);
  if (nav) nav.classList.add('active', 'is-active');

  closeMobileMenu(false);
  if (page === 'library') loadLibrary();
  if (page === 'trash') loadTrash();
  if (page === 'novel') {
    if (param) {
      currentNovelId = param;
      loadNovel(param);
    } else {
      navigate('library');
      return;
    }
  }
  const titles = {
    home: '首页',
    create: '创立新小说',
    import: '导入 TXT',
    library: '小说库',
    trash: '回收站',
    novel: '小说详情',
  };
  document.title = `${titles[page] || '创作台'} | 小说创作工作台`;
  window.scrollTo({top: 0, left: 0, behavior: 'auto'});
}

function openOverlay(...ids) {
  const el = byId(...ids);
  if (!el) return false;
  el.hidden = false;
  el.classList.add('active');
  document.body.classList.add('modal-open');
  return true;
}

function closeOverlay(...ids) {
  const el = byId(...ids);
  if (!el) return false;
  el.hidden = true;
  el.classList.remove('active');
  if (!document.querySelector('.modal-overlay.active, .modal-backdrop:not([hidden])')) {
    document.body.classList.remove('modal-open');
  }
  return true;
}

function closeMobileMenu(restoreFocus = true) {
  const menu = byId('mobile-menu');
  const toggle = byId('menu-toggle');
  if (!menu) return;
  menu.hidden = true;
  menu.classList.remove('is-open');
  document.body.classList.remove('nav-open');
  toggle?.setAttribute('aria-expanded', 'false');
  if (restoreFocus && menuReturnFocus instanceof HTMLElement) menuReturnFocus.focus();
  menuReturnFocus = null;
}

function toggleMobileMenu() {
  const menu = byId('mobile-menu');
  const toggle = byId('menu-toggle');
  if (!menu || !toggle) return;
  const opening = menu.hidden;
  menu.hidden = !opening;
  menu.classList.toggle('is-open', opening);
  document.body.classList.toggle('nav-open', opening);
  toggle.setAttribute('aria-expanded', String(opening));
  if (opening) {
    menuReturnFocus = toggle;
    menu.querySelector('button')?.focus();
  } else {
    closeMobileMenu();
  }
}

const S_PROVIDERS = {
  openai: {base_url: "https://api.openai.com/v1", model: "gpt-4o-mini"},
  deepseek: {base_url: "https://api.deepseek.com", model: "deepseek-chat"},
  custom: {base_url: "", model: ""},
};

function settingsElements() {
  return {
    provider: byId('s-provider', 'provider'),
    key: byId('s-key', 'api-key'),
    model: byId('s-model', 'model'),
    baseUrl: byId('s-base-url', 'base-url'),
  };
}

function loadSettings() {
  var s = JSON.parse(localStorage.getItem("novel_settings") || "{}");
  var els = settingsElements();
  if (els.provider) els.provider.value = s.provider || "openai";
  if (els.key) els.key.value = s.api_key || "";
  if (els.model) els.model.value = s.model || S_PROVIDERS[s.provider]?.model || "gpt-4o-mini";
  if (els.baseUrl) els.baseUrl.value = s.base_url || S_PROVIDERS[s.provider]?.base_url || "";
}

function showSettings() {
  loadSettings();
  openOverlay('settings-overlay', 'settings-modal');
  byId('s-provider', 'provider')?.focus();
}

function hideSettings() {
  closeOverlay('settings-overlay', 'settings-modal');
}

function onProviderChange() {
  var els = settingsElements();
  var p = els.provider?.value || 'openai';
  var preset = S_PROVIDERS[p];
  if (preset && p !== "custom") {
    if (els.model) els.model.value = preset.model;
    if (els.baseUrl) els.baseUrl.value = preset.base_url;
  }
}

function saveSettings() {
  var els = settingsElements();
  localStorage.setItem("novel_settings", JSON.stringify({
    provider: els.provider?.value || 'openai',
    api_key: els.key?.value || '',
    model: els.model?.value || '',
    base_url: els.baseUrl?.value || '',
  }));
  hideSettings();
}

function getSettingsHeaders(){
  var s = JSON.parse(localStorage.getItem("novel_settings") || "{}");
  var h = {};
  if(s.api_key) h["X-API-Key"] = s.api_key;
  if(s.model) h["X-Model"] = s.model;
  if(s.base_url) h["X-Base-URL"] = s.base_url;
  return h;
}

async function readError(r, fallback){
  var text = await r.text();
  if(!text) return fallback || "请求失败";
  try{
    var data = JSON.parse(text);
    return data.detail || data.error || fallback || "请求失败";
  }catch(e){
    return text.slice(0, 500) || fallback || "请求失败";
  }
}

// ── create novel ──
var selectedGenre = 'urban';
var genreDescs = {
  urban:'现代都市为舞台，涵盖异能、系统、重生、职场、校园等子类。',
  wuxia:'古代或架空江湖世界，以内功、门派、武林争霸为核心。',
  xianxia:'以修真修仙为核心，境界突破、渡劫飞升、仙魔之争。',
  mystery:'以解谜破案为核心，包含本格推理、悬疑惊悚、都市怪谈等。',
  romance:'以校园或青春为舞台，聚焦情感发展和人际关系。',
  fanfic:'主角进入某个已有小说或动漫世界，在原作世界里展开新的故事。',
};
function selectGenre(el){
  var value = el.dataset.genre || el.value || 'urban';
  selectedGenre = value;
  document.querySelectorAll('.genre-opt').forEach(function(g){g.classList.remove('active');});
  document.querySelectorAll('.genre-option').forEach(function(g){
    var input = g.querySelector('input[name="genre"]');
    g.classList.toggle('is-selected', input?.value === value);
  });
  el.classList.add('active');
  var checked = document.querySelector('input[name="genre"][value="' + value + '"]');
  if (checked) checked.checked = true;
  var desc = document.getElementById('genre-desc');
  if(desc) desc.textContent = genreDescs[selectedGenre] || '';
  var fb = byId('fanfic-block', 'fanfic-fields');
  if(fb){
    fb.hidden = selectedGenre !== 'fanfic';
    fb.style.display = selectedGenre === 'fanfic' ? 'block' : 'none';
  }
}
async function createNovel(){
  var checkedGenre = document.querySelector('input[name="genre"]:checked');
  if(checkedGenre) selectedGenre = checkedGenre.value;
  const title = document.getElementById('novel-title').value;
  const idea = document.getElementById('novel-idea').value;
  const sourceTitleEl = document.getElementById('fanfic-title');
  const sourceSummaryEl = document.getElementById('fanfic-summary');
  if(!idea.trim()){ setStatus('请填写创意','error'); return; }
  if(selectedGenre === 'fanfic' && !(sourceTitleEl && sourceTitleEl.value.trim()) && !(sourceSummaryEl && sourceSummaryEl.value.trim())){
    setStatus('同人文请填写原作名称或设定摘要','error');
    return;
  }
  const btn = document.getElementById('btn-create');
  btn.disabled=true; btn.textContent='生成中...'; setStatus('正在提交生成任务...','info');
  try{
    const r = await fetch('/api/novels',{
      method:'POST',
      headers: Object.assign({'Content-Type':'application/json'}, getSettingsHeaders()),
      body:JSON.stringify({
        title,
        idea,
        genre:selectedGenre,
        source_title: sourceTitleEl ? sourceTitleEl.value : "",
        source_summary: sourceSummaryEl ? sourceSummaryEl.value : "",
      })
    });
    if(!r.ok){ const e=await r.json(); throw new Error(e.detail||'请求失败'); }
    const data = await r.json();
    localStorage.setItem('createJobId', data.job_id);
    pollCreateJob(data.job_id);
  }catch(e){
    setStatus('生成失败：'+e.message,'error');
    btn.disabled=false; btn.textContent='开始生成';
  }
}

async function pollCreateJob(jobId){
  const btn = document.getElementById('btn-create');
  try{
    const r = await fetch('/api/create-jobs/'+jobId);
    const job = await r.json();
    if(job.status === 'done'){
      localStorage.removeItem('createJobId');
      setStatus('生成成功，正在打开...','ok');
      if(btn){ btn.disabled=false; btn.textContent='开始生成'; }
      setTimeout(()=>navigate('novel',job.novel_id),500);
      return;
    }
    if(job.status === 'error' || job.status === 'missing'){
      localStorage.removeItem('createJobId');
      setStatus(job.error || job.message || '生成失败','error');
      if(btn){ btn.disabled=false; btn.textContent='开始生成'; }
      return;
    }
    if(btn){ btn.disabled=true; btn.textContent='生成中...'; }
    setStatus((job.message || '正在生成设定...') + ' 刷新页面后会自动恢复进度。','info');
    setTimeout(function(){ pollCreateJob(jobId); }, 2000);
  }catch(e){
    setStatus('正在等待后端响应，稍后自动重试...','info');
    setTimeout(function(){ pollCreateJob(jobId); }, 3000);
  }
}

function resumeCreateJob(){
  const jobId = localStorage.getItem('createJobId');
  if(!jobId) return;
  const page = location.hash.replace('#/','').split('/')[0] || 'home';
  if(page !== 'create') return;
  const btn = document.getElementById('btn-create');
  if(btn){ btn.disabled=true; btn.textContent='生成中...'; }
  pollCreateJob(jobId);
}

function setStatus(msg,type){
  const el=document.getElementById('create-status');
  if(!el) return;
  el.hidden=false;
  el.textContent=msg;
  el.className='form-status' + (type==='error'?' is-error':type==='ok'?' is-success':'');
}

function setImportStatus(msg,type){
  const el=document.getElementById('import-status');
  if(!el) return;
  el.hidden=false;
  el.textContent=msg;
  el.className='form-status' + (type==='error'?' is-error':type==='ok'?' is-success':'');
}

function readImportFile(){
  const file = document.getElementById('import-file').files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = function(){
    document.getElementById('import-text').value = reader.result || '';
    if(!document.getElementById('import-title').value.trim()){
      document.getElementById('import-title').value = file.name.replace(/\.txt$/i,'');
    }
    setImportStatus('已读取文件：'+file.name,'ok');
  };
  reader.onerror = function(){ setImportStatus('读取文件失败，请直接粘贴 TXT 内容。','error'); };
  reader.readAsText(file, 'utf-8');
}

async function importTxtNovel(){
  const title = document.getElementById('import-title').value;
  const text = document.getElementById('import-text').value;
  const aiReconstruct = byId('import-ai-reconstruct', 'import-reconstruct')?.checked !== false;
  if(!text.trim()){ setImportStatus('请先选择 TXT 文件或粘贴正文','error'); return; }
  const btn = document.getElementById('btn-import');
  if(btn){ btn.disabled = true; btn.textContent = aiReconstruct ? 'AI 建档中...' : '导入中...'; }
  setImportStatus(aiReconstruct ? '正在拆分章节，并根据正文重建世界观、角色卡、大纲和剧情圣经...' : '正在拆分章节并写入小说库...','info');
  try{
    const r = await fetch('/api/import-txt', {
      method:'POST',
      headers:Object.assign({'Content-Type':'application/json'}, getSettingsHeaders()),
      body:JSON.stringify({title:title, text:text, genre:selectedGenre || '', ai_reconstruct: aiReconstruct}),
    });
    if(!r.ok){ const e = await r.json(); throw new Error(e.detail || '导入失败'); }
    const data = await r.json();
    var msg = '导入成功，共 '+data.chapter_count+' 章';
    if(aiReconstruct && data.reconstructed) msg += '，AI 档案已重建';
    if(aiReconstruct && !data.reconstructed) msg += '，但 AI 建档失败，已保留基础导入';
    setImportStatus(msg+'，正在打开...','ok');
    document.getElementById('import-text').value = '';
    setTimeout(function(){ navigate('novel', data.id); }, 500);
  }catch(e){
    setImportStatus('导入失败：'+e.message,'error');
  }
  if(btn){ btn.disabled = false; btn.textContent = '拆章并导入'; }
}

// ── library ──
async function loadLibrary(){
  const grid=document.getElementById('library-grid');
  try{
    const r=await fetch('/api/novels');
    const novels=await r.json();
    const count = document.getElementById('library-count');
    if(count) count.textContent = `${novels.length} 部作品`;
    if(!novels.length){
      grid.innerHTML='<div class="empty-state"><i class="ph ph-books" aria-hidden="true"></i><h2>还没有小说</h2><p>从一句创意开始，或者先导入一本已有 TXT。</p></div>';
      return;
    }
    grid.innerHTML=novels.map(n=>`
      <article class="novel-card" data-title="${esc(n.title)}" data-idea="${esc(n.idea_preview||'')}" data-novel-id="${n.id}">
        <button class="novel-cover cover-generated" type="button" onclick="navigate('novel','${n.id}')">
          <span class="cover-tag">${esc(n.genre || '小说')}</span>
          <strong>${esc(n.title)}</strong>
          <small>${esc((n.created_at || '').slice(0,10))}</small>
        </button>
        <div class="novel-card-body">
          <div class="card-title-row">
            <div><h2>${esc(n.title)}</h2><span>${esc((n.created_at || '').slice(0,10))}</span></div>
            <button class="icon-button card-menu" type="button" aria-label="移入回收站" onclick="event.stopPropagation();deleteNovelFromList('${n.id}')">
              <i class="ph ph-trash" aria-hidden="true"></i>
            </button>
          </div>
          <p>${esc(n.idea_preview||'暂无创意摘要')}${(n.idea_preview||'').length>=80?'...':''}</p>
          <div class="novel-meta">
            <span><i class="ph ph-file-text" aria-hidden="true"></i>${Number(n.chapter_count||0)} 章正文</span>
            <span><i class="ph ph-clock" aria-hidden="true"></i>最近编辑</span>
          </div>
          <button class="text-link" type="button" onclick="navigate('novel','${n.id}')">打开小说 <i class="ph ph-arrow-right" aria-hidden="true"></i></button>
        </div>
      </article>
    `).join('');
    applyLibrarySearch();
  }catch(e){grid.innerHTML='<div style="text-align:center;padding:40px;color:#ef4444">加载失败</div>';}
}

async function deleteNovelFromList(id){
  if(!confirm('确定把这篇小说移入回收站？'))return;
  await fetch('/api/novels/'+id,{method:'DELETE'});
  loadLibrary();
}

async function loadTrash(){
  const grid=document.getElementById('trash-grid');
  try{
    const r=await fetch('/api/deleted-novels');
    const novels=await r.json();
    if(!novels.length){
      grid.innerHTML='<div class="empty-state"><i class="ph ph-trash" aria-hidden="true"></i><h2>回收站为空</h2><p>删除的作品会先出现在这里。</p></div>';
      return;
    }
    grid.innerHTML=novels.map(function(n){
      var deleted = n.deleted_at ? n.deleted_at.slice(0,16).replace('T',' ') : '';
      return '<article class="trash-item">'
        + '<span class="trash-icon"><i class="ph ph-file-x" aria-hidden="true"></i></span>'
        + '<div class="trash-copy"><div><h2>'+esc(n.title)+'</h2><span>删除于 '+esc(deleted)+'</span></div>'
        + '<p>'+esc(n.idea_preview||'暂无创意摘要')+((n.idea_preview||'').length>=80?'...':'')+'</p>'
        + '<small>'+Number(n.chapter_count||0)+' 章正文 · 可恢复</small></div>'
        + '<div class="trash-actions">'
        + '<button class="button button-secondary button-sm" onclick="restoreDeletedNovel(\''+esc(n.file)+'\')">恢复</button>'
        + '<button class="button button-danger-subtle button-sm" onclick="purgeDeletedNovel(\''+esc(n.file)+'\')">永久删除</button>'
        + '</div></article>';
    }).join('');
  }catch(e){grid.innerHTML='<div style="text-align:center;padding:40px;color:#ef4444">加载回收站失败</div>';}
}

async function restoreDeletedNovel(file){
  try{
    var r = await fetch('/api/deleted-novels/'+encodeURIComponent(file)+'/restore', {method:'POST'});
    if(!r.ok) throw new Error((await r.json()).detail || '恢复失败');
    var data = await r.json();
    alert('已恢复到小说库');
    navigate('novel', data.id);
  }catch(e){ alert('恢复失败: '+e.message); }
}

async function purgeDeletedNovel(file){
  if(!confirm('确定永久删除？这个操作无法从回收站恢复。')) return;
  try{
    var r = await fetch('/api/deleted-novels/'+encodeURIComponent(file), {method:'DELETE'});
    if(!r.ok) throw new Error((await r.json()).detail || '永久删除失败');
    loadTrash();
  }catch(e){ alert('永久删除失败: '+e.message); }
}

// ── novel detail ──
let novelData=null;

async function loadNovel(id){
  currentNovelId = id;
  editMode = false;
  setEditModeUi(false);
  try{
    const r=await fetch('/api/novels/'+id);
    if(!r.ok) throw new Error(await readError(r, '加载小说失败'));
    novelData=await r.json();
    byId('novel-title-display', 'novel-detail-title')?.replaceChildren(document.createTextNode(novelData.title || '未命名小说'));
    const titleText = novelData.title || '未命名小说';
    document.title = `${titleText} | 小说创作工作台`;
    const kicker = document.querySelector('.novel-title-row .page-kicker');
    if(kicker) kicker.textContent = `${novelData.genre || '小说'} · 创作中`;
    const metadata = document.querySelector('.novel-title-row > div > p:not(.page-kicker)');
    if(metadata){
      const count = Array.isArray(novelData.chapters) ? novelData.chapters.filter(Boolean).length : 0;
      metadata.textContent = `最近编辑 · ${count} 章正文 · ${Array.isArray(novelData.outline) ? novelData.outline.length : 0} 章大纲`;
    }
    switchTab(currentTab || 'world');
    resumeBatchProgress();
  }catch(e){
    const content = document.getElementById('detail-content');
    if(content) content.innerHTML='<div class="empty-state"><i class="ph ph-warning-circle"></i><h2>小说加载失败</h2><p>'+esc(e.message)+'</p></div>';
  }
}

var currentTab = "world";
function switchTab(tab){currentTab=tab;
  document.querySelectorAll('#detail-tabs .tab, #detail-tabs [data-detail-tab]').forEach(function(t){
    var target = t.dataset.tab || t.dataset.detailTab;
    t.classList.toggle('active',target===tab);
    t.classList.toggle('is-active',target===tab);
    if(target===tab) t.setAttribute('aria-current','page');
    else t.removeAttribute('aria-current');
  });
  const el=document.getElementById('detail-content');
  if(el) el.classList.add('detail-main');
  if(!el) return;
  if(!novelData){el.innerHTML='';return;}
  if(tab==='world') el.innerHTML=renderWorld(novelData.world_setting);
  else if(tab==='characters') el.innerHTML=renderCharacters(novelData.characters);
  else if(tab==='outline') el.innerHTML=renderOutlineTab();
  else if(tab==='bible') el.innerHTML=renderStoryBible(novelData.story_bible);
  else if(tab==='chapters') el.innerHTML=renderChapters(novelData.chapters);
  else if(tab==='audit') el.innerHTML=renderAudit(novelData.audit_report);
}

// 大纲页：篇章大纲 / 章节大纲 子标签
var outlineSubTab = 'volume'
function switchOutlineSub(sub){
  // 编辑态切换前，先把当前表单内容同步进 editData，避免丢失
  if(editMode && typeof syncOutlineFromDOM==='function') syncOutlineFromDOM();
  outlineSubTab = sub;
  document.getElementById('detail-content').innerHTML = renderOutlineTab();
}

function outlineSubTabsBar(){
  function tab(id,label){
    var active = outlineSubTab===id;
    return '<button onclick="switchOutlineSub(\''+id+'\')" style="'
      + 'font-size:14px;padding:8px 18px;border:none;cursor:pointer;border-radius:8px;'
      + (active?'background:var(--c-primary);color:#fff;font-weight:600':'background:none;color:var(--c-muted)')
      + '">'+label+'</button>';
  }
  return '<div style="display:inline-flex;gap:4px;background:var(--c-bg);padding:4px;border-radius:10px;margin-bottom:16px;border:1px solid var(--c-border)">'
    + tab('volume','📖 篇章大纲') + tab('pacing','⏱ 节奏段落') + tab('chapter','📑 章节大纲') + '</div>';
}

function renderOutlineTab(){
  var head = '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap"><h2 style="margin:0">&#128221; 大纲</h2>'+outlineSubTabsBar()+'</div>';
  if(outlineSubTab==='volume') return head + renderVolumeSection();
  if(outlineSubTab==='pacing') return head + renderPacingSection(novelData.pacing_outline);
  return head + (editMode ? renderOutline(novelData.outline) : renderOutlineRead(novelData.outline));
}

// 篇章大纲区（读/编辑两态）
function renderVolumeSection(){
  var vols = getVolumeOutlines(editMode && editData ? editData : novelData);
  if(editMode && editData){
    return '<p style="color:var(--c-muted);font-size:12px;margin-bottom:12px">修改后点击「保存」生效</p>'
      + '<div style="margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap">'
      + '<button class="btn btn-secondary" onclick="addVolumeOutline()" style="font-size:13px;padding:7px 14px">+ 新增篇章</button>'
      + '</div>'
      + renderVolumeEditList(vols);
  }
  var cards = renderVolumeCardList(vols);
  return cards || '<p style="color:var(--c-muted);padding:20px">暂无篇章大纲。这可能是较早创建的小说；点击「编辑」可手动补充，或重新创建小说自动生成。</p>';
}

function renderPacingSection(beats){
  if(!beats || !beats.length) return '<p style="color:var(--c-muted);padding:20px">暂无节奏段落。新建小说或续写大纲后会自动补齐。</p>';
  return '<div style="display:grid;gap:12px;margin-top:8px">'
    + beats.map(function(b){return '<div class="chapter-item">'
      + '<h4>'+esc(b.name||'节奏段')+' <span style="font-weight:400;color:var(--c-muted);font-size:12px">第 '+(b.chapter_start||'?')+'-'+(b.chapter_end||'?')+' 章</span></h4>'
      + '<div class="field"><div class="field-label">叙事作用</div><div class="field-value">'+esc(b.purpose||'')+'</div></div>'
      + '<div class="field"><div class="field-label">关键转折</div><div class="field-value">'+esc(b.major_turning_point||'')+'</div></div>'
      + '<div class="field"><div class="field-label">张力目标</div><div class="field-value">'+esc(b.tension_goal||'')+'</div></div>'
      + '</div>';}).join('')
    + '</div>';
}

function renderStoryBible(bible){
  bible = bible || {};
  function listBlock(title, items){
    if(!items || !items.length) return '';
    return '<div class="chapter-item"><h4>'+title+'</h4>'
      + items.map(function(x){
        if(typeof x === 'object'){
          return '<div class="field-value" style="margin-bottom:6px">'+Object.keys(x).map(function(k){return '<b>'+esc(k)+'</b>：'+esc(x[k]||'');}).join('　')+'</div>';
        }
        return '<div class="field-value">• '+esc(x)+'</div>';
      }).join('')
      + '</div>';
  }
  var html = '<h2>&#128220; 剧情圣经</h2>';
  html += bible.last_chapter_summary ? '<div class="field"><div class="field-label">上一章摘要</div><div class="field-value">'+esc(bible.last_chapter_summary)+'</div></div>' : '';
  html += bible.continuity_notes ? '<div class="field"><div class="field-label">连续性备注</div><div class="field-value">'+esc(bible.continuity_notes)+'</div></div>' : '';
  html += listBlock('时间线', bible.timeline);
  html += listBlock('章节事件账本', bible.chapter_events);
  html += listBlock('重复记忆黑名单', bible.blacklist);
  html += listBlock('人物状态', bible.character_states);
  html += listBlock('未回收伏笔', bible.open_threads);
  html += listBlock('已回收伏笔', bible.resolved_threads);
  html += listBlock('地点与重要物件', bible.locations);
  return html === '<h2>&#128220; 剧情圣经</h2>' ? html + '<p style="color:var(--c-muted);padding:20px">暂无剧情记忆。生成章节后会自动更新。</p>' : html;
}

function renderWorld(ws){
  if(editMode && editData && editData.world_setting){
    var ews = editData.world_setting;
    return '<h2>&#127758; 世界观</h2>'
      + '<div class="field"><div class="field-label">名称</div><input data-wf="name" value="'+esc(ews.name||"")+'" style="width:100%;padding:8px 10px;border:1px solid var(--c-border);border-radius:6px"></div>'
      + '<div class="field"><div class="field-label">题材</div><input data-wf="genre" value="'+esc(ews.genre||"")+'" style="width:100%;padding:8px 10px;border:1px solid var(--c-border);border-radius:6px"></div>'
      + '<div class="field"><div class="field-label">核心设定</div><textarea data-wf="premise" rows="2" style="width:100%;padding:8px 10px;border:1px solid var(--c-border);border-radius:6px;font-family:inherit">'+esc(ews.premise||"")+'</textarea></div>'
      + '<div class="field"><div class="field-label">世界规则</div><textarea data-wf="rules" rows="3" style="width:100%;padding:8px 10px;border:1px solid var(--c-border);border-radius:6px;font-family:inherit">'+esc(ews.rules||"")+'</textarea></div>'
      + '<div class="field"><div class="field-label">力量体系</div><textarea data-wf="power_system" rows="3" style="width:100%;padding:8px 10px;border:1px solid var(--c-border);border-radius:6px;font-family:inherit">'+esc(ews.power_system||"")+'</textarea></div>'
      + '<div class="field"><div class="field-label">风格基调</div><input data-wf="tone" value="'+esc(ews.tone||"")+'" style="width:100%;padding:8px 10px;border:1px solid var(--c-border);border-radius:6px"></div>'
      + '<div class="field"><div class="field-label">关键地点（每行一个）</div><textarea id="edit-locations" rows="3" style="width:100%;padding:8px 10px;border:1px solid var(--c-border);border-radius:6px;font-family:inherit">'+esc((ews.locations||[]).join("\n"))+'</textarea></div>'
      + '<div class="field"><div class="field-label">势力（每行一个）</div><textarea id="edit-factions" rows="3" style="width:100%;padding:8px 10px;border:1px solid var(--c-border);border-radius:6px;font-family:inherit">'+esc((ews.factions||[]).join("\n"))+'</textarea></div>';
  }
  if(!ws) return '<p>暂无世界观设定</p>';
  const fields=[
    ['名称',ws.name],[,'题材',ws.genre],['核心设定',ws.premise],
    ['世界规则',ws.rules],['力量体系',ws.power_system],['风格基调',ws.tone],
  ];
  let html='<h2>&#127758; 世界观</h2>'+
    fields.map(([l,v])=>v?`<div class="field"><div class="field-label">${l}</div><div class="field-value">${esc(v)}</div></div>`:'').join('');
  if(ws.locations&&ws.locations.length)
    html+=`<div class="field"><div class="field-label">关键地点</div><div class="field-value">${ws.locations.map(l=>'• '+esc(l)).join('<br>')}</div></div>`;
  if(ws.factions&&ws.factions.length)
    html+=`<div class="field"><div class="field-label">势力</div><div class="field-value">${ws.factions.map(f=>'• '+esc(f)).join('<br>')}</div></div>`;
  return html;
}

function renderCharacters(chars){
  if(editMode && editData && editData.characters){
    var ec = editData.characters;
    if(!ec||!ec.length) ec=[];
    var charHtml = '<h2>&#128100; 角色卡</h2>'
      + '<p style="color:var(--c-muted);font-size:12px;margin-bottom:12px">修改后点击「保存」生效</p>' + '<button class="btn btn-secondary" onclick="addCharacter()" style="font-size:13px;padding:6px 16px;margin-bottom:14px">添加角色</button>'
      + ec.map(function(c,i){return '<div class="char-item char-edit" id="char-'+i+'"><div style="display:flex;justify-content:space-between;align-items:center"><h4>角色 '+(i+1)+'</h4><button onclick="removeCharacter('+i+')" style="font-size:11px;border:none;background:none;color:#ef4444;cursor:pointer">删除</button></div>'
        + '<div class="field"><div class="field-label">姓名</div><input data-cf="name" value="'+esc(c.name||"")+'" style="width:100%;padding:6px 8px;border:1px solid var(--c-border);border-radius:6px"></div>'
        + '<div class="field"><div class="field-label">角色</div><input data-cf="role" value="'+esc(c.role||"")+'" style="width:100%;padding:6px 8px;border:1px solid var(--c-border);border-radius:6px"></div>'
        + '<div class="field"><div class="field-label">性格原型</div><input data-cf="archetype" value="'+esc(c.archetype||"")+'" style="width:100%;padding:6px 8px;border:1px solid var(--c-border);border-radius:6px"></div>'
        + '<div class="field"><div class="field-label">外貌</div><input data-cf="appearance" value="'+esc(c.appearance||"")+'" style="width:100%;padding:6px 8px;border:1px solid var(--c-border);border-radius:6px"></div>'
        + '<div class="field"><div class="field-label">性格</div><textarea data-cf="personality" rows="2" style="width:100%;padding:6px 8px;border:1px solid var(--c-border);border-radius:6px;font-family:inherit">'+esc(c.personality||"")+'</textarea></div>'
        + '<div class="field"><div class="field-label">背景</div><textarea data-cf="background" rows="2" style="width:100%;padding:6px 8px;border:1px solid var(--c-border);border-radius:6px;font-family:inherit">'+esc(c.background||"")+'</textarea></div>'
        + '<div class="field"><div class="field-label">动机</div><input data-cf="motivation" value="'+esc(c.motivation||"")+'" style="width:100%;padding:6px 8px;border:1px solid var(--c-border);border-radius:6px"></div>'
        + '<div class="field"><div class="field-label">能力</div><textarea data-cf="abilities" rows="2" style="width:100%;padding:6px 8px;border:1px solid var(--c-border);border-radius:6px;font-family:inherit">'+esc(c.abilities||"")+'</textarea></div>'
        + '<div class="field"><div class="field-label">缺陷</div><input data-cf="flaws" value="'+esc(c.flaws||"")+'" style="width:100%;padding:6px 8px;border:1px solid var(--c-border);border-radius:6px"></div>'
        + '<div class="field"><div class="field-label">成长弧线</div><textarea data-cf="arc" rows="2" style="width:100%;padding:6px 8px;border:1px solid var(--c-border);border-radius:6px;font-family:inherit">'+esc(c.arc||"")+'</textarea></div>'
        + '</div>';
      }).join('') + '<div style="margin-top:12px"><button class="btn btn-secondary" onclick="addCharacter()" style="font-size:13px;padding:6px 16px">+ 添加角色</button></div>';
    return charHtml;
  }
  if(!chars||!chars.length) return '<p>暂无角色设定</p>';
  var charHtml = '<h2>&#128100; 角色卡</h2>'+
    chars.map(c=>{
      const tags=[]
      if(c.role) tags.push(c.role);
      if(c.archetype) tags.push(c.archetype);
      return `<div class="char-item">
        <h4>${esc(c.name||"")} ${tags.map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</h4>
        ${c.appearance?`<div style="font-size:13px;color:var(--c-muted);margin-bottom:6px">${esc(c.appearance||"")}</div>`:''}
        <div class="field"><div class="field-label">性格</div><div class="field-value">${esc(c.personality||'')}</div></div>
        <div class="field"><div class="field-label">背景</div><div class="field-value">${esc(c.background||'')}</div></div>
        <div class="field"><div class="field-label">动机</div><div class="field-value">${esc(c.motivation||'')}</div></div>
        <div class="field"><div class="field-label">能力</div><div class="field-value">${esc(c.abilities||'')}</div></div>
        <div class="field"><div class="field-label">缺陷</div><div class="field-value">${esc(c.flaws||'')}</div></div>
        <div class="field"><div class="field-label">成长弧线</div><div class="field-value">${esc(c.arc||'')}</div></div>
     </div>`;
    }).join('');
    return charHtml;
}

// ── 篇章大纲卡片（读态）──
function getVolumeOutlines(data){
  data = data || {};
  if(Array.isArray(data.volume_outlines) && data.volume_outlines.length) return data.volume_outlines;
  if(data.volume_outline && Object.keys(data.volume_outline).length) return [data.volume_outline];
  return [];
}

function syncPrimaryVolume(data){
  data.volume_outlines = getVolumeOutlines(data);
  data.volume_outline = data.volume_outlines[0] || {};
  return data;
}

function renderVolumeCardList(vols){
  return (vols || []).map(function(vol,i){ return renderVolumeCard(vol, i); }).join('');
}

function renderVolumeCard(vol){
  if(!vol || !vol.name) return '';
  var ev = (vol.key_events&&vol.key_events.length)
    ? '<div class="field"><div class="field-label">关键事件</div><div class="field-value">'+vol.key_events.map(function(e){return '• '+esc(e);}).join('<br>')+'</div></div>' : '';
  return '<div class="chapter-item" style="border-left:3px solid var(--c-primary);background:var(--c-bg)">'
    + '<h4 style="color:var(--c-primary)">📖 '+esc(vol.name||'')+'　<span style="font-weight:400;color:var(--c-muted);font-size:12px">第 '+(vol.chapter_start||'?')+'-'+(vol.chapter_end||'?')+' 章</span></h4>'
    + '<div class="field" style="margin-top:6px"><div class="field-label">整体走向</div><div class="field-value">'+esc(vol.arc||'')+'</div></div>'
    + '<div class="field"><div class="field-label">核心矛盾</div><div class="field-value">'+esc(vol.core_conflict||'')+'</div></div>'
    + '<div class="field"><div class="field-label">高潮</div><div class="field-value">'+esc(vol.climax||'')+'</div></div>'
    + ev + '</div>';
}

// ── 篇章大纲卡片（编辑态）──
function renderVolumeEditList(vols){
  if(!vols || !vols.length) vols = [{}];
  return vols.map(function(vol,i){ return renderVolumeEdit(vol, i); }).join('');
}

function renderVolumeEdit(vol, idx){
  vol = vol || {};
  var st='width:100%;padding:6px 8px;border:1px solid var(--c-border);border-radius:6px';
  return '<div class="chapter-item vol-edit" data-vol-idx="'+idx+'" style="border-left:3px solid var(--c-primary);background:var(--c-bg)">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">'
    + '<h4 style="color:var(--c-primary)">📖 篇章大纲 '+(idx+1)+'</h4>'
    + '<button onclick="removeVolumeOutline('+idx+')" style="font-size:11px;border:none;background:none;color:#ef4444;cursor:pointer">删除</button></div>'
    + '<div class="field"><div class="field-label">篇章名称</div><input data-vf="name" value="'+esc(vol.name||'')+'" style="'+st+'"></div>'
    + '<div style="display:flex;gap:8px">'
    + '<div class="field" style="flex:1"><div class="field-label">起始章</div><input data-vf="chapter_start" type="number" value="'+(vol.chapter_start||1)+'" style="'+st+'"></div>'
    + '<div class="field" style="flex:1"><div class="field-label">结束章</div><input data-vf="chapter_end" type="number" value="'+(vol.chapter_end||40)+'" style="'+st+'"></div></div>'
    + '<div class="field"><div class="field-label">整体走向</div><textarea data-vf="arc" rows="3" style="'+st+';font-family:inherit">'+esc(vol.arc||'')+'</textarea></div>'
    + '<div class="field"><div class="field-label">核心矛盾</div><input data-vf="core_conflict" value="'+esc(vol.core_conflict||'')+'" style="'+st+'"></div>'
    + '<div class="field"><div class="field-label">高潮</div><input data-vf="climax" value="'+esc(vol.climax||'')+'" style="'+st+'"></div>'
    + '<div class="field"><div class="field-label">关键事件（每行一个）</div><textarea data-vf="key_events" rows="4" style="'+st+';font-family:inherit">'+esc((vol.key_events||[]).join("\n"))+'</textarea></div>'
    + '</div>';
}

// ── AI 续写 / 手动添加 章节大纲的按钮区 ──
function outlineActionsBar(){
  return '<div style="margin:14px 0;display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
    + '<input type="number" id="expand-count" value="5" min="1" max="20" style="width:64px;padding:6px 8px;border:1px solid var(--c-border);border-radius:6px">'
    + '<button class="btn btn-primary" onclick="expandOutline()" id="expand-btn" style="font-size:13px;padding:8px 16px">✨ AI 续写章节大纲</button>'
    + (editMode?'<button class="btn btn-secondary" onclick="addOutlineChapter()" style="font-size:13px;padding:8px 16px">+ 手动添加空白章</button>':'')
    + '<button class="btn btn-secondary" onclick="toggleOutlineSelectMode()" id="outline-select-btn" style="font-size:13px;padding:8px 16px">'+(outlineSelectMode?'退出多选':'多选删除')+'</button>'
    + '<button class="btn btn-secondary" onclick="selectAllOutlineChapters()" id="outline-select-all-btn" style="font-size:13px;padding:8px 16px;display:'+(outlineSelectMode?'inline-block':'none')+'">全选大纲</button>'
    + '<button class="btn btn-secondary" onclick="clearOutlineSelection()" id="outline-clear-btn" style="font-size:13px;padding:8px 16px;display:'+(outlineSelectMode?'inline-block':'none')+'">清空选择</button>'
    + '<button class="btn btn-primary" onclick="deleteSelectedOutlines()" id="outline-delete-selected-btn" style="font-size:13px;padding:8px 16px;display:'+(outlineSelectMode?'inline-block':'none')+';background:#ef4444">删除所选</button>'
    + '</div>';
}

function renderOutline(outline){
  var chapters = (novelData && novelData.chapters) || [];
  var chStatus = {};
  chapters.forEach(function(c,i){ if(c && c.trim()) chStatus[i]=true; });

  if(editMode && editData && editData.outline){
    var eol = editData.outline;
    return '<p style="color:var(--c-muted);font-size:12px;margin:12px 0">修改后点击「保存」生效</p>'
      + outlineActionsBar()
      + eol.map(function(ch,i){return '<div class="chapter-item ch-edit" data-cn="'+(i+1)+'">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px">'
        + '<label class="outline-select-control" style="display:'+(outlineSelectMode?'inline-flex':'none')+';font-size:13px;color:var(--c-muted);align-items:center;gap:6px"><input type="checkbox" class="outline-delete-check" value="'+i+'" onchange="updateOutlineDeleteButton()"> 选择</label>'
        + '<h4 style="flex:1">第'+(i+1)+'章</h4>'
        + '<button onclick="removeOutlineChapter('+i+')" style="font-size:11px;border:none;background:none;color:#ef4444;cursor:pointer">删除</button></div>'
        + '<div class="field"><div class="field-label">标题</div><input data-of="title" value="'+esc(ch.title||"")+'" style="width:100%;padding:6px 8px;border:1px solid var(--c-border);border-radius:6px"></div>'
        + '<div class="field"><div class="field-label">梗概</div><input data-of="summary" value="'+esc(ch.summary||"")+'" style="width:100%;padding:6px 8px;border:1px solid var(--c-border);border-radius:6px"></div>'
        + '<div class="field"><div class="field-label">冲突</div><input data-of="conflict" value="'+esc(ch.conflict||"")+'" style="width:100%;padding:6px 8px;border:1px solid var(--c-border);border-radius:6px"></div>'
        + '<div class="field"><div class="field-label">钩子</div><input data-of="hook" value="'+esc(ch.hook||"")+'" style="width:100%;padding:6px 8px;border:1px solid var(--c-border);border-radius:6px"></div>'
        + '<div class="field"><div class="field-label">关键场景</div><textarea data-of="scenes" rows="3" style="width:100%;padding:6px 8px;border:1px solid var(--c-border);border-radius:6px;font-family:inherit">'+esc((ch.key_scenes||[]).join("\n"))+'</textarea></div>'
        + '<div class="field"><div class="field-label">登场角色</div><textarea data-of="chars" rows="2" style="width:100%;padding:6px 8px;border:1px solid var(--c-border);border-radius:6px;font-family:inherit">'+esc((ch.characters_involved||[]).join("\n"))+'</textarea></div>'
        + '<div style="margin-top:8px"><button class="btn btn-primary" onclick="generateSingleChapter('+i+')" id="gen-ch-'+i+'" style="font-size:12px;padding:6px 14px">'+(chStatus[i]?'重新生成':'⚡ 生成本章')+'</button>'
        + (chStatus[i]?' <span style="color:#22c55e;font-size:12px">✅ 已生成</span>':'')
        + '</div></div>';
      }).join('');
  }
  if(!outline||!outline.length) return '<p>暂无大纲</p>';
  return '<h2>&#128221; 分章大纲</h2>'+
    outline.map(ch=>`<div class="chapter-item">
      <h4>第${ch.chapter_number}章：${esc(ch.title||'')}</h4>
      <div class="meta">${esc(ch.summary||'')}</div>
      <div class="field" style="margin-top:8px"><div class="field-label">冲突</div><div class="field-value">${esc(ch.conflict||'')}</div></div>
      <div class="field"><div class="field-label">钩子</div><div class="field-value" style="color:var(--c-primary)">${esc(ch.hook||'')}</div></div>
      ${ch.key_scenes?.length?`<div class="field"><div class="field-label">关键场景</div><div class="field-value">${ch.key_scenes.map(s=>'• '+esc(s)).join('<br>')}</div></div>`:''}
      ${ch.characters_involved?.length?`<div class="field"><div class="field-label">登场角色</div><div class="field-value">${ch.characters_involved.join(' / ')}</div></div>`:''}
    </div>`).join('');
}

async function deleteNovel(){
  if(!currentNovelId||!confirm('确定把这篇小说移入回收站？')) return;
  await fetch('/api/novels/'+currentNovelId,{method:'DELETE'});
  navigate('library');
}

async function restoreCurrentNovelFromMemory(){
  if(!novelData){ alert("当前浏览器内存里没有可恢复的小说数据"); return; }
  try{
    var body = JSON.parse(JSON.stringify(novelData));
    var r = await fetch("/api/restore-novel", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(body),
    });
    if(!r.ok) throw new Error((await r.json()).detail || "恢复失败");
    var data = await r.json();
    alert("已恢复小说");
    navigate("novel", data.id);
  }catch(e){ alert("恢复失败: "+e.message); }
}


function renderOutlineRead(outline){
  var chapters = (novelData && novelData.chapters) || [];
  var chStatus = {};
  chapters.forEach(function(c,i){ if(c && c.trim()) chStatus[i]=true; });
  var _remain = outline.length - chapters.filter(function(c){return c&&c.trim();}).length;
  var _bb = '<div style="margin-bottom:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      + '<button class="btn btn-primary" onclick="startBatchGeneration()" id="batch-gen-btn" style="font-size:13px;padding:8px 18px">生成全部章节</button>'
      + (_remain > 0 ? '<span style="color:var(--c-muted);font-size:12px">还有 ' + _remain + ' 章未生成</span>' : '')
      + '</div>'
      + '<div id="batch-progress" style="display:none;margin-bottom:14px">'
      + '<div style="height:8px;background:var(--c-border);border-radius:4px;overflow:hidden">'
      + '<div id="batch-progress-bar" style="height:100%;width:0%;background:var(--c-primary);transition:width 0.5s"></div></div>'
      + '<div style="display:flex;justify-content:space-between;margin-top:4px;font-size:12px">'
      + '<span id="batch-progress-text" style="color:var(--c-muted)">准备中...</span>'
      + '<button onclick="cancelBatchGeneration()" style="font-size:11px;border:none;background:none;color:#ef4444;cursor:pointer">取消</button></div></div>';
  return outlineActionsBar()
    + _bb
    + outline.map(function(ch,i){return '<div class="chapter-item">'
      + '<div style="display:flex;align-items:center;gap:10px;justify-content:space-between">'
      + '<label class="outline-select-control" style="display:'+(outlineSelectMode?'inline-flex':'none')+';font-size:13px;color:var(--c-muted);align-items:center;gap:6px"><input type="checkbox" class="outline-delete-check" value="'+i+'" onchange="updateOutlineDeleteButton()"> 选择</label>'
      + '<h4 style="flex:1">第'+ch.chapter_number+'章：'+esc(ch.title||"")+'</h4>'
      + '</div>'
      + '<div class="meta">'+esc(ch.summary||"")+'</div>'
      + '<div class="field" style="margin-top:8px"><div class="field-label">冲突</div><div class="field-value">'+esc(ch.conflict||"")+'</div></div>'
      + '<div class="field"><div class="field-label">钩子</div><div class="field-value" style="color:var(--c-primary)">'+esc(ch.hook||"")+'</div></div>'
      + (ch.characters_involved&&ch.characters_involved.length?'<div class="field"><div class="field-label">登场角色</div><div class="field-value">'+ch.characters_involved.join(" / ")+'</div></div>':'')
      + '<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn-primary" onclick="generateSingleChapter('+i+')" id="gen-ch-'+i+'" style="font-size:12px;padding:6px 14px">'+(chStatus[i]?'重新生成':'生成本章')+'</button>'

      + (chStatus[i]?' <span style="color:#22c55e;font-size:12px;margin-left:4px">已生成</span>':'')
      + '</div></div>';
    }).join('');
}

function renderChapters(chapters){
  if(!chapters||!chapters.length) return '<p style="color:var(--c-muted);text-align:center;padding:40px">没有章节，点击大纲中的“⚡生成本章”按钮开始写作</p>';
  return '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px">'
    + '<h2 style="margin:0">&#128214; 章节正文</h2>'
    + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
    + '<button class="btn btn-secondary" onclick="toggleChapterSelectMode()" id="chapter-select-btn" style="font-size:13px;padding:7px 14px">多选删除</button>'
    + '<button class="btn btn-secondary" onclick="selectAllGeneratedChapters()" id="chapter-select-all-btn" style="font-size:13px;padding:7px 14px;display:none">全选已生成</button>'
    + '<button class="btn btn-secondary" onclick="clearChapterSelection()" id="chapter-clear-btn" style="font-size:13px;padding:7px 14px;display:none">清空选择</button>'
    + '<button class="btn btn-primary" onclick="deleteSelectedChapters()" id="chapter-delete-selected-btn" style="font-size:13px;padding:7px 14px;display:none;background:#ef4444">删除所选</button>'
    + '</div></div>'
    + chapters.map(function(ch,i){
    if(!ch || !ch.trim()) return '<div class="chapter-item" style="opacity:.6"><h4>第 '+(i+1)+' 章</h4><div style="font-size:13px;color:var(--c-muted)">尚未生成</div></div>';
    var display=ch.length>500?ch.slice(0,500)+'...<p style="color:var(--c-muted);font-size:12px;margin-top:4px">(剩余 '+ch.length+' 字)</p>':ch;
    return '<div class="chapter-item"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px">'
      + '<label class="chapter-select-control" style="display:none;font-size:13px;color:var(--c-muted);align-items:center;gap:6px"><input type="checkbox" class="chapter-delete-check" value="'+i+'" onchange="updateChapterDeleteButton()"> 选择</label>'
      + '<h4 style="flex:1">第 '+(i+1)+' 章</h4><button onclick="downloadChapter('+i+')" style="font-size:11px;padding:3px 8px;border:1px solid var(--c-border);border-radius:5px;background:none;cursor:pointer;color:var(--c-primary)">下载 TXT</button></div><div style="font-size:13px;margin-top:8px;line-height:1.8;white-space:pre-wrap">'+esc(display)+'</div></div>';
  }).join('');
}

function renderAudit(report){
  report = report || null;
  var html = '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px">'
    + '<div><h2 style="margin:0">&#128269; 小说审稿</h2>'
    + '<div style="font-size:12px;color:var(--c-muted);margin-top:4px">检查章节与世界观、角色卡、大纲、节奏段落和剧情圣经的冲突、重复和跑偏</div></div>'
    + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
    + '<select id="audit-focus" style="padding:7px 10px;border:1px solid var(--c-border);border-radius:6px;background:#fff">'
    + '<option value="all">全部检查</option><option value="conflict">冲突优先</option><option value="duplicate">重复优先</option><option value="outline">大纲关联</option>'
    + '</select>'
    + '<button class="btn btn-primary" onclick="runNovelAudit()" id="audit-btn" style="font-size:13px;padding:8px 16px">开始审稿</button>'
    + (report ? '<button class="btn btn-secondary" onclick="applyAuditOutline()" id="audit-apply-btn" style="font-size:13px;padding:8px 16px">根据审稿更新大纲</button>' : '')
    + '</div></div>'
    + '<div id="audit-status" style="font-size:13px;color:var(--c-muted);margin-bottom:12px"></div>';
  if(!report){
    return html + '<p style="color:var(--c-muted);padding:24px;text-align:center">暂无审稿报告。生成章节后点击「开始审稿」。</p>';
  }
  var issues = Array.isArray(report.issues) ? report.issues : [];
  var score = report.score || 0;
  html += '<div class="chapter-item" style="border-left:3px solid var(--c-primary)">'
    + '<h4>总体评分：'+esc(score)+'/100</h4>'
    + '<div class="field-value">'+esc(report.summary || '')+'</div>'
    + (report.created_at ? '<div style="font-size:12px;color:var(--c-muted);margin-top:8px">审稿时间：'+esc(report.created_at)+'</div>' : '')
    + '</div>';
  html += '<h3 style="font-size:15px;margin:18px 0 10px">问题列表</h3>';
  if(!issues.length){
    html += '<div class="chapter-item"><div class="field-value">未发现明确冲突或重复章节。</div></div>';
  }else{
    html += issues.map(function(it){
      var sev = it.severity || 'medium';
      var color = sev==='high' ? '#ef4444' : (sev==='low' ? '#64748b' : '#f59e0b');
      var nums = (it.chapter_numbers || []).map(function(n){return '第'+n+'章';}).join('、');
      return '<div class="chapter-item" style="border-left:3px solid '+color+'">'
        + '<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">'
        + '<h4>'+esc(it.title || it.type || '审稿问题')+'</h4>'
        + '<span class="tag" style="border-color:'+color+';color:'+color+'">'+esc(sev)+'</span></div>'
        + '<div class="field"><div class="field-label">章节</div><div class="field-value">'+esc(nums || '未指定')+'</div></div>'
        + '<div class="field"><div class="field-label">类型</div><div class="field-value">'+esc(it.type || '')+'</div></div>'
        + '<div class="field"><div class="field-label">证据</div><div class="field-value">'+esc(it.evidence || '')+'</div></div>'
        + '<div class="field"><div class="field-label">建议</div><div class="field-value">'+esc(it.suggestion || '')+'</div></div>'
        + '</div>';
    }).join('');
  }
  var cmap = Array.isArray(report.chapter_map) ? report.chapter_map : [];
  if(cmap.length){
    html += '<h3 style="font-size:15px;margin:18px 0 10px">章节状态</h3>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px">'
      + cmap.map(function(ch){
        return '<div class="chapter-item" style="padding:10px 12px"><b>第 '+esc(ch.chapter_number)+' 章</b>'
          + '<div style="font-size:12px;color:var(--c-muted);margin-top:4px">'+esc(ch.title || '')+'</div>'
          + '<div style="font-size:12px;margin-top:6px">'+esc(ch.status || '')+'</div></div>';
      }).join('') + '</div>';
  }
  return html;
}

var chapterSelectMode = false;
var outlineSelectMode = false;

function toggleChapterSelectMode(){
  chapterSelectMode = !chapterSelectMode;
  applyChapterSelectMode();
}

function applyChapterSelectMode(){
  document.querySelectorAll(".chapter-select-control").forEach(function(el){
    el.style.display = chapterSelectMode ? "inline-flex" : "none";
  });
  ["chapter-select-all-btn","chapter-clear-btn","chapter-delete-selected-btn"].forEach(function(id){
    var el = document.getElementById(id);
    if(el) el.style.display = chapterSelectMode ? "inline-block" : "none";
  });
  var btn = document.getElementById("chapter-select-btn");
  if(btn) btn.textContent = chapterSelectMode ? "退出多选" : "多选删除";
  if(!chapterSelectMode) clearChapterSelection();
  updateChapterDeleteButton();
}

function selectedChapterIndexes(){
  return Array.from(document.querySelectorAll(".chapter-delete-check:checked")).map(function(el){return parseInt(el.value);});
}

function updateChapterDeleteButton(){
  var btn = document.getElementById("chapter-delete-selected-btn");
  if(!btn) return;
  var count = selectedChapterIndexes().length;
  btn.textContent = count ? "删除所选（"+count+"）" : "删除所选";
  btn.disabled = count === 0;
}

function selectAllGeneratedChapters(){
  document.querySelectorAll(".chapter-delete-check").forEach(function(el){ el.checked = true; });
  updateChapterDeleteButton();
}

function clearChapterSelection(){
  document.querySelectorAll(".chapter-delete-check").forEach(function(el){ el.checked = false; });
  updateChapterDeleteButton();
}

async function deleteSelectedChapters(){
  var indexes = selectedChapterIndexes();
  if(!indexes.length){ alert("请先选择要删除的章节"); return; }
  if(!confirm("确定删除所选 "+indexes.length+" 章正文？章节大纲会保留，可以之后重新生成。")) return;
  var chapters = listChaptersForSave();
  indexes.forEach(function(i){ if(i >= 0 && i < chapters.length) chapters[i] = ""; });
  try{
    var body = JSON.parse(JSON.stringify(novelData));
    body.chapters = chapters;
    var r = await fetch("/api/novels/"+currentNovelId, {
      method:"PUT",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(body),
    });
    if(!r.ok) throw new Error((await r.json()).detail || "删除失败");
    chapterSelectMode = false;
    await loadNovel(currentNovelId);
    switchTab("chapters");
  }catch(e){ alert("删除失败: "+e.message); }
}

function listChaptersForSave(){
  var chapters = (novelData && novelData.chapters) ? novelData.chapters.slice() : [];
  return chapters;
}

function toggleOutlineSelectMode(){
  outlineSelectMode = !outlineSelectMode;
  applyOutlineSelectMode();
}

function applyOutlineSelectMode(){
  document.querySelectorAll(".outline-select-control").forEach(function(el){
    el.style.display = outlineSelectMode ? "inline-flex" : "none";
  });
  ["outline-select-all-btn","outline-clear-btn","outline-delete-selected-btn"].forEach(function(id){
    var el = document.getElementById(id);
    if(el) el.style.display = outlineSelectMode ? "inline-block" : "none";
  });
  var btn = document.getElementById("outline-select-btn");
  if(btn) btn.textContent = outlineSelectMode ? "退出多选" : "多选删除";
  if(!outlineSelectMode) clearOutlineSelection();
  updateOutlineDeleteButton();
}

function selectedOutlineIndexes(){
  return Array.from(document.querySelectorAll(".outline-delete-check:checked")).map(function(el){return parseInt(el.value);});
}

function updateOutlineDeleteButton(){
  var btn = document.getElementById("outline-delete-selected-btn");
  if(!btn) return;
  var count = selectedOutlineIndexes().length;
  btn.textContent = count ? "删除所选（"+count+"）" : "删除所选";
  btn.disabled = count === 0;
}

function selectAllOutlineChapters(){
  document.querySelectorAll(".outline-delete-check").forEach(function(el){ el.checked = true; });
  updateOutlineDeleteButton();
}

function clearOutlineSelection(){
  document.querySelectorAll(".outline-delete-check").forEach(function(el){ el.checked = false; });
  updateOutlineDeleteButton();
}

function renumberOutline(outline, keepNumbers){
  return (outline || []).map(function(ch,i){
    var item = Object.assign({}, ch || {});
    if(keepNumbers){
      // ?????????????????
      if(typeof item.chapter_number !== "number" || item.chapter_number < 1) item.chapter_number = i + 1;
    } else {
      item.chapter_number = i + 1;
    }
    item.title = item.title || "";
    item.summary = item.summary || "";
    item.conflict = item.conflict || "";
    item.hook = item.hook || "";
    item.key_scenes = item.key_scenes || [];
    item.characters_involved = item.characters_involved || [];
    return item;
  });
}

async function deleteSelectedOutlines(){
  var indexes = selectedOutlineIndexes();
  if(!indexes.length){ alert("请先选择要删除的章节大纲"); return; }
  var generated = indexes.filter(function(i){
    return novelData && novelData.chapters && novelData.chapters[i] && novelData.chapters[i].trim();
  }).length;
  var msg = "确定删除所选 "+indexes.length+" 条章节大纲？删除后剩余大纲会重新编号。";
  if(generated){
    msg += "\n\n其中 "+generated+" 章已经生成正文。删除大纲不会删除正文，但正文和后续大纲可能错位。";
  }
  if(!confirm(msg)) return;

  var indexSet = {};
  indexes.forEach(function(i){ indexSet[i] = true; });

  if(editMode){
    syncOutlineFromDOM();
    editData.outline = renumberOutline((editData.outline || []).filter(function(_,i){ return !indexSet[i]; }), true);
    outlineSelectMode = false;
    switchTab("outline");
    return;
  }

  try{
    var body = JSON.parse(JSON.stringify(novelData));
    body.outline = renumberOutline((body.outline || []).filter(function(_,i){ return !indexSet[i]; }), true);
    var r = await fetch("/api/novels/"+currentNovelId, {
      method:"PUT",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(body),
    });
    if(!r.ok) throw new Error((await r.json()).detail || "删除失败");
    outlineSelectMode = false;
    await loadNovel(currentNovelId);
    outlineSubTab = "chapter";
    switchTab("outline");
  }catch(e){ alert("删除失败: "+e.message); }
}

// --- edit mode ---
var editMode = false;
var editData = {};
var pendingEditPayload = null;

function setEditModeUi(active) {
  const bar = byId('edit-bar');
  if (bar) bar.style.display = active ? 'flex' : 'none';
  const cancel = byId('edit-cancel');
  if (cancel) cancel.hidden = !active;
  const toggle = byId('edit-toggle', 'btn-edit');
  if (toggle) {
    toggle.hidden = false;
    toggle.innerHTML = active
      ? '<i class="ph ph-check" aria-hidden="true"></i>保存修改'
      : '<i class="ph ph-pencil-simple" aria-hidden="true"></i>编辑';
  }
}

function enterEdit(){
  if (!novelData) return;
  editMode = true;
  editData = JSON.parse(JSON.stringify(novelData));
  syncPrimaryVolume(editData);
  setEditModeUi(true);
  switchTab(currentTab);
}

function cancelEdit(){
  editMode = false;
  editData = {};
  setEditModeUi(false);
  switchTab(currentTab);
}

function showAssistUpdate(){
  if(!currentNovelId) return;
  var target = "all";
  if(currentTab === "world") target = "world";
  else if(currentTab === "characters") target = "characters";
  else if(currentTab === "outline") target = "outline";
  else if(currentTab === "bible") target = "bible";
  var targetEl = document.getElementById("assist-target");
  var instructionsEl = document.getElementById("assist-instructions");
  var statusEl = document.getElementById("assist-status");
  if(targetEl) targetEl.value = target;
  if(instructionsEl) instructionsEl.value = "";
  if(statusEl) statusEl.textContent = "";
  openOverlay("assist-overlay", "assist-modal");
  instructionsEl?.focus();
}

function hideAssistUpdate(){
  closeOverlay("assist-overlay", "assist-modal");
}

function ensureCharacterPreviewModal(){
  var modal = document.getElementById("character-preview-overlay");
  if(modal) return modal;
  modal = document.createElement("div");
  modal.className = "modal-overlay";
  modal.id = "character-preview-overlay";
  modal.innerHTML = `
    <div class="modal-box" style="max-width:760px">
      <h3>角色卡修改预览</h3>
      <div class="hint" style="margin-bottom:14px">保存前先确认差异，确认后才会写入小说档案。</div>
      <div id="character-preview-body" style="max-height:58vh;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:14px;background:var(--surface)"></div>
      <div class="form-actions" style="margin-top:20px">
        <button class="button button-primary" type="button" onclick="confirmCharacterPreview()">确认保存</button>
        <button class="button button-secondary" type="button" onclick="hideCharacterPreview()">取消</button>
      </div>
    </div>`;
  document.body.append(modal);
  return modal;
}

function hideCharacterPreview(){
  closeOverlay("character-preview-overlay");
}

function normalizeCharacterCard(c){
  c = c || {};
  return {
    name: (c.name || "").trim(),
    role: (c.role || "").trim(),
    archetype: (c.archetype || "").trim(),
    appearance: (c.appearance || "").trim(),
    personality: (c.personality || "").trim(),
    background: (c.background || "").trim(),
    motivation: (c.motivation || "").trim(),
    abilities: (c.abilities || "").trim(),
    flaws: (c.flaws || "").trim(),
    arc: (c.arc || "").trim(),
  };
}

function characterCardChangedKeys(oldCard, newCard){
  var keys = ["name","role","archetype","appearance","personality","background","motivation","abilities","flaws","arc"];
  return keys.filter(function(k){ return (oldCard||{})[k] !== (newCard||{})[k]; });
}

function buildCharacterPreviewHtml(prevChars, nextChars){
  prevChars = Array.isArray(prevChars) ? prevChars : [];
  nextChars = Array.isArray(nextChars) ? nextChars : [];
  var map = {};
  prevChars.forEach(function(c, idx){
    var key = (c && c.name || "").trim() || ("__idx_" + idx);
    map[key] = c;
  });
  var blocks = nextChars.map(function(c, idx){
    var key = (c && c.name || "").trim() || ("__idx_" + idx);
    var oldCard = map[key] || {};
    var changed = characterCardChangedKeys(oldCard, c);
    var title = (c.name || ("角色 " + (idx + 1))) + (c.role ? " · " + c.role : "");
    var badge = changed.length ? '<span style="font-size:12px;color:#b45309;background:#fef3c7;padding:2px 8px;border-radius:999px">已修改</span>' : '<span style="font-size:12px;color:#475569;background:#e2e8f0;padding:2px 8px;border-radius:999px">未变动</span>';
    var diff = changed.length ? changed.map(function(k){
      return '<div style="display:grid;grid-template-columns:110px 1fr 1fr;gap:10px;margin-top:8px;padding-top:8px;border-top:1px dashed var(--c-border)">'
        + '<div style="font-size:12px;color:var(--c-muted)">'+k+'</div>'
        + '<div><div style="font-size:11px;color:var(--c-muted);margin-bottom:4px">原来</div><div>'+esc(oldCard[k]||"")+'</div></div>'
        + '<div><div style="font-size:11px;color:var(--c-muted);margin-bottom:4px">现在</div><div>'+esc(c[k]||"")+'</div></div>'
        + '</div>';
    }).join('') : '<div style="font-size:13px;color:var(--c-muted);margin-top:8px">这一张没有变化</div>';
    return '<div style="padding:14px 0;border-bottom:1px solid var(--c-border)">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px">'
      + '<div><strong>'+esc(title)+'</strong></div>' + badge + '</div>'
      + diff + '</div>';
  }).join('');
  return blocks || '<div style="color:var(--c-muted);font-size:13px">未检测到角色卡变化</div>';
}

function openCharacterPreview(oldChars, newChars, payload){
  pendingEditPayload = payload;
  ensureCharacterPreviewModal();
  document.getElementById("character-preview-body").innerHTML = buildCharacterPreviewHtml(oldChars, newChars);
  openOverlay("character-preview-overlay");
}

async function confirmCharacterPreview(){
  if(!pendingEditPayload) return;
  hideCharacterPreview();
  var payload = pendingEditPayload;
  pendingEditPayload = null;
  await submitEditPayload(payload);
}

async function submitEditPayload(data){
  try{
    var r = await fetch("/api/novels/"+currentNovelId, {
      method: "PUT",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(data),
    });
    if(!r.ok) throw new Error((await r.json()).detail || "保存失败");
    editMode = false;
    setEditModeUi(false);
    await loadNovel(currentNovelId);
  }catch(e){ alert("保存失败: "+e.message); }
}

async function submitAssistUpdate(){
  if(!currentNovelId) return;
  var target = document.getElementById("assist-target").value;
  var instructions = document.getElementById("assist-instructions").value.trim();
  if(!instructions){ alert("请先输入修改方向"); return; }
  var btn = document.getElementById("assist-submit");
  var status = document.getElementById("assist-status");
  if(btn){ btn.disabled = true; btn.textContent = "更新中..."; }
  if(status) status.textContent = "AI 正在重写设定，请稍等...";
  try{
    var r = await fetch("/api/novels/"+currentNovelId+"/assist-update", {
      method: "POST",
      headers: Object.assign({"Content-Type":"application/json"}, getSettingsHeaders()),
      body: JSON.stringify({target: target, instructions: instructions}),
    });
    if(!r.ok) throw new Error(await readError(r, "AI 辅助更新失败"));
    var data = await r.json();
    novelData = data.novel;
    syncPrimaryVolume(novelData);
    hideAssistUpdate();
    switchTab(currentTab);
    alert("已更新：" + (data.updated || []).join("、"));
  }catch(e){
    if(status) status.textContent = "更新失败：" + e.message;
    alert("更新失败: " + e.message);
  }
  if(btn){ btn.disabled = false; btn.textContent = "开始更新"; }
}

async function saveEdit(){
  var data = JSON.parse(JSON.stringify(editData));
  var te = document.getElementById("edit-title");
  var ie = document.getElementById("edit-idea");
  if(te) data.title = te.value;
  if(ie) data.idea = ie.value;

  // collect world form
  var wfInputs = document.querySelectorAll("[data-wf]");
  if(wfInputs.length > 0){
    data.world_setting = {};
    wfInputs.forEach(function(el){ data.world_setting[el.dataset.wf] = el.value; });
    var locs = document.getElementById("edit-locations");
    var facs = document.getElementById("edit-factions");
    if(locs) data.world_setting.locations = locs.value.split("\n").filter(Boolean);
    if(facs) data.world_setting.factions = facs.value.split("\n").filter(Boolean);
  }

  // collect character forms
  var charForms = document.querySelectorAll(".char-edit");
  if(charForms.length > 0){
    data.characters = [];
    charForms.forEach(function(el){
      data.characters.push({
        name: el.querySelector("[data-cf='name']").value,
        role: el.querySelector("[data-cf='role']").value,
        archetype: el.querySelector("[data-cf='archetype']").value,
        appearance: el.querySelector("[data-cf='appearance']").value,
        personality: el.querySelector("[data-cf='personality']").value,
        background: el.querySelector("[data-cf='background']").value,
        motivation: el.querySelector("[data-cf='motivation']").value,
        abilities: el.querySelector("[data-cf='abilities']").value,
        flaws: el.querySelector("[data-cf='flaws']").value,
        arc: el.querySelector("[data-cf='arc']").value,
      });
    });
  }
  var oldChars = (novelData && novelData.characters) ? JSON.parse(JSON.stringify(novelData.characters)) : [];

  // collect volume outline form
  var volForms = document.querySelectorAll(".vol-edit");
  if(volForms.length){
    data.volume_outlines = collectVolumeForms();
    data.volume_outline = data.volume_outlines[0] || {};
  }

  // collect outline forms（按 DOM 顺序重新编号，兼容增删后的位置变化）
  var chForms = document.querySelectorAll(".ch-edit");
  if(chForms.length > 0){
    data.outline = [];
    chForms.forEach(function(el,i){
      data.outline.push({
        chapter_number: i+1,
        title: el.querySelector("[data-of='title']").value,
        summary: el.querySelector("[data-of='summary']").value,
        conflict: el.querySelector("[data-of='conflict']").value,
        hook: el.querySelector("[data-of='hook']").value,
        key_scenes: el.querySelector("[data-of='scenes']").value.split("\n").filter(Boolean),
        characters_involved: el.querySelector("[data-of='chars']").value.split("\n").filter(Boolean).map(function(s){return s.trim();}),
      });
    });
  }

  if(charForms.length > 0){
    openCharacterPreview(oldChars, data.characters || [], data);
    return;
  }
  await submitEditPayload(data);
}

async function generateSingleChapter(idx){
  var btn = document.getElementById("gen-ch-"+idx);
  if(btn){ btn.disabled = true; btn.textContent = "生成中..."; }
  try{
    var r = await fetch("/api/novels/"+currentNovelId+"/generate-chapter/"+idx, {method:"POST", headers: getSettingsHeaders()});
    if(!r.ok) throw new Error((await r.json()).detail || "生成失败");
    await loadNovel(currentNovelId);
  }catch(e){ alert("生成失败: "+e.message); }
  if(btn){
    btn.disabled = false;
    var generated = novelData && novelData.chapters && novelData.chapters[idx] && novelData.chapters[idx].trim();
    btn.textContent = generated ? "重新生成" : "⚡ 生成本章";
  }
}

async function runNovelAudit(){
  if(!currentNovelId) return;
  var btn = document.getElementById("audit-btn");
  var status = document.getElementById("audit-status");
  var focusEl = document.getElementById("audit-focus");
  var focus = focusEl ? focusEl.value : "all";
  if(btn){ btn.disabled = true; btn.textContent = "审稿中..."; }
  if(status) status.textContent = "AI 正在检查章节关联、冲突和重复内容...";
  try{
    var r = await fetch("/api/novels/"+currentNovelId+"/audit", {
      method:"POST",
      headers:Object.assign({"Content-Type":"application/json"}, getSettingsHeaders()),
      body:JSON.stringify({focus:focus}),
    });
    if(!r.ok) throw new Error(await readError(r, "审稿失败"));
    var data = await r.json();
    novelData.audit_report = data.report;
    switchTab("audit");
  }catch(e){
    if(status) status.textContent = "审稿失败：" + e.message;
    alert("审稿失败: " + e.message);
  }
  if(btn){ btn.disabled = false; btn.textContent = "开始审稿"; }
}

async function applyAuditOutline(){
  if(!currentNovelId) return;
  if(!confirm("根据最近审稿报告更新大纲，并同步重写受影响章节正文？")) return;
  var btn = document.getElementById("audit-apply-btn");
  var status = document.getElementById("audit-status");
  if(btn){ btn.disabled = true; btn.textContent = "更新中..."; }
  if(status) status.textContent = "AI 正在根据审稿报告校准篇章、节奏和章节大纲，并重写受影响正文...";
  try{
    var r = await fetch("/api/novels/"+currentNovelId+"/audit/apply-outline", {
      method:"POST",
      headers:getSettingsHeaders(),
    });
    if(!r.ok) throw new Error(await readError(r, "更新大纲失败"));
    var data = await r.json();
    novelData = data.novel;
    syncPrimaryVolume(novelData);
    outlineSubTab = "chapter";
    switchTab("outline");
    var rewritten = (data.rewritten_chapters || []).map(function(ch){
      return "第" + ch.chapter_number + "章";
    });
    alert("已根据审稿报告更新大纲。" + (rewritten.length ? (" 已同步重写：" + rewritten.join("、") + "。") : " 没有需要重写的正文。"));
  }catch(e){
    if(status) status.textContent = "更新大纲失败：" + e.message;
    alert("更新大纲失败: " + e.message);
  }
  if(btn){ btn.disabled = false; btn.textContent = "根据审稿更新大纲"; }
}





function downloadFullNovel(){
  if(!novelData||!novelData.chapters||!novelData.chapters.length){alert("没有可下载的章节");return;}
  var text = novelData.chapters.map(function(ch,i){return "第"+(i+1)+"章\n\n"+ch;}).join("\n\n---\n\n");
  var blob = new Blob([text],{type:"text/plain;charset=utf-8"});
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a"); a.href = url;
  a.download = (novelData.title||"小说")+".txt"; a.click(); URL.revokeObjectURL(url);
}

function downloadChapter(idx){
  if(!novelData||!novelData.chapters||!novelData.chapters[idx]) return;
  var blob = new Blob([novelData.chapters[idx]],{type:"text/plain;charset=utf-8"});
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a"); a.href = url;
  a.download = (novelData.title||"小说")+"_第"+(idx+1)+"章.txt";
  a.click(); URL.revokeObjectURL(url);
}

function downloadFullNovel(){
  if(!novelData||!novelData.chapters||!novelData.chapters.length){alert("没有可下载的章节");return;}
  var text=novelData.chapters.map(function(ch,i){return "第"+(i+1)+"章\n\n"+ch;}).join("\n\n---\n\n");
  var blob=new Blob([text],{type:"text/plain;charset=utf-8"});
  var url=URL.createObjectURL(blob);
  var a=document.createElement("a");a.href=url;
  a.download=(novelData.title||"小说")+".txt";a.click();URL.revokeObjectURL(url);
}
function downloadChapter(i){
  if(!novelData||!novelData.chapters||!novelData.chapters[i]) return;
  var blob=new Blob([novelData.chapters[i]],{type:"text/plain;charset=utf-8"});
  var url=URL.createObjectURL(blob);
  var a=document.createElement("a");a.href=url;
  a.download=(novelData.title||"小说")+"_第"+(i+1)+"章.txt";
  a.click();URL.revokeObjectURL(url);
}
function esc(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

function addCharacter(){
  if(!editData || !editData.characters) return;
  editData.characters.push({name:"",role:"",archetype:"",appearance:"",personality:"",background:"",motivation:"",abilities:"",flaws:"",arc:""});
  switchTab("characters");
}

function removeCharacter(idx){
  if(!editData || !editData.characters) return;
  if(!confirm("确定删除这个角色？")) return;
  editData.characters.splice(idx, 1);
  switchTab("characters");
}

// 把编辑态大纲表单的当前值同步回 editData（增删章节前调用，避免丢失未保存的修改）
function collectVolumeForms(){
  var vols = [];
  document.querySelectorAll(".vol-edit").forEach(function(form){
    var vo = {};
    form.querySelectorAll("[data-vf]").forEach(function(el){
      var k = el.dataset.vf;
      if(k==="key_events") vo[k] = el.value.split("\n").map(function(s){return s.trim();}).filter(Boolean);
      else if(k==="chapter_start"||k==="chapter_end") vo[k] = parseInt(el.value)||0;
      else vo[k] = el.value;
    });
    vols.push(vo);
  });
  return vols;
}

function syncOutlineFromDOM(){
  if(!editData) return;
  var volForms = document.querySelectorAll(".vol-edit");
  if(volForms.length){
    editData.volume_outlines = collectVolumeForms();
    editData.volume_outline = editData.volume_outlines[0] || {};
  }
  var chForms = document.querySelectorAll(".ch-edit");
  if(chForms.length){
    editData.outline = [];
    chForms.forEach(function(el,i){
      editData.outline.push({
        chapter_number: i+1,
        title: el.querySelector("[data-of='title']").value,
        summary: el.querySelector("[data-of='summary']").value,
        conflict: el.querySelector("[data-of='conflict']").value,
        hook: el.querySelector("[data-of='hook']").value,
        key_scenes: el.querySelector("[data-of='scenes']").value.split("\n").filter(Boolean),
        characters_involved: el.querySelector("[data-of='chars']").value.split("\n").filter(Boolean).map(function(s){return s.trim();}),
      });
    });
  }
}

function addVolumeOutline(){
  if(!editData) return;
  syncOutlineFromDOM();
  if(!editData.volume_outlines) editData.volume_outlines = getVolumeOutlines(editData);
  var last = editData.volume_outlines[editData.volume_outlines.length - 1] || {};
  var start = (parseInt(last.chapter_end)||0) + 1;
  editData.volume_outlines.push({name:"新篇章",arc:"",chapter_start:start||1,chapter_end:(start||1)+29,core_conflict:"",climax:"",key_events:[]});
  syncPrimaryVolume(editData);
  switchTab("outline");
}

function removeVolumeOutline(idx){
  if(!editData) return;
  syncOutlineFromDOM();
  if(!editData.volume_outlines) editData.volume_outlines = getVolumeOutlines(editData);
  if(!editData.volume_outlines.length) return;
  if(!confirm("确定删除这个篇章大纲？章节大纲和正文不会被删除。")) return;
  editData.volume_outlines.splice(idx, 1);
  syncPrimaryVolume(editData);
  switchTab("outline");
}

function addOutlineChapter(){
  if(!editData) return;
  syncOutlineFromDOM();
  if(!editData.outline) editData.outline = [];
  editData.outline.push({chapter_number:editData.outline.length+1,title:"",summary:"",conflict:"",hook:"",key_scenes:[],characters_involved:[]});
  switchTab("outline");
}

function removeOutlineChapter(idx){
  if(!editData || !editData.outline) return;
  var hasDraft = novelData && novelData.chapters && novelData.chapters[idx] && novelData.chapters[idx].trim();
  var msg = hasDraft
    ? "第"+(idx+1)+"章已生成正文。删除大纲不会删除正文，但后续章节正文会与大纲错位。确定删除该章大纲？"
    : "确定删除第"+(idx+1)+"章大纲？";
  if(!confirm(msg)) return;
  syncOutlineFromDOM();
  editData.outline.splice(idx, 1);
  editData.outline.forEach(function(ch,i){ ch.chapter_number = i+1; });
  switchTab("outline");
}

// AI 续写章节大纲（读态/编辑态都可用）。编辑态下先保存当前修改，再追加续写结果。
async function expandOutline(){
  if(!currentNovelId) return;
  var cntEl = document.getElementById("expand-count");
  var count = cntEl ? (parseInt(cntEl.value)||5) : 5;
  var btn = document.getElementById("expand-btn");
  if(btn){ btn.disabled = true; btn.textContent = "AI 续写中..."; }
  try{
    // 编辑态：先把当前未保存的大纲修改持久化，避免被续写结果覆盖
    if(editMode){
      syncOutlineFromDOM();
      await fetch("/api/novels/"+currentNovelId, {
        method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify(editData)
      });
    }
    var r = await fetch("/api/novels/"+currentNovelId+"/expand-outline", {
      method:"POST",
      headers: Object.assign({"Content-Type":"application/json"}, getSettingsHeaders()),
      body: JSON.stringify({count: count}),
    });
    if(!r.ok) throw new Error((await r.json()).detail || "续写失败");
    var res = await r.json();
    await loadNovel(currentNovelId);
    if(editMode){ editData = JSON.parse(JSON.stringify(novelData)); }
    switchTab("outline");
    alert("已续写 "+res.added+" 章大纲");
  }catch(e){ alert("续写失败: "+e.message); }
  if(btn){ btn.disabled = false; btn.textContent = "✨ AI 续写章节大纲"; }
}


function showRewriteDialog(idx){
  var instr = prompt("第"+(idx+1)+"章重写指令（可选）：\n\n例如：\n- 加强打斗场面\n- 增加对话\n- 改写为悬疑风格\n\n留空则按原大纲重写");
  if(instr===null) return;
  rewriteChapter(idx, instr);
}

async function rewriteChapter(idx, instructions){
  var btn = document.getElementById("rew-ch-"+idx);
  if(btn){ btn.disabled = true; btn.textContent = "重写中..."; }
  try{
    var r = await fetch("/api/novels/"+currentNovelId+"/rewrite-chapter/"+idx, {
      method:"POST",
      headers: Object.assign({"Content-Type":"application/json"}, getSettingsHeaders()),
      body: JSON.stringify({instructions: instructions || ""})
    });
    if(!r.ok) throw new Error((await r.json()).detail || "重写失败");
    await loadNovel(currentNovelId);
  }catch(e){ alert("重写失败: "+e.message); }
  if(btn){ btn.disabled = false; btn.textContent = "重写"; }
}

var batchPollTimer = null;

async function startBatchGeneration(){
  if(batchPollTimer) clearInterval(batchPollTimer);
  var btn = document.getElementById("batch-gen-btn");
  if(btn){ btn.disabled=true; btn.textContent="生成中..."; }
  showBatchProgress("准备中...", 0);
  try{
    var r = await fetch("/api/novels/"+currentNovelId+"/generate-remaining", {method:"POST", headers:getSettingsHeaders()});
    if(!r.ok) throw new Error((await r.json()).detail || "启动失败");
    pollBatchProgress(true);
  }catch(e){ alert("批量生成失败: "+e.message); if(btn){ btn.disabled=false; btn.textContent="生成全部章节"; } }
}

function cancelBatchGeneration(){
  if(batchPollTimer){ clearInterval(batchPollTimer); batchPollTimer=null; }
  fetch("/api/novels/"+currentNovelId+"/cancel-generation", {method:"POST"});
  showBatchProgress("已取消", 0);
  var btn=document.getElementById("batch-gen-btn");
  if(btn){ btn.disabled=false; btn.textContent="生成全部章节"; }
}

function showBatchProgress(text, pct){
  var box = document.getElementById("batch-progress");
  var bar = document.getElementById("batch-progress-bar");
  var label = document.getElementById("batch-progress-text");
  if(box) box.style.display="block";
  if(bar) bar.style.width=(pct||0)+"%";
  if(label) label.textContent=text;
}

async function pollBatchProgress(loop){
  if(!currentNovelId) return;
  if(batchPollTimer){ clearInterval(batchPollTimer); batchPollTimer=null; }
  async function tick(){
    try{
      var pr = await fetch("/api/novels/"+currentNovelId+"/generation-progress");
      var pg = await pr.json();
      var pct = pg.total>0 ? Math.round(pg.completed/pg.total*100) : 0;
      var text = pg.status=="running" ? "正在生成第"+(pg.current!==null?pg.current+1:"?")+"章... ("+pct+"%)" : pg.status;
      showBatchProgress(text, pct);
      var btn = document.getElementById("batch-gen-btn");
      if(pg.status=="running"){
        if(btn){ btn.disabled=true; btn.textContent="生成中..."; }
        if(loop) batchPollTimer = setTimeout(tick, 2000);
      }else{
        if(btn){ btn.disabled=false; btn.textContent="生成全部章节"; }
        if(pg.errors && pg.errors.length){
          alert("生成完成，但有 " + pg.errors.length + " 个错误：\n" + pg.errors.join("\n"));
        }
        await loadNovel(currentNovelId);
      }
    }catch(e){
      if(loop) batchPollTimer = setTimeout(tick, 3000);
    }
  }
  tick();
}

async function resumeBatchProgress(){
  if(!currentNovelId) return;
  try{
    var pr = await fetch("/api/novels/"+currentNovelId+"/generation-progress");
    var pg = await pr.json();
    if(pg.status === "running"){
      if(currentTab !== "outline"){
        // 进度条只存在于大纲页，不强制切页，避免打断用户阅读。
        return;
      }
      pollBatchProgress(true);
    }
  }catch(e){}
}

function applyLibrarySearch(){
  var input = document.getElementById('library-search');
  var grid = document.getElementById('library-grid');
  if(!input || !grid) return;
  var query = input.value.trim().toLowerCase();
  var cards = Array.from(grid.querySelectorAll('.novel-card'));
  var visible = 0;
  cards.forEach(function(card){
    var text = ((card.dataset.title || '') + ' ' + (card.dataset.idea || '')).toLowerCase();
    var match = !query || text.includes(query);
    card.hidden = !match;
    if(match) visible += 1;
  });
  var empty = document.getElementById('library-empty');
  if(empty) empty.hidden = visible > 0 || !cards.length;
}

function setupLibrarySearch(){
  var input = document.getElementById('library-search');
  input?.addEventListener('input', applyLibrarySearch);
  document.getElementById('clear-library-search')?.addEventListener('click', function(){
    if(input){
      input.value = '';
      input.focus();
    }
    applyLibrarySearch();
  });
}

function setupModalDismissal(){
  document.querySelectorAll('[data-close-modal]').forEach(function(button){
    button.addEventListener('click', function(){
      var id = button.dataset.closeModal;
      if(id === 'settings-modal') hideSettings();
      else if(id === 'assist-modal') hideAssistUpdate();
      else closeOverlay(id);
    });
  });
  document.querySelectorAll('.modal-backdrop, .modal-overlay').forEach(function(modal){
    modal.addEventListener('click', function(event){
      if(event.target !== modal) return;
      if(modal.id === 'settings-modal' || modal.id === 'settings-overlay') hideSettings();
      else if(modal.id === 'assist-modal' || modal.id === 'assist-overlay') hideAssistUpdate();
      else closeOverlay(modal.id);
    });
  });
  document.addEventListener('keydown', function(event){
    if(event.key !== 'Escape') return;
    if(byId('settings-overlay', 'settings-modal') && !byId('settings-overlay', 'settings-modal')?.hidden) hideSettings();
    else if(byId('assist-overlay', 'assist-modal') && !byId('assist-overlay', 'assist-modal')?.hidden) hideAssistUpdate();
    else if(byId('character-preview-overlay') && !byId('character-preview-overlay')?.hidden) hideCharacterPreview();
    else if(byId('mobile-menu') && !byId('mobile-menu')?.hidden) closeMobileMenu();
  });
}

function setupUiEvents(){
  normalizeUiBridge();
  setEditModeUi(false);
  loadSettings();
  setupLibrarySearch();
  setupModalDismissal();

  document.addEventListener('click', function(event){
    var routeButton = event.target.closest('button[data-route], a[data-route]');
    if(routeButton){
      event.preventDefault();
      navigate(routeButton.dataset.route);
      return;
    }
    var detailTab = event.target.closest('[data-detail-tab], #detail-tabs [data-tab]');
    if(detailTab && !detailTab.hasAttribute('onclick')){
      switchTab(detailTab.dataset.detailTab || detailTab.dataset.tab);
    }
  });

  byId('menu-toggle')?.addEventListener('click', toggleMobileMenu);
  document.querySelectorAll('.mobile-menu [data-route]').forEach(function(button){
    button.addEventListener('click', function(){ closeMobileMenu(false); });
  });

  var createForm = byId('create-form');
  var createButton = byId('btn-create', 'create-submit');
  if(createForm){
    createForm.addEventListener('submit', function(event){
      event.preventDefault();
      createNovel();
    });
  }else if(createButton && !createButton.hasAttribute('onclick')){
    createButton.addEventListener('click', createNovel);
  }
  document.querySelectorAll('input[name="genre"]').forEach(function(input){
    input.addEventListener('change', function(){ selectGenre(input); });
  });

  var importForm = byId('import-form');
  var importButton = byId('btn-import', 'import-submit');
  if(importForm){
    importForm.addEventListener('submit', function(event){
      event.preventDefault();
      importTxtNovel();
    });
  }else if(importButton && !importButton.hasAttribute('onclick')){
    importButton.addEventListener('click', importTxtNovel);
  }
  byId('import-file')?.addEventListener('change', readImportFile);
  byId('import-genre')?.addEventListener('change', function(event){
    selectedGenre = event.currentTarget.value;
  });

  var settingsOpen = byId('settings-open', 'nav-settings');
  if(settingsOpen && !settingsOpen.hasAttribute('onclick')){
    settingsOpen.addEventListener('click', function(event){
      event.preventDefault();
      showSettings();
    });
  }
  byId('save-settings')?.addEventListener('click', saveSettings);
  byId('s-provider', 'provider')?.addEventListener('change', onProviderChange);

  var assistOpen = byId('assist-open', 'btn-ai-update');
  if(assistOpen && !assistOpen.hasAttribute('onclick')){
    assistOpen.addEventListener('click', function(event){
      event.preventDefault();
      showAssistUpdate();
    });
  }
  byId('assist-submit')?.addEventListener('click', submitAssistUpdate);
  byId('character-preview-body')?.closest('.modal-overlay')?.querySelectorAll('[onclick="confirmCharacterPreview()"]').forEach(function(button){
    button.addEventListener('click', confirmCharacterPreview);
  });

  var downloadButton = byId('download-novel', 'btn-download');
  if(downloadButton && !downloadButton.hasAttribute('onclick')) downloadButton.addEventListener('click', downloadFullNovel);
  var deleteButton = byId('delete-novel-open', 'btn-delete');
  if(deleteButton && !deleteButton.hasAttribute('onclick')){
    deleteButton.addEventListener('click', function(event){
      event.preventDefault();
      deleteNovel();
    });
  }
  var editButton = byId('edit-toggle', 'btn-edit');
  if(editButton && !editButton.hasAttribute('onclick')){
    editButton.addEventListener('click', function(event){
      event.preventDefault();
      if(editMode) saveEdit();
      else enterEdit();
    });
  }
  byId('edit-cancel')?.addEventListener('click', cancelEdit);
}

let routeRenderTimer = null;
function scheduleRouteRender(){
  clearTimeout(routeRenderTimer);
  routeRenderTimer = setTimeout(render, 0);
}
window.addEventListener('popstate', scheduleRouteRender);
window.addEventListener('hashchange', scheduleRouteRender);
window.addEventListener('DOMContentLoaded', function(){
  setupUiEvents();
  render();
  resumeCreateJob();
});
