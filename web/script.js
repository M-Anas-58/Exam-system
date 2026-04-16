// State variables to keep track of the exam and student data
let examRunning     = false;
let sessionEnded    = false;
let studentsLoaded  = false;
let attendanceData  = [];
let selectedFile    = null;
let alertTimeout1, alertTimeout2;

// Load previous event logs from the browser's memory so they don't disappear on refresh
let eventLogData = JSON.parse(sessionStorage.getItem("examguard_logs")) || [];

// When the page loads, immediately show any saved logs
window.addEventListener('DOMContentLoaded', () => {
    const log = document.getElementById("eventLog");
    if (log && eventLogData.length > 0) {
        eventLogData.forEach(e => {
            const div = document.createElement("div");
            div.className = `event-item ${e.type}`;
            div.innerHTML = `<div class="event-msg">${e.msg}</div><div class="event-ts">${e.ts}</div>`;
            log.prepend(div);
        });
    }
});

// Helper function to get the current time formatted nicely
function nowFull() { return new Date().toLocaleString(); }

// Keep the dashboard buttons and badges synced with the Python backend
function pollStatus() {
  fetch("/api/status").then(r => r.json()).then(d => {
    
    const btn = document.getElementById("examBtn");
    const badge = document.getElementById("examBadge");
    const logBadge = document.getElementById("logStatus");
    const dr = document.getElementById("downloadRow");

    // Update buttons based on whether the exam is running or stopped
    if (d.exam_running && !examRunning) {
        if (btn) { btn.textContent = "⏹ End Session"; btn.className = "btn btn-danger"; }
        if (badge) { badge.textContent = "RUNNING"; badge.className = "badge badge-running"; }
        if (logBadge) { logBadge.textContent = "Live"; logBadge.className = "badge badge-running"; }
    } else if (!d.exam_running && d.session_ended && !sessionEnded) {
        if (btn) { btn.textContent = "▶ Start Session"; btn.className = "btn btn-success"; }
        if (badge) { badge.textContent = "STANDBY"; badge.className = "badge badge-standby"; }
        if (logBadge) { logBadge.textContent = "Ended"; logBadge.className = "badge badge-standby"; }
    }

    // Show download buttons only if an exam happened
    if (dr) {
        if (d.exam_running || d.session_ended) dr.classList.remove("hidden");
        else dr.classList.add("hidden");
    }

    examRunning    = d.exam_running;
    sessionEnded   = d.session_ended;
    studentsLoaded = d.students_loaded;

    // Update the AI Suspicion Score percentage
    const aiEl = document.getElementById("statAIScore");
    if (aiEl) {
      const score = d.ai_score || 0;
      if (!examRunning || score === 0) {
        aiEl.textContent = "--"; aiEl.style.color = "var(--text)";
      } else {
        aiEl.textContent = score + "%";
        // Change color to red if high, orange if medium, green if low
        aiEl.style.color = score >= 70 ? "#f85149" : score >= 45 ? "#d29922" : "#3fb950";
      }
    }
  }).catch(() => {});
}

// Fetch new alerts from the server every second
function pollEvents() {
    fetch("/api/alerts").then(r => r.json()).then(list => {
        if (list.length > 0) {
            list.forEach(e => appendEventToDOM(e));
            eventLogData.push(...list); 
            
            // Save logs to browser memory
            sessionStorage.setItem("examguard_logs", JSON.stringify(eventLogData));

            // Make the alert card flash red if cheating is detected
            if (examRunning && list.some(e => e.type === "warning")) {
                triggerAlertBlink();
            }
        }
    }).catch(() => {});
}

// Log actions (like downloads) locally without sending to the Python backend
function logLocalEvent(msg, type="info") {
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19); 
    const ev = { type: type, msg: msg, ts: ts };
    appendEventToDOM(ev);
    eventLogData.push(ev);
    sessionStorage.setItem("examguard_logs", JSON.stringify(eventLogData));
}

// Add a new message to the visual event log box
function appendEventToDOM(e) {
    const log = document.getElementById("eventLog");
    if (!log) return;
    const div = document.createElement("div");
    div.className = `event-item ${e.type}`;
    div.innerHTML = `<div class="event-msg">${e.msg}</div><div class="event-ts">${e.ts}</div>`;
    log.prepend(div);
    
    // Remove old logs if there are more than 150 to keep the page fast
    while (log.children.length > 150) log.removeChild(log.lastChild);

    const ticker = document.getElementById("alertTicker");
    if (ticker && examRunning) ticker.textContent = e.msg;
}

