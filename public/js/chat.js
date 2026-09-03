// ---------- Helpers ----------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function cleanAnswer(text) {
  if (!text) return '';
  // Strip any remaining raw markdown that the LLM might still output
  let html = text;
  // Convert markdown bold **text** to <strong>text</strong>
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Convert markdown italic *text* to <em>text</em>
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  // Convert markdown headers
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
  
  // Convert bullet lists (-, *, •)
  html = html.replace(/^[-*•]\s+(.+)$/gm, '<li>$1</li>');
  // Convert numbered lists
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li class="num">$1</li>');
  
  // Wrap consecutive <li> in <ul> or <ol>
  html = html.replace(/((?:<li class="num">.*?<\/li>\n?)+)/g, '<ol>$1</ol>');
  html = html.replace(/((?:<li>.*?<\/li>\n?)+)/g, '<ul>$1</ul>');
  // Remove the class="num" helper
  html = html.replace(/<li class="num">/g, '<li>');

  // Convert double newlines to paragraph breaks (ignore if inside list)
  html = html.replace(/\n\n+/g, '</p><p>');
  
  // Convert single newlines to <br> but ONLY if they are not around list/header tags
  html = html.replace(/(?<!<\/h\d>|<\/ul>|<\/ol>|<\/li>)\n(?!<h\d>|<ul|<ol|<li)/g, '<br>');
  
  // Clean up stray newlines around block elements
  html = html.replace(/\n/g, '');

  // Wrap in paragraph if not already wrapped in block elements
  if (!html.startsWith('<h') && !html.startsWith('<p') && !html.startsWith('<ul') && !html.startsWith('<ol')) {
    html = '<p>' + html + '</p>';
  }
  return html;
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

// ---------- Elements ----------
const askBtn = document.getElementById('askBtn');
const queryInput = document.getElementById('queryInput');
const askStatus = document.getElementById('askStatus');
const chatHistory = document.getElementById('chatHistory');

function appendUserMessage(text) {
  const msg = document.createElement('div');
  msg.className = 'message user';
  msg.innerHTML = `<div class="bubble-content">${escapeHtml(text)}</div>`;
  chatHistory.appendChild(msg);
  scrollToBottom();
}

async function restoreConversation() {
  const storedConversationId = localStorage.getItem(conversationStorageKey);
  if (!storedConversationId) return;

  try {
    const response = await fetch(`/api/chat/history/${encodeURIComponent(storedConversationId)}`);
    if (!response.ok) {
      localStorage.removeItem(conversationStorageKey);
      return;
    }
    const data = await response.json();
    conversationId = data.conversationId;
    const welcome = document.getElementById('welcomeMessage');
    if (welcome && data.history.length) welcome.remove();
    for (const message of data.history) {
      if (message.role === 'user') appendUserMessage(message.content);
      else appendAssistantMessage(message);
    }
  } catch (error) {
    // A transient restore failure must not prevent a new chat request.
    console.warn('Unable to restore conversation:', error);
  }
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
      return source.downloadUrl
        ? `<a class="source-tag" href="${escapeHtml(source.downloadUrl)}" download>${label}</a>`
        : `<span class="source-tag">${label}</span>`;
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
      body: JSON.stringify({ query: q, conversationId })
    });

    removeThinkingIndicator();

    if (res.status === 401) {
      window.location.href = '/login.html';
      return;
    }

    const data = await res.json();
    if (data.error) throw new Error(data.error);

    // Save conversationId for followups
    if (data.conversationId) {
       conversationId = data.conversationId;
       localStorage.setItem(conversationStorageKey, conversationId);
    }

    appendAssistantMessage(data);

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

restoreConversation();
