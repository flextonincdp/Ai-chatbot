function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

document.getElementById('logoutBtn').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
};

// ---------- Config & State ----------
let config = { maxFileSize: 25 * 1024 * 1024, supportedExtensions: [], maxFilesPerUpload: 15 };
let selectedFiles = []; // files pending upload

async function loadConfig() {
  if (window.location.protocol === 'file:') {
    document.getElementById('uploadHint').innerHTML = '<span style="color:red">Error: You must run the server (<code>npm start</code>) and open http://localhost:3000</span>';
    return;
  }

  try {
    const res = await fetch('/api/admin/config');
    if (res.ok) {
      config = await res.json();
      const exts = config.supportedExtensions.map(e => '.' + e.toUpperCase()).join(' • ');
      document.getElementById('uploadHint').textContent = `Up to ${config.maxFilesPerUpload} files, ${config.maxFileSizeMB}MB each`;
      document.getElementById('formatList').textContent = `Supported: ${exts}`;
      document.getElementById('fileInput').accept = config.supportedExtensions.map(e => '.' + e).join(',');
    } else {
      document.getElementById('uploadHint').textContent = 'Server returned an error while loading config.';
    }
  } catch (e) {
    console.warn('Failed to load config', e);
    document.getElementById('uploadHint').innerHTML = '<span style="color:red">Server unreachable. Is the Node server running?</span>';
  }
}

// ---------- KB list & Dashboard Stats ----------
async function loadKB() {
  const res = await fetch('/api/admin/kb');
  if (res.status === 401) { window.location.href = '/login.html'; return; }
  const data = await res.json();
  renderDashboard(data.docs, data.totalChunks, data.dbStats);
  renderDocList(data.docs);
}

function renderDashboard(docs, totalChunks, dbStats) {
  document.getElementById('statDocs').textContent = docs.length;
  const readyCount = docs.filter(d => d.status === 'ready' || d.status === 'READY').length;
  document.getElementById('statReady').textContent = readyCount;
}

function getStatusBadge(status, errorMsg) {
  const s = (status || 'ready').toLowerCase();
  if (s === 'ready' || s === 'indexed') return `<span class="badge badge-ready">✓ Ready</span>`;
  if (s === 'processing' || s === 'extracting' || s === 'chunking') return `<span class="badge badge-processing">↻ ${s}</span>`;
  if (s === 'failed' || s === 'error') {
    const errText = errorMsg ? `: ${errorMsg}` : '';
    return `<span class="badge badge-failed" title="${escapeHtml(errorMsg || 'Processing failed')}">✕ Failed${escapeHtml(errText)}</span>`;
  }
  if (s === 'duplicate') return `<span class="badge badge-duplicate">! Duplicate</span>`;
  if (s === 'queued') return `<span class="badge badge-processing">⏳ Queued</span>`;
  return `<span class="badge">${escapeHtml(s)}</span>`;
}

function getUnitDisplay(doc) {
  const parts = [];
  
  // Show slide count for PPTX
  if (doc.unitLabel === 'slides' && doc.slideCount != null && doc.slideCount > 0) {
    parts.push(`${doc.slideCount} slides`);
  }
  // Show page count for PDF/DOCX
  else if (doc.unitLabel === 'pages' && doc.pageCount != null && doc.pageCount > 0) {
    parts.push(`${doc.pageCount} pages`);
  }
  
  // Always show chunk count if available
  if (doc.chunkCount != null && doc.chunkCount > 0) {
    parts.push(`${doc.chunkCount} chunks`);
  }
  
  if (parts.length) return parts.join(' · ');
  return '—';
}

function renderDocList(docs) {
  const tbody = document.getElementById('docTableBody');
  const cardsBody = document.getElementById('docCardsBody');
  const emptyState = document.getElementById('docEmptyState');
  const tableWrap = document.getElementById('docTableWrap');

  if (!docs.length) {
    emptyState.style.display = 'block';
    tableWrap.style.display = 'none';
    cardsBody.style.display = 'none';
    return;
  }

  emptyState.style.display = 'none';
  tableWrap.style.display = 'block';
  cardsBody.style.display = 'block';

  // Sort by newest first
  docs.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));

  let trs = '';
  let cards = '';

  docs.forEach(d => {
    const name = escapeHtml(d.name || d.originalFilename);
    const type = escapeHtml((d.type || d.extension || '').toUpperCase());
    const units = escapeHtml(getUnitDisplay(d));
    const size = formatSize(d.size);
    const badge = getStatusBadge(d.status, d.processingError);
    const date = formatDate(d.uploadedAt);
    const docId = d.documentId || d.id;

    // Table row
    trs += `
      <tr>
        <td>
          <div class="doc-name" title="${name}">${name}</div>
        </td>
        <td><span class="badge-type">${type}</span></td>
        <td><span class="doc-meta">${size}</span></td>
        <td><span class="doc-meta">${units}</span></td>
        <td>${badge}</td>
        <td><span class="doc-meta">${date}</span></td>
        <td>
          <button class="danger-ghost del-btn" data-id="${escapeHtml(docId)}">Delete</button>
        </td>
      </tr>
    `;

    // Mobile card
    cards += `
      <div class="doc-card-item">
        <div class="doc-card-header">
          <div class="doc-card-name">${name}</div>
          <div>${badge}</div>
        </div>
        <div class="doc-card-details">
          <span><span class="badge-type">${type}</span></span>
          <span>${size}</span>
          <span>${units}</span>
          <span>${date}</span>
        </div>
        <div class="doc-card-actions">
          <button class="danger-ghost del-btn" data-id="${escapeHtml(docId)}">Delete</button>
        </div>
      </div>
    `;
  });

  tbody.innerHTML = trs;
  cardsBody.innerHTML = cards;

  // Bind delete handlers
  document.querySelectorAll('.del-btn').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('Are you sure you want to delete this document and its indexed chunks?')) return;
      btn.disabled = true;
      btn.textContent = 'Deleting...';
      try {
        const res = await fetch('/api/admin/kb/' + btn.dataset.id, { method: 'DELETE' });
        if (res.ok) {
          const data = await res.json();
          renderDashboard(data.docs, data.totalChunks);
          renderDocList(data.docs);
        } else {
          alert('Delete failed');
          btn.disabled = false;
          btn.textContent = 'Delete';
        }
      } catch(e) {
        alert('Delete failed: ' + e.message);
        btn.disabled = false;
        btn.textContent = 'Delete';
      }
    };
  });
}