// Handle the sliding camera settings input
let isCamInputOpen = false;
function toggleCameraInput() {
    const inp = document.getElementById("camInput");
    const btn = document.getElementById("setCamBtn");

    if (!isCamInputOpen) {
        // Open the input box
        inp.classList.add("show");
        inp.focus();
        btn.textContent = "✔ Confirm";
        btn.className = "btn btn-blue btn-sm";
        isCamInputOpen = true;
    } else {
        // Send the new camera address to the backend
        const val = inp.value.trim();
        if (val) setCamera(val);
        inp.classList.remove("show");
        btn.textContent = "⚙ Set Camera";
        btn.className = "btn btn-outline btn-sm";
        isCamInputOpen = false;
    }
}

// Tell the backend to switch cameras
function setCamera(src) {
    const btn = document.getElementById("setCamBtn");
    btn.disabled = true;
    btn.textContent = "Connecting…";
    fetch("/api/set_camera", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: src })
    }).then(r => r.json()).then(d => {
        btn.disabled = false;
        btn.textContent = "⚙ Set Camera";
        pollEvents(); 
    }).catch(() => { btn.disabled = false; btn.textContent = "⚙ Set Camera"; });
}

// Make the alert card flash red for 9 seconds when cheating happens
function triggerAlertBlink() {
  const card   = document.getElementById("alertCard");
  const status = document.getElementById("alertStatus");
  if (!card) return;

  clearTimeout(alertTimeout1);
  clearTimeout(alertTimeout2);

  card.classList.add("blink");
  if(status) {
    status.textContent = "⚠ Cheating detected!";
    status.style.color = "var(--red)";
    
    alertTimeout1 = setTimeout(()=>{ 
        status.textContent = "Monitoring…"; 
        status.style.color = "var(--text2)"; 
    }, 9000); 
  }
  
  alertTimeout2 = setTimeout(() => card.classList.remove("blink"), 9000);
}

