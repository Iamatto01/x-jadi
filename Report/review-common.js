/* Shared Review UI script extracted from Approve.html / review.html */

/* ===== CONFIG ===== */
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxEqQcvflGZcfpVAw_S6lVgRjvMMCOmFG0pFWQu8STSmVg0cJPx_VvbxOo1lUxfAjE/exec';

/* ===== Helpers ===== */
const $  = (s,p=document)=>p.querySelector(s);
const $$ = (s,p=document)=>Array.from(p.querySelectorAll(s));
const fmtDate = s => !s ? '' : new Date(s).toLocaleString();
const sleep = ms => new Promise(r=>setTimeout(r,ms));
function showToast(msg='Saved'){ const t=$('#toast'); t.firstElementChild.textContent=msg; t.classList.remove('hidden'); setTimeout(()=>t.classList.add('hidden'),1500); }

// Escape + sections renderer
const esc = s => String(s).replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;' }[m]));
function renderSections(resp){
  const host = $('#sections'); if(!host) return; host.innerHTML = '';
  const blocks = [
    ['MI', resp.mi],
    ['Rows', resp.rows],
    ['UTTM', resp.uttm],
    ['HT Gauges', resp.htGauges],
    ['SR Scope', resp.srScope],
    ['SR Comments', resp.srComments],
  ];
  blocks.forEach(([label, data])=>{
    if(!data || (Array.isArray(data)&&!data.length)) return;
    const card = document.createElement('div');
    card.className = 'p-3 rounded-xl border';
    card.innerHTML = `
      <div class="text-[0.65rem] font-semibold text-slate-500 uppercase mb-1">${label}</div>
      <pre class="text-xs bg-slate-50 rounded p-2 overflow-x-auto whitespace-pre-wrap">${esc(JSON.stringify(data, null, 2))}</pre>`;
    host.appendChild(card);
  });
}

/* ===== API wrappers (match Apps Script you deployed) =====
   If your backend uses different action names, update here only. */
async function api(body){
  const resp = await fetch(SCRIPT_URL, { method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, body: JSON.stringify(body) });
  const text = await resp.text();
  let data=null; try{ data=JSON.parse(text); }catch(e){ throw new Error('Bad JSON: '+text.slice(0,180)); }
  if(!resp.ok || data.ok===false) throw new Error(data?.error||('HTTP '+resp.status));
  return data;
}
function listForReview(status, q){
  return api({ action:'list', status, q: (q||'').trim(), limit: 200 });
}
function getReport(id){
  return api({ action:'get', id });
}
function transition(id, toStatus, note, reviewer){
  if (toStatus === 'CHANGES_REQUESTED' || toStatus === 'APPROVAL_REQUESTED') {
    // maps to GAS reviewRecord()
    return api({
      action: 'review',
      id,
      decision: (toStatus === 'CHANGES_REQUESTED') ? 'send_back' : 'pass',
  notes: note || '',
  reviewer: reviewer || ''
    });
  }
  // fallback: manual set
  return api({ action:'set_status', id, status: toStatus });
}

/* ===== State ===== */
let rows = [];       // list view
let current = null;  // opened report

