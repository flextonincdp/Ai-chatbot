// ---------- Helpers ----------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatCoreFeaturesCatalogue(text) {
  const original = String(text || '')
    // Repair headings that were previously flattened onto the same line.
    .replace(/(\S)\s+(#{1,6}\s+(?:Source:|Core Features\b|Sources\b))/gi, '$1\n\n$2')
    .replace(/(#{1,6}\s+Core Features)\s+(?=\d+\.)/i, '$1\n\n')
    .replace(/(#{1,6}\s+Sources)\s*-\s+/i, '$1\n\n- ')
    // A duplicated marker is corrupted title syntax, not a deeper heading.
    .replace(/^\s*#{1,6}\s+#+\s*/gm, '# ');
  const compact = original.replace(/\s+/g, ' ').trim();
  const sections = [
    ['User Login & Access', ['User Login', 'User Roles', 'Role-Based Access Control (RBAC)', 'Document-Level Permissions']],
    ['Document Management', ['Upload Case Studies', 'Upload Proposals', 'Upload Presentations', 'Upload Technical Documents', 'Document Metadata', 'Document Version Management', 'Bulk Document Upload', 'Document Reprocessing / Retry', 'Background Document Processing']],
    ['AI Search', ['Keyword Search', 'Semantic Search', 'Natural Language Search', 'Hybrid Search', 'Permission-Aware Search', 'Relevant Document Retrieval', 'Search by Technology / Industry / Project Metadata', 'Search Result Re-ranking']],
    ['AI RAG & Summary', ['RAG-Based Question Answering', 'Retrieve Relevant Document Content', 'Permission-Aware RAG', 'AI-Generated Summary', 'Source References', 'Page / Slide References']],
    ['Related Slides & Case Studies', ['Search Presentation Content', 'Find Related Slides', 'Show Slide Numbers', 'Find Similar Case Studies', 'Related Document Recommendations']]
  ];
  if (!/\bcore features\b/i.test(compact)) return original;

  const detectedSections = sections
    .map(([title, items], index) => ({
      title,
      index,
      items: items.filter(item => compact.includes(item))
    }))
    .filter(section => compact.includes(section.title) && section.items.length > 0);
  if (!detectedSections.length) return original;

  const catalogue = `## Core Features\n\n${detectedSections.map(section =>
    `### ${section.index + 1}. ${section.title}\n\n${section.items.map(item => `- ${item}`).join('\n')}`
  ).join('\n\n')}`;
  const coreHeading = /^\s*#{1,6}\s+Core Features\s*$/im;
  const sourcesHeading = /(?:^|\s)##\s+Sources\b/i;
  const coreMatch = coreHeading.exec(original);

  // Repair previously saved responses while preserving their document title,
  // source attribution, and Sources section.
  if (coreMatch) {
    const before = original.slice(0, coreMatch.index);
    const afterStart = coreMatch.index + coreMatch[0].length;
    const after = original.slice(afterStart);
    const sourcesMatch = sourcesHeading.exec(after);
    return `${before}${catalogue}\n\n${sourcesMatch ? after.slice(sourcesMatch.index).trim() : ''}`.trim();
  }

  // Older fallback answers may have the document title followed immediately by
  // malformed source markers such as ")** **Core Features**". Keep the title
  // while replacing the corrupted body with the clean catalogue.
  const coreIndex = original.search(/\bcore features\b/i);
  const beforeCore = coreIndex >= 0
    ? original.slice(0, coreIndex).replace(/[\s)*]+$/g, '').trim()
    : '';
  return `${beforeCore ? `${beforeCore}\n\n` : ''}${catalogue}`.trim();
}

// Source text from OCR can arrive as one continuous line, for example:
// "Core Features 1. Access 2. Search".  Render a genuine heading and ordered
// list instead of exposing that unformatted source text to the user.
function normalizeInlineNumberedSections(text) {
  const original = String(text || '')
    // A title should never display a second, literal Markdown marker (for
    // example, "### # Core Features").
    .replace(/^(\s*#{1,6})\s+#+\s*/gm, '$1 ');
  // Only repair flattened source text. Existing Markdown already contains
  // intentional structure, so preserve its title, source, and list blocks.
  if (/(^|\r?\n)\s*(?:#{1,6}\s+|[-*]\s+|\d+\.\s+)/m.test(original)) return original;

  const compact = original.replace(/\s+/g, ' ').trim();
  if (!compact || /<\/?[a-z][^>]*>/i.test(compact)) return text;

  const matches = [...compact.matchAll(/(?:^|\s)(\d{1,2})\.\s+(?=[A-Z])/g)];
  if (matches.length < 2) return text;

  const lead = compact.slice(0, matches[0].index).trim();
  if (lead.length > 100) return text;

  const items = matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : compact.length;
    return `${match[1]}. ${compact.slice(start, end).replace(/\s+\d+\.\s*$/, '').trim()}`;
  }).filter(item => item.length > 3);

  return items.length >= 2
    ? `${lead ? `## ${lead}\n\n` : ''}${items.join('\n')}`
    : text;
}

function removeRedundantSourceBlocks(text) {
  return String(text || '')
    // Source documents are shown in the dedicated source panel below the
    // answer, so do not repeat their file names as document headings.
    .replace(/^\s*#{1,6}\s+Source:\s*.+?(?:\r?\n|$)/gim, '')
    .replace(/(?:^|\r?\n)\s*#{1,6}\s+Sources\s*\r?\n\s*[-*]\s*.+?(?=\r?\n\s*\r?\n|$)/gim, '')
    .replace(/^\s*#{1,6}\s+Sources\s*-\s*.+?(?:\r?\n|$)/gim, '')
    .trim();
}

function normalizeProfessionalReport(text) {
  const original = String(text || '');
  // Keep ordinary short answers untouched. Report-like answers get a
  // deterministic presentation cleanup before Markdown rendering.
  if (!/\b(?:business insight|expected outcome|recommendation|conclusion|analysis|summary report)\b/i.test(original)) return original;

  let processed = original
    .replace(/([^\n])\s+(#{1,3}\s+(?=[A-Z0-9]))/g, '$1\n\n$2')
    .replace(/^#\s*Explanation of\s+/gim, '# ')
    .replace(/\b([Rr])\s+ecommendation\b/g, '$1ecommendation')
    .replace(/([A-Za-z])[ \t]+-[ \t]+([A-Za-z])/g, '$1-$2')
    .replace(/\s+Business Insight\s+(?=[A-Z])/gi, '\n\n### Business Insight\n')
    .replace(/\s+(Expected Outcome:)\s*/gi, '\n\n### $1\n')
    .replace(/^(#{1,3})\s+(Conclusion|Executive Summary|Strategic Recommendations|References|Sources)\s+(.+)$/gim, '$1 $2\n$3')
    .replace(/^(?:#{1,3}\s+)?Recommendation\s+(\d+)\s+(.+)$/gim, '## Recommendation $1\n$2')
    .replace(/^(#{1,3})\s+\d+\.\s+(.+)$/gm, '## $2')
    .replace(/^(##\s+Discount Intensity)\s*=\s*(.+)$/gim, '$1\n$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  let titleSeen = false;
  processed = processed.split('\n').map(line => {
    if (!/^#\s+\S/.test(line)) return line;
    if (!titleSeen) {
      titleSeen = true;
      return line;
    }
    return `## ${line.slice(2).trim()}`;
  }).join('\n');

  const seen = new Set();
  const sections = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    const section = current.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    const key = section.toLowerCase().replace(/\s+/g, ' ');
    if (section && !seen.has(key)) {
      seen.add(key);
      sections.push(section);
    }
    current = [];
  };
  for (const line of processed.split('\n')) {
    if (/^#{1,3}\s+\S/.test(line) && current.length) flush();
    current.push(line);
  }
  flush();
  return sections.join('\n\n');
}

function cleanAnswer(text) {
  if (!text) return '';
  // Clean up source references and un-flattened lists
  let processed = removeRedundantSourceBlocks(normalizeProfessionalReport(normalizeInlineNumberedSections(formatCoreFeaturesCatalogue(text))));
  
  // Use marked.js for professional, bug-free Markdown rendering
  // We configure it to break on newlines like GitHub flavored markdown
  return marked.parse(processed, { breaks: true });
}

function getExt(filename) {
  return filename.split('.').pop().toUpperCase();
}

// ---------- Logout ----------
document.getElementById('logoutBtn').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
};

// ---------- State ----------
let conversationId = null;
const conversationStorageKey = 'knowledgeStudioConversationId';
let chartInstances = {}; // To store active Chart.js instances

// ---------- Elements ----------
const askBtn = document.getElementById('askBtn');
const queryInput = document.getElementById('queryInput');
const askStatus = document.getElementById('askStatus');
const chatHistory = document.getElementById('chatHistory');
const sessionListEl = document.getElementById('sessionList');
const newSessionBtn = document.getElementById('newSessionBtn');


function appendUserMessage(text) {
  const msg = document.createElement('div');
  msg.className = 'message user';
  msg.innerHTML = `<div class="bubble-content">${escapeHtml(text)}</div>`;
  chatHistory.appendChild(msg);
  scrollToBottom();
}

async function restoreConversation() {
  if (!conversationId) {
    const stored = localStorage.getItem(conversationStorageKey);
    if (stored) conversationId = stored;
  }
  if (!conversationId) {
    showWelcomeScreen();
    return;
  }

  try {
    const response = await fetch(`/api/chat/history/${encodeURIComponent(conversationId)}`);
    if (!response.ok) {
      localStorage.removeItem(conversationStorageKey);
      conversationId = null;
      showWelcomeScreen();
      return;
    }
    const data = await response.json();
    
    // Clear chat
    chatHistory.innerHTML = '';
    
    // Render messages
    for (const message of data.history) {
      if (message.role === 'user') appendUserMessage(message.content);
      else appendAssistantMessage(message);
    }
    
    // (Info Panel removed per user request)
    
    // Highlight active session
    renderSessionList(window._sessions || [], conversationId);
    
  } catch (error) {
    console.warn('Unable to restore conversation:', error);
  }
}

function showWelcomeScreen() {
  chatHistory.innerHTML = `
    <div class="message assistant" id="welcomeMessage">
      <div class="bubble-content welcome-content">
        <div class="welcome-logo">KS</div>
        <div class="welcome-title">Knowledge Studio</div>
        <div class="welcome-desc">Your organization's knowledge, ready to explore.</div>
      </div>
    </div>
  `;

}

function appendAssistantMessage(data) {
  const msg = document.createElement('div');
  msg.className = 'message assistant';
  
  let html = `<div class="bubble-content answer">`;
  
  // Text answer — render as clean HTML (the LLM outputs HTML, not markdown)
  if (data.answer) {
    html += cleanAnswer(data.answer);
  }

  // NOTE: fallbackNotice is intentionally NOT shown to users.
  // The system always provides meaningful content even under LLM failure.

  // Sources
  // Source provenance is authoritative only when the backend has confirmed a
  // successfully grounded answer. Do not infer sources from any other fields.
  // This list is constructed by the API from the Answer record's final
  // sourceDocumentIds. Candidate retrieval labels are never a UI fallback.
  const finalSources = data.grounded === true && Array.isArray(data.sourceDocuments)
    ? data.sourceDocuments
    : [];
  if (finalSources.length > 0) {
    html += `<div class="sources-section">
               <div class="sources-title">Sources</div>
               <div class="source-tags">`;
    html += finalSources.map(source => {
      const label = `<span class="source-icon">📄</span> ${escapeHtml(source.name)}`;
      // Sources establish provenance. They are labels, not implicit file
      // downloads: a source PDF must never surface a download action while a
      // user has only asked for an answer or a short summary.
      return `<span class="source-tag">${label}</span>`;
    }).join('');
    html += `  </div>
             </div>`;
  }

  // Refusal notes are now gracefully handled by the LLM in the main text answer.
  
  // Artifacts (documents and diagrams)
  const hasGeneratedArtifacts = Array.isArray(data.artifacts) && data.artifacts.length > 0;
  if (data.document || data.diagram) {
    html += `<div class="artifacts-container">`;
    html += `<div class="sources-title">${hasGeneratedArtifacts ? 'Generated Files' : 'Available File'}</div>`;
    
    if (data.diagram) {
      html += `
        <div class="artifact-card">
          <div class="artifact-header">
            <span class="artifact-icon">📊</span>
            <span class="artifact-title">Professional Diagram</span>
          </div>
          <div class="svg-preview">${data.diagram.svg}</div>
          <a href="${data.diagram.downloadUrl}" class="download-btn" download>
            <span>⬇</span> Download SVG
          </a>
        </div>
      `;
    }
    
    if (data.document) {
      html += `
        <div class="artifact-card">
          <div class="artifact-header">
            <span class="artifact-icon">📑</span>
            <span class="artifact-title">Generated ${data.document.format.toUpperCase()}</span>
          </div>
          <div class="artifact-filename">${escapeHtml(data.document.filename)}</div>
          <a href="${data.document.downloadUrl}" class="download-btn" download>
            <span>⬇</span> Download ${data.document.format.toUpperCase()}
          </a>
        </div>
      `;
    }
    
    html += `</div>`;
  }

  html += `</div>`;
  msg.innerHTML = html;
  chatHistory.appendChild(msg);
  scrollToBottom();
}

function appendThinkingIndicator() {
  const msg = document.createElement('div');
  msg.className = 'message assistant thinking-msg';
  msg.id = 'thinkingIndicator';
  msg.innerHTML = `<div class="bubble-content thinking">
    <div class="thinking-dots">
      <span></span><span></span><span></span>
    </div>
    <span class="thinking-text">Analyzing your request...</span>
  </div>`;
  chatHistory.appendChild(msg);
  scrollToBottom();
}

function removeThinkingIndicator() {
  const el = document.getElementById('thinkingIndicator');
  if (el) el.remove();
}

function scrollToBottom() {
  chatHistory.scrollTop = chatHistory.scrollHeight;
}

// ---------- Ask on Enter ----------
queryInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    askBtn.click();
  }
});