// ---------- File selection & Upload ----------
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const fileList = document.getElementById('fileList');
const processBtn = document.getElementById('processBtn');
const clearBtn = document.getElementById('clearBtn');
const uploadLog = document.getElementById('uploadLog');

dropzone.onclick = () => fileInput.click();

dropzone.ondragover = e => {
  e.preventDefault();
  dropzone.classList.add('dragover');
};
dropzone.ondragleave = () => {
  dropzone.classList.remove('dragover');
};
dropzone.ondrop = e => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  addFiles(Array.from(e.dataTransfer.files));
};
fileInput.onchange = () => {
  addFiles(Array.from(fileInput.files));
  fileInput.value = ''; // reset so same file can be selected again
};

function addFiles(files) {
  // Check limits
  if (selectedFiles.length + files.length > config.maxFilesPerUpload) {
    alert(`You can only upload up to ${config.maxFilesPerUpload} files at once.`);
    files = files.slice(0, config.maxFilesPerUpload - selectedFiles.length);
  }
  
  files.forEach(f => {
    if (!selectedFiles.some(existing => existing.name === f.name && existing.size === f.size)) {
      selectedFiles.push(f);
    }
  });
  
  renderFileList();
}

function removeFile(index) {
  selectedFiles.splice(index, 1);
  renderFileList();
}

clearBtn.onclick = () => {
  selectedFiles = [];
  renderFileList();
  uploadLog.innerHTML = '';
};

function renderFileList() {
  if (!selectedFiles.length) {
    fileList.innerHTML = '';
    processBtn.style.display = 'none';
    clearBtn.style.display = 'none';
    return;
  }
  
  processBtn.style.display = 'inline-block';
  clearBtn.style.display = 'inline-block';
  processBtn.textContent = `Upload & Process ${selectedFiles.length} file(s)`;
  processBtn.disabled = false;
  
  fileList.innerHTML = selectedFiles.map((f, i) => `
    <div class="file-list-item">
      <div class="file-info">
        <span class="file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
        <span class="file-size">${formatSize(f.size)}</span>
      </div>
      <button class="file-remove" onclick="removeFile(${i})" title="Remove file">×</button>
    </div>
  `).join('');
}

processBtn.onclick = async () => {
  if (!selectedFiles.length) return;
  
  processBtn.disabled = true;
  processBtn.textContent = 'Uploading...';
  clearBtn.style.display = 'none';
  uploadLog.innerHTML = '';
  
  // Disable remove buttons during upload
  document.querySelectorAll('.file-remove').forEach(btn => btn.style.display = 'none');
  
  const formData = new FormData();
  selectedFiles.forEach(f => formData.append('files', f));
  
  try {
    // In a full implementation, we'd use XMLHttpRequest for byte-level progress here.
    // Given the constraints and simplicity, we'll use fetch and rely on the robust
    // backend response for stage logs.
    const res = await fetch('/api/admin/upload', {
      method: 'POST',
      body: formData
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    
    // Render the log results
    uploadLog.innerHTML = data.log.map(l => {
      let icon = 'ℹ️';
      let statusClass = 'skipped';
      let detail = l.reason || '';
      
      if (l.status === 'indexed') {
        icon = '✓';
        statusClass = 'success';
        const doc = l.document;
        detail = `${getUnitDisplay(doc)} • ${l.chunks} chunks indexed`;
      } else if (l.status === 'error') {
        icon = '✕';
        statusClass = 'error';
      } else if (l.status === 'duplicate') {
        icon = '⚠️';
        statusClass = 'duplicate';
      }
      
      return `
        <div class="upload-log-item ${statusClass}">
          <div class="log-icon">${icon}</div>
          <div>
            <div class="log-filename">${escapeHtml(l.file)}</div>
            <div class="log-detail">${escapeHtml(detail)}</div>
          </div>
        </div>
      `;
    }).join('');
    
    // Refresh KB list
    renderDashboard(data.docs, data.totalChunks, data.dbStats);
    renderDocList(data.docs);
    
  } catch (e) {
    let errorDetail = e.message;
    if (e.message === 'Failed to fetch' || window.location.protocol === 'file:') {
      errorDetail = 'Failed to connect to the server. Ensure you are running it (node server.js) and accessing it via http://localhost:3000.';
    }
    uploadLog.innerHTML = `<div class="upload-log-item error">
      <div class="log-icon">✕</div>
      <div>
        <div class="log-filename">Upload Error</div>
        <div class="log-detail">${escapeHtml(errorDetail)}</div>
      </div>
    </div>`;
  }
  
  // Clear selection after upload attempt
  selectedFiles = [];
  renderFileList();
  processBtn.disabled = false;
  processBtn.textContent = 'Upload & Process';
  processBtn.style.display = 'none';
  clearBtn.style.display = 'none';
};

// Init
loadConfig();
loadKB();