/* ===== UI: List rendering ===== */
function statusChip(s){
  const map = {
    'REVIEW_REQUESTED':'chip chip-review',
    'PENDING_REVIEW':'chip chip-review',
    'IN_REVIEW':'chip chip-review',
    'CHANGES_REQUESTED':'chip chip-change',
    'APPROVAL_REQUESTED':'chip chip-await',
    'APPROVED':'chip chip-ok',
    'DRAFT':'chip chip-draft'
  };
  return `<span class="${map[s]||'chip chip-draft'}">${s.replaceAll('_',' ')}</span>`;
}
function renderList(){
  const tb = $('#rows'); tb.innerHTML = '';
  if(!rows.length){
    tb.innerHTML = `<tr><td colspan="7" class="text-center py-10 text-slate-500">No items found.</td></tr>`;
    return;
  }
  for(const r of rows){
  const f = r.fields_json || r.fields || {};
  const serial = r.serial || '-';
  const type = r.type || '-';
  const client = r.client || r.title || f['sr-client'] || f['utClient'] || f['ht-customer'] || '-';
  const reportDate = r.reportDate || f['sr-reportdate'] || f['pg_cal_date'] || f['utDate'] || f['ht-test-date'] || '-';
  const updated = r.updatedAt || r.createdAt;
  const status = r.status || '';
  const idVal = r.id;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="font-semibold">${serial}</td>
      <td>${type}</td>
      <td>${client}</td>
      <td>${reportDate}</td>
      <td class="text-slate-500">${fmtDate(updated)}</td>
      <td>${statusChip(status)}</td>
      <td class="text-right"><button class="px-3 py-1 rounded-lg border" data-open="${idVal||''}">Open</button></td>
    `;
    tb.appendChild(tr);
  }
  $$('button[data-open]').forEach(b=>b.onclick=()=>openReport(b.dataset.open));
}

/* ===== UI: Drawer / Tabs ===== */
// Keep object URLs so we can revoke them
const _blobCache = new Map();

function dataUriToBlobUrl(uri){
  if(!/^data:application\/pdf/i.test(uri)) return uri;
  // turn base64 into a Blob URL (faster than an enormous data: src)
  const base64 = uri.split(',')[1];
  const binStr = atob(base64);
  const len = binStr.length;
  const bytes = new Uint8Array(len);
  for (let i=0;i<len;i++) bytes[i] = binStr.charCodeAt(i);
  const blobUrl = URL.createObjectURL(new Blob([bytes], {type: 'application/pdf'}));
  _blobCache.set(blobUrl, true);
  return blobUrl;
}

function resolvePdfSrc(rowOrRes){
  const url = findPdfUrl(rowOrRes);
  return url && url.startsWith('data:') ? dataUriToBlobUrl(url) : url;
}

function unloadPdf(){
  const frame = $('#pdf-frame');
  if(frame) frame.removeAttribute('src');
  // Revoke any blob URLs we created
  for(const url of _blobCache.keys()){ URL.revokeObjectURL(url); _blobCache.delete(url); }
}

// Load PDF only when needed
async function ensurePdfLoaded(){
  const frame=$('#pdf-frame'), fb=$('#pdf-fallback');
  if(!current || !frame) return;
  if(frame.getAttribute('src')) return; // already loaded
  try{
    const pdfSrc = resolvePdfSrc({ ...current, attachments: current.attachments_json, fields: current.fields_json });
    if(pdfSrc){ frame.src = pdfSrc; fb && fb.classList.add('hidden'); }
    else { frame.removeAttribute('src'); fb && fb.classList.remove('hidden'); }
  }catch{
    frame && frame.removeAttribute('src'); fb && fb.classList.remove('hidden');
  }
}

function setTab(name){
  $$('.tab-btn').forEach(btn=>btn.classList.toggle('bg-slate-100', btn.dataset.tab!==name));
  ['pdf','summary','sections','files','history'].forEach(t=>{
    const el = $('#tab-'+t);
    if(el) el.classList.toggle('hidden', name!==t);
  });
  if(name==='pdf') ensurePdfLoaded();
}
$$('.tab-btn').forEach(btn=>btn.addEventListener('click',()=>setTab(btn.dataset.tab)));

// removed renderFieldsGrid (All Fields tab was removed)

function renderFiles(att){
  const grid = $('#file-grid'); const list = $('#file-list');
  grid.innerHTML=''; list.innerHTML='';
  if(!att || !att.length){
    list.innerHTML = `<div class="text-slate-500 text-sm">No files attached.</div>`;
    return;
  }
  for(const f of att){
    // Prefer direct webUrl/driveUrl if backend returns, else data (base64)
  const url = f.url || f.webUrl || f.driveUrl || f.data || '#';
    if((f.mimeType||'').startsWith('image/')){
      const card = document.createElement('a');
      card.href=url; card.target='_blank';
      card.className='block rounded-xl border overflow-hidden';
      card.innerHTML = `<img src="${url}" alt="${f.name||'image'}" class="w-full aspect-[4/3] object-cover"> <div class="px-2.5 py-2 text-xs truncate">${f.name||''}</div>`;
      grid.appendChild(card);
    }else{
      const row = document.createElement('div');
      row.className='flex items-center gap-3 p-2 rounded-xl border';
      row.innerHTML = `<div class="w-8 h-8 rounded bg-slate-100 flex items-center justify-center text-[.7rem] font-bold">PDF</div>
                       <div class="flex-1">
                         <div class="text-sm font-medium truncate">${f.name||'file'}</div>
                         <a class="text-xs text-blue-600 underline" href="${url}" target="_blank">Open</a>
                       </div>`;
      list.appendChild(row);
    }
  }
}

function renderHistory(h){
  const ul = $('#history'); ul.innerHTML='';
  (h||[]).forEach(e=>{
    const li = document.createElement('li');
    li.innerHTML = `<span class="font-semibold">${e.who||'System'}</span> — ${e.action||''} <span class="text-slate-500">(${fmtDate(e.at)})</span> ${e.note?(' — '+e.note):''}`;
    ul.appendChild(li);
  });
}

// PDF helpers for Drive preview embedding
function toDrivePreview(u){
  if(!u) return null;
  try{
    const m1 = u.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    const m2 = u.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    const id = (m1 && m1[1]) || (m2 && m2[1]);
    if(id) return `https://drive.google.com/file/d/${id}/preview`;
    return u.includes('#') ? u : (u + '#view=FitH');
  }catch{ return u; }
}
function findPdfUrl(rowOrRes){
  const direct = rowOrRes?.pdfUrl || rowOrRes?.meta?.pdfUrl;
  if(direct) return toDrivePreview(direct);
  const list = rowOrRes?.attachments_json || rowOrRes?.attachments || [];
  const pdf = (list||[]).find(a=>{
    const mt=(a.mimeType||'').toLowerCase();
    const nameOrUrl=[a.name,a.url,a.webUrl,a.driveUrl].filter(Boolean).join(' ');
    return mt.includes('pdf') || \.pdf($|\?)?/i.test(nameOrUrl);
  });
  if(pdf){ const url=pdf.url||pdf.webUrl||pdf.driveUrl||pdf.data; return toDrivePreview(url); }
  return null;
}