// ---------- Ask Question ----------
askBtn.onclick = async () => {
  const q = queryInput.value.trim();
  if (!q) return;

  // Hide welcome screen on first message
  const welcome = document.getElementById('welcomeMessage');
  if (welcome) welcome.remove();

  appendUserMessage(q);
  queryInput.value = '';
  askBtn.disabled = true;
  askStatus.textContent = '';
  appendThinkingIndicator();

  try {
    const res = await fetch('/api/chat/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, conversationId, activeDocumentId: window.activeDocumentId || null })
    });

    removeThinkingIndicator();

    if (res.status === 401) {
      window.location.href = '/login.html';
      return;
    }

    const data = await res.json();
    if (data.error) throw new Error(data.error);

    // Save conversationId for followups
    if (data.conversationId && data.conversationId !== conversationId) {
       conversationId = data.conversationId;
       localStorage.setItem(conversationStorageKey, conversationId);
       loadSessions(); // reload sidebar to show new session
    }

    appendAssistantMessage(data);
    
    // (Info Panel removed per user request)

  } catch (e) {
    removeThinkingIndicator();
    const errMsg = document.createElement('div');
    errMsg.className = 'message assistant';
    errMsg.innerHTML = `<div class="bubble-content error-bubble">Something went wrong: ${escapeHtml(e.message)}</div>`;
    chatHistory.appendChild(errMsg);
    scrollToBottom();
  }

  askBtn.disabled = false;
  queryInput.focus();
};