// Update the live clock on the dashboard
function startClock(){
  setInterval(() => {
    const el = document.getElementById("statClock");
    if(!el) return;
    const now = new Date();
    el.textContent = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}`;
  }, 1000);
}
startClock();

// Get the latest attendance data from the server
function pollStudents() {
  fetch("/api/students").then(r => r.json()).then(list => {
    if (attendanceData.length !== list.length) {
      attendanceData = list;
      renderRoster(list);
    }
    const present = list.filter(s => s.present).length;
    const pb = document.getElementById("presentBadge");
    if (pb) pb.textContent = `${present} / ${list.length}`;
  }).catch(() => {});
}

// Draw the list of students on the right side of the screen
function renderRoster(list) {
  const roster = document.getElementById("rosterList");
  if (!roster) return;

  if (list.length === 0) {
    roster.innerHTML = `<div style="padding:16px;text-align:center;color:var(--muted);font-size:12px">Upload student file to begin…</div>`;
    return;
  }

  roster.innerHTML = list.map(s => {
    const checked = s.present ? "checked" : "";
    const rowCls  = s.present ? "roster-item present" : "roster-item";
    return `
      <div class="${rowCls}" id="row-${s.roll}">
        <div class="roster-avatar">${s.name.charAt(0).toUpperCase()}</div>
        <div class="roster-info">
          <div class="roster-name">${s.name}</div>
          <div class="roster-roll">${s.roll}</div>
        </div>
        <div style="display:flex; align-items:center; gap:10px;">
          <span id="status-${s.roll}" style="font-size:11px; font-weight:600; width:45px; text-align:right; color:${s.present ? 'var(--green)' : 'var(--muted)'};">
            ${s.present ? 'Present' : 'Absent'}
          </span>
          <label class="toggle-switch">
            <input type="checkbox" ${checked} onchange="onCheckChange('${s.roll}', this.checked)">
            <span class="slider"></span>
          </label>
        </div>
      </div>`;
  }).join("");
}

// Handle what happens when a teacher clicks the Present/Absent switch
function onCheckChange(roll, isChecked) {
  const row = document.getElementById(`row-${roll}`);
  const statusText = document.getElementById(`status-${roll}`);

  if (row) row.className = isChecked ? "roster-item present" : "roster-item";
  if (statusText) {
    statusText.textContent = isChecked ? "Present" : "Absent";
    statusText.style.color = isChecked ? "var(--green)" : "var(--muted)";
  }

  const student = attendanceData.find(s => s.roll === roll);
  if (student) student.present = isChecked;

  // Send the updated attendance to the backend
  const presentRolls = attendanceData.filter(s => s.present).map(s => s.roll);
  fetch("/api/mark_attendance", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ present: presentRolls })
  }).catch(err => console.error("Auto-save failed:", err));
}

// Start running the background checks every few seconds
setInterval(pollStatus,   2000);
setInterval(pollStudents, 3500);
setInterval(pollEvents,   1500);
pollStatus();
pollStudents();
pollEvents();

// Handle the Start/Stop Session button
function handleStartBtn() {
  if (examRunning) {
    if (confirm("End session? Attendance is automatically saved.")) endSession();
  } else { openUploadModal(); }
}

function startSession() {
  fetch("/api/toggle_exam", { method: "POST" })
    .then(r => r.json()).then(d => {
      if (!d.success) return;
      pollStatus(); pollEvents(); pollStudents();
    });
}

function endSession() {
  fetch("/api/toggle_exam", { method: "POST" })
    .then(r => r.json()).then(d => {
      if (!d.success) return;
      pollStatus(); pollEvents();
      document.getElementById("rosterList").innerHTML = `<div style="padding:16px;text-align:center;color:var(--muted);font-size:12px">Session ended. Start new session to reload students.</div>`;
    });
}

// Control the Excel Upload window
function openUploadModal() { document.getElementById("uploadModal").classList.add("open"); }
function closeUploadModal() {
    document.getElementById("uploadModal").classList.remove("open");
    selectedFile = null;
    document.getElementById("filePreview").style.display = "none";
    document.getElementById("uploadError").style.display = "none";
    document.getElementById("uploadBtn").disabled = true;
}

function handleFileSelect(e) { setSelectedFile(e.target.files[0]); }
function handleDrop(e) { e.preventDefault(); document.getElementById("dropZone").classList.remove("drag-over"); setSelectedFile(e.dataTransfer.files[0]); }
function setSelectedFile(file) {
  if (!file.name.match(/\.(xlsx|xls)$/i)) { showUploadError("Only .xlsx or .xls"); return; }
  selectedFile = file;
  document.getElementById("filePreview").style.display = "flex";
  document.getElementById("fileName").textContent = file.name;
  document.getElementById("uploadError").style.display = "none";
  document.getElementById("uploadBtn").disabled = false;
}

function showUploadError(msg) {
  const el = document.getElementById("uploadError");
  el.textContent = msg; el.style.display = "block";
}

function uploadFile() {
  const btn = document.getElementById("uploadBtn");
  btn.textContent = "Uploading…"; btn.disabled = true;

  const fd = new FormData(); fd.append("file", selectedFile);
  fetch("/api/upload_students", { method: "POST", body: fd })
    .then(r => r.json()).then(d => {
      if (!d.success) { showUploadError(d.message); btn.textContent = "✔ Upload & Continue"; btn.disabled = false; return; }
      closeUploadModal();
      pollStudents();
      setTimeout(startSession, 300);
    });
}

// Generate text files for downloading reports
function downloadAttendance() {
  const present = attendanceData.filter(s => s.present);
  const absent  = attendanceData.filter(s => !s.present);
  const lines = ["ExamGuard AI – Attendance Report", "Generated: " + nowFull(), "=".repeat(55), ""];
  
  lines.push("PRESENT STUDENTS", "─".repeat(40));
  if (present.length) present.forEach(s => lines.push(`${s.roll.padEnd(10)}|  ${s.name.padEnd(25)}|  PRESENT`));
  else lines.push("  None");

  lines.push("", "ABSENT STUDENTS", "─".repeat(40));
  if (absent.length) absent.forEach(s => lines.push(`${s.roll.padEnd(10)}|  ${s.name.padEnd(25)}|  ABSENT`));
  else lines.push("  None");

  lines.push("", "=".repeat(55), `Total: ${attendanceData.length}  |  Present: ${present.length}  |  Absent: ${absent.length}`);
  downloadTxt(lines.join("\n"), "attendance_report.txt");
  
  logLocalEvent("Attendance report downloaded", "info");
}

function downloadEventLog() {
  const lines = ["ExamGuard AI – Event Log", "Generated: " + nowFull(), "=".repeat(55), ""];
  eventLogData.forEach(e => lines.push(`[${e.ts}]  [${e.type.toUpperCase().padEnd(7)}]  ${e.msg}`));
  lines.push("", "=".repeat(55), `Total events: ${eventLogData.length}`);
  downloadTxt(lines.join("\n"), "event_log.txt");
  
  logLocalEvent("Event log downloaded", "info");
}

function downloadTxt(content, filename) {
  const a = document.createElement("a");
  a.href = "data:text/plain;charset=utf-8," + encodeURIComponent(content);
  a.download = filename;
  a.click();
}