async function openReport(id){
  $('#drawer').classList.remove('hidden');
  unloadPdf();
  setTab('pdf');
  $('#d-title').textContent = 'Loading…';
  $('#d-meta').textContent = '';
  $('#sum-client').textContent = '';
  $('#sum-date').textContent = '';
  $('#sum-type').textContent = '';
  $('#sum-prepared').textContent = '';
  $('#file-grid').innerHTML = '';
  $('#file-list').innerHTML = '';
  $('#history').innerHTML = '';
  $('#reviewNotes').value='';
  const frame=$('#pdf-frame'); const fb=$('#pdf-fallback'); if(frame){ frame.removeAttribute('src'); } if(fb){ fb.classList.add('hidden'); }

  try{
  const res = await getReport(id);
  // Tolerate both shapes: {row:{...}} or {meta,fields,attachments,pdfUrl}
  let data;
  if (res && res.row) {
    data = res.row;
  } else {
    const meta = res?.meta || {};
    const fields = res?.fields || {};
    data = {
      ...meta,
      fields_json: fields,
      attachments_json: res?.attachments || [],
      pdfUrl: res?.pdfUrl || meta?.pdfUrl
    };
  }
  current = data;

  const f = data.fields_json || data.fields || {};
  $('#d-serial').textContent = data.serial || '(no-serial)';
  $('#d-title').textContent  = `${data.type || ''} • ${data.title || f['sr-client'] || f['utClient'] || f['ht-customer'] || ''}`;
  const metaText = `Status: ${data.status} · Created ${fmtDate(data.createdAt)} · Updated ${fmtDate(data.updatedAt)}`;
  if (data.pdfUrl) {
    $('#d-meta').innerHTML = `${metaText} · <a class="text-blue-600 underline" href="${data.pdfUrl}" target="_blank">Open PDF</a>`;
  } else {
    $('#d-meta').textContent = metaText;
  }

  $('#sum-client').textContent   = data.client || data.title || f['sr-client'] || f['utClient'] || f['ht-customer'] || '-';
  $('#sum-date').textContent     = f['sr-reportdate'] || f['pg_cal_date'] || f['utDate'] || f['ht-test-date'] || '-';
  $('#sum-type').textContent     = data.type || '-';
  $('#sum-prepared').textContent = f['utPreparedBy'] || f['sr-team'] || '-';

  // Lazy-load PDF when the PDF tab is shown
  ensurePdfLoaded();

  // Include any top-level sections from the raw response as well
  renderSections({ ...data, ...res });
  renderFiles(data.attachments_json || res?.attachments || []);
  $('#reviewNotes').value = '';
  }catch(e){
    alert('Failed to load: '+e.message);
  }
}