// ---------- Session Sidebar ----------
async function loadSessions() {
  try {
    const res = await fetch('/api/chat/sessions');
    if (res.ok) {
      const sessions = await res.json();
      window._sessions = sessions; // cache
      renderSessionList(sessions, conversationId);
    }
  } catch (e) {
    console.warn('Failed to load sessions', e);
  }
}

function renderSessionList(sessions, activeId) {
  sessionListEl.innerHTML = '';
  if (!sessions || sessions.length === 0) {
    sessionListEl.innerHTML = '<div style="font-size: 12px; color: var(--text-muted); text-align: center; margin-top: 10px;">No recent chats</div>';
    return;
  }
  
  sessions.forEach(s => {
    const div = document.createElement('div');
    div.className = 'session-item' + (s.id === activeId ? ' active' : '');
    div.addEventListener('click', () => {
      conversationId = s.id;
      localStorage.setItem(conversationStorageKey, conversationId);
      restoreConversation();
    });
    
    const title = s.title || 'New Conversation';
    const date = new Date(s.updated_at || s.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    
    div.innerHTML = `
      <div class="session-item-main">
        <div class="session-item-title">${s.is_pinned ? '<span class="session-pin" aria-label="Pinned">&#128204;</span>' : ''}${escapeHtml(title)}</div>
        <button class="session-menu-btn" type="button" aria-label="Conversation actions" title="Conversation actions">&#8942;</button>
      </div>
      <div class="session-item-date">${escapeHtml(date)}</div>
      <div class="session-actions" hidden>
        <button type="button" data-action="pin">${s.is_pinned ? 'Unpin conversation' : 'Pin conversation'}</button>
        <button type="button" data-action="rename">Rename</button>
        <button type="button" data-action="delete" class="danger">Delete</button>
      </div>
    `;

    const menu = div.querySelector('.session-actions');
    const menuButton = div.querySelector('.session-menu-btn');
    menuButton.addEventListener('click', event => {
      event.stopPropagation();
      const isOpen = !menu.hidden;
      document.querySelectorAll('.session-actions').forEach(other => { other.hidden = true; });
      menu.hidden = isOpen;
    });
    menu.addEventListener('click', async event => {
      event.stopPropagation();
      const action = event.target.closest('button')?.dataset.action;
      if (!action) return;
      menu.hidden = true;
      if (action === 'pin') {
        await updateConversation(s.id, { pinned: !Boolean(s.is_pinned) });
      } else if (action === 'rename') {
        const proposed = window.prompt('Rename conversation', title);
        if (proposed === null) return;
        const cleanTitle = proposed.replace(/\s+/g, ' ').trim();
        if (!cleanTitle) return window.alert('Conversation name cannot be empty.');
        await updateConversation(s.id, { title: cleanTitle });
      } else if (action === 'delete') {
        if (!window.confirm(`Delete "${title}"? This also removes its messages and generated files.`)) return;
        await deleteConversation(s.id);
      }
    });
    sessionListEl.appendChild(div);
  });
}

async function updateConversation(id, update) {
  try {
    const response = await fetch(`/api/chat/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to update conversation.');
    await loadSessions();
  } catch (error) {
    window.alert(error.message || 'Unable to update conversation.');
  }
}

async function deleteConversation(id) {
  try {
    const response = await fetch(`/api/chat/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to delete conversation.');
    if (conversationId === id) {
      conversationId = null;
      localStorage.removeItem(conversationStorageKey);
      showWelcomeScreen();
    }
    await loadSessions();
  } catch (error) {
    window.alert(error.message || 'Unable to delete conversation.');
  }
}

newSessionBtn.onclick = () => {
  conversationId = null;
  localStorage.removeItem(conversationStorageKey);
  showWelcomeScreen();
  renderSessionList(window._sessions || [], null);
};

// ---------- Info Panel (Summary & Charts) ----------
function updateInfoPanel(summaryData, chartsData) {
  // Clear old charts since the panel is removed but chart logic remains for now
  Object.values(chartInstances).forEach(c => c.destroy());
  chartInstances = {};
}

function renderCharts(chartsData, clearFirst) {
  // Chart rendering removed as right panel is removed
  
  chartsData.forEach(chart => {
    if (chartInstances[chart.id]) return; // already rendered
    
    const card = document.createElement('div');
    card.className = 'chart-card';
    
    const title = document.createElement('h4');
    title.textContent = chart.title || 'Data Chart';
    card.appendChild(title);
    
    const canvasContainer = document.createElement('div');
    canvasContainer.style = 'position: relative; width: 100%; height: 200px;';
    
    const canvas = document.createElement('canvas');
    canvas.id = 'chart_' + chart.id;
    canvasContainer.appendChild(canvas);
    card.appendChild(canvasContainer);
    // infoChartsEl.appendChild(card);
    
    // Parse config if it's string (some DBs return JSON as string)
    let chartConfig = typeof chart.config === 'string' ? JSON.parse(chart.config) : (chart.config || {});
    let chartData = typeof chart.data === 'string' ? JSON.parse(chart.data) : (chart.data || {});
    
    // Reformat data for Chart.js if necessary
    const ctx = canvas.getContext('2d');
    chartInstances[chart.id] = new Chart(ctx, {
      type: chart.chartType || 'bar',
      data: chartData,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } }
        },
        ...chartConfig
      }
    });
  });
}

// ---------- Initialize ----------
restoreConversation();
loadSessions();
