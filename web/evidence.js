let allEvidence = [];

//  Load from API 
function loadEvidence(){
  fetch("/api/evidence").then(r=>r.json()).then(list=>{
    allEvidence = list;

    // Update count badge
    const countEl = document.getElementById("evCount");
    if(countEl)
      countEl.textContent = `${list.length} record${list.length===1?"":"s"}`;

    // Update stat cards
    const phones = list.filter(e=> /phone/i.test(e.reason)).length;
    const shares = list.filter(e=> /leaning|sharing/i.test(e.reason)).length;

    setText("totalEv", list.length);
    setText("phoneEv", phones);
    setText("shareEv", shares);

    applyFilters();
  }).catch(err=>{
    console.error("Evidence load error:", err);
  });
}

function setText(id, val){
  const el = document.getElementById(id);
  if(el) el.textContent = val;
}

// Apply search + type filters
function applyFilters(){
  const q    = (document.getElementById("filterInput")?.value||"").toLowerCase().trim();
  const type = (document.getElementById("filterType")?.value||"").toLowerCase().trim();

  const filtered = allEvidence.filter(e=>{
    const matchQ = !q || e.reason.toLowerCase().includes(q) || e.id.toString().includes(q);
    const matchT = !type || e.reason.toLowerCase().includes(type);
    return matchQ && matchT;
  });

  const fc = document.getElementById("filteredCount");
  if(fc){
    fc.textContent = filtered.length < allEvidence.length ? `Showing ${filtered.length} of ${allEvidence.length}` : "";
  }

  renderEvidence(filtered);
}

//  Render grid
function renderEvidence(list){
  const g = document.getElementById("evidenceGrid");
  if(!g) return;

  if(!list.length){
    g.innerHTML = `<div class="ev-empty">${allEvidence.length ? "No evidence matches your filter." : "No evidence captured yet."}</div>`;
    return;
  }

  // Colour dot per reason
  function reasonColour(reason){
    if(/phone/i.test(reason))   return "#f85149";
    if(/leaning/i.test(reason)) return "#d29922";
    if(/sharing/i.test(reason)) return "#bc8cff";
    return "#8b949e";
  }

  g.innerHTML = list.map(e=>{
    const col = reasonColour(e.reason);
    const safeReason  = e.reason.replace(/'/g,"\\'");
    return `
      <div class="ev-card"
           onclick="openModal('${e.file}', '${safeReason}', '${e.timestamp}', '${e.id}', '${e.confidence}')">
        <div style="position:relative">
          <img class="ev-img"
               src="/${e.file}"
               alt="Evidence"
               onerror="this.style.display='none'; document.getElementById('noimg-${e.id}').style.display='flex'"/>
          <div id="noimg-${e.id}" class="ev-no-img" style="display:none">📷</div>
          <div style="position:absolute;top:6px;right:6px;background:rgba(0,0,0,.65);border-radius:4px;padding:2px 7px;font-size:10px;font-weight:700;color:${col}">
            #${e.id}
          </div>
        </div>
        <div class="ev-info">
          <div class="ev-student">Alert #${e.id} <span style="color:var(--muted);font-weight:400">(${e.confidence}%)</span></div>
          <div class="ev-reason" style="color:${col}">⚠ ${e.reason}</div>
          <div class="ev-time">${e.timestamp}</div>
        </div>
      </div>`;
  }).join("");
}

// Modal
function openModal(file, reason, ts, id, conf){
  const img    = document.getElementById("modalImg");
  const noImg  = document.getElementById("modalNoImg");
  const title  = document.getElementById("modalTitle");
  const meta   = document.getElementById("modalMeta");

  title.textContent = `Alert #${id}`;

  img.src           = "/" + file;
  img.style.display = "block";
  noImg.style.display = "none";

  img.onerror = ()=>{
    img.style.display   = "none";
    noImg.style.display = "flex";
  };

  function reasonColour(r){
    if(/phone/i.test(r))   return "#f85149";
    if(/leaning/i.test(r)) return "#d29922";
    if(/sharing/i.test(r)) return "#bc8cff";
    return "#8b949e";
  }
  const col = reasonColour(reason);

  meta.innerHTML = `
    <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:12px">
      <span style="color:var(--muted)">Alert ID</span><span>#${id}</span>
      <span style="color:var(--muted)">Confidence</span><span>${conf}%</span>
      <span style="color:var(--muted)">Reason</span><span style="color:${col};font-weight:600">⚠ ${reason}</span>
      <span style="color:var(--muted)">Time</span><span>${ts}</span>
    </div>`;

  document.getElementById("modal").classList.add("open");
}

function closeModal(){
  document.getElementById("modal").classList.remove("open");
  const img = document.getElementById("modalImg");
  if(img) img.src = "";
}

document.addEventListener("DOMContentLoaded",()=>{
  const modal = document.getElementById("modal");
  if(modal){
    modal.addEventListener("click", e=>{
      if(e.target === modal) closeModal();
    });
  }
  loadEvidence();
  setInterval(loadEvidence, 4000);
});