/* ===== Actions ===== */
$('#close').onclick = ()=>$('#drawer').classList.add('hidden');

$('#btn-changes').onclick = async ()=>{
  if(!current) return;
  const note = ($('#reviewNotes').value||'').trim();
  const reviewer = ($('#reviewerName').value||'').trim();
  if(!reviewer){ alert('Please enter your name.'); return; }
  if(!note){ alert('Please write what needs to be changed.'); return; }
  try{
    await transition(current.id, 'CHANGES_REQUESTED', note, reviewer);
    showToast('Sent back for changes');
    await reload(); $('#drawer').classList.add('hidden');
  }catch(e){ alert('Error: '+e.message); }
};

$('#btn-reviewed').onclick = async ()=>{
  if(!current) return;
  const note = ($('#reviewNotes').value||'').trim();
  const reviewer = ($('#reviewerName').value||'').trim();
  if(!reviewer){ alert('Please enter your name.'); return; }
  try{
    await transition(current.id, 'APPROVAL_REQUESTED', note, reviewer);
    showToast('Marked as reviewed → Approval');
    await reload(); $('#drawer').classList.add('hidden');
  }catch(e){ alert('Error: '+e.message); }
};

/* ===== Search / Filters / Refresh ===== */
async function reload(){
  try{
  const status = $('#statusFilter').value; const q = $('#q').value;
  const res = await listForReview(status==='ANY'?null:status, q);
  rows = (Array.isArray(res.items)?res.items:(Array.isArray(res.rows)?res.rows:[])) || [];
  renderList();
  }catch(e){
    rows = []; renderList();
    alert('Load failed: '+e.message);
  }
}
$('#reload').onclick = reload;
$('#statusFilter').onchange = reload;
$('#q').oninput = ()=>{ // light client-side filter
  const s = ($('#q').value||'').toLowerCase().trim();
  if(!s){ renderList(); return; }
  const filtered = (rows||[]).filter(r=>{
    const f = r.fields_json || r.fields || {};
    const hay = [
      r.serial, r.type, r.title, r.client, r.reportDate,
      f['sr-client'], f['utClient'], f['ht-customer'],
      f['sr-reportdate'], f['pg_cal_date'], f['utDate'], f['ht-test-date']
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(s);
  });
  const tb = $('#rows'); tb.innerHTML='';
  for(const r of filtered){
    const f = r.fields_json || r.fields || {};
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="font-semibold">${r.serial||'-'}</td>
      <td>${r.type||'-'}</td>
      <td>${r.client || r.title || f['sr-client'] || f['utClient'] || f['ht-customer'] || '-'}</td>
      <td>${r.reportDate || f['sr-reportdate'] || f['pg_cal_date'] || f['utDate'] || f['ht-test-date'] || '-'}</td>
      <td class="text-slate-500">${fmtDate(r.updatedAt||r.createdAt)}</td>
      <td>${statusChip(r.status||'')}</td>
      <td class="text-right"><button class="px-3 py-1 rounded-lg border" data-open="${r.id}">Open</button></td>
    `;
    tb.appendChild(tr);
  }
  $$('button[data-open]').forEach(b=>b.onclick=()=>openReport(b.dataset.open));
};

/* ===== Boot & Auto-refresh ===== */
(async function boot(){
  await reload();
  // 90s heartbeat
  setInterval(reload, 90000);
})();
