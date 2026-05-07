/**
 * AFFiNE RAG Chatbot Widget
 * Streaming chat UI via SSE - Vanilla JS, zero dependencies
 */
(function () {
  'use strict';

  const API_BASE = '/chatbot/api';
  const SESSION_KEY = 'cb_session_id';
  const SUGGESTIONS = [
    'AFFiNE la gi?',
    'Cach tao whiteboard?',
    'Database view hoat dong the nao?',
    'Phim tat thuong dung?',
  ];

  let sessionId = sessionStorage.getItem(SESSION_KEY) || generateId();
  let isOpen = false;
  let isStreaming = false;
  let unreadCount = 0;
  sessionStorage.setItem(SESSION_KEY, sessionId);

  function buildWidget() {
    const root = document.createElement('div');
    root.id = 'cb-root';
    root.innerHTML = [
      '<button id="cb-toggle" aria-label="Mo tro ly AI">',
      '<svg id="cb-icon-chat" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white" width="26" height="26">',
      '<path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/>',
      '</svg>',
      '<svg id="cb-icon-close" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white" width="26" height="26" style="display:none">',
      '<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>',
      '</svg>',
      '<span id="cb-badge"></span>',
      '</button>',
      '<div id="cb-panel" class="hidden">',
      '  <div id="cb-header">',
      '    <div id="cb-avatar">&#x1F916;</div>',
      '    <div id="cb-header-info">',
      '      <div id="cb-header-name">AFFiNE AI Assistant</div>',
      '      <div id="cb-header-status">Truc tuyen</div>',
      '    </div>',
      '    <button id="cb-clear-btn" title="Xoa lich su">&#8635; Xoa</button>',
      '  </div>',
      '  <div id="cb-messages" role="log" aria-live="polite">',
      '    <div class="cb-welcome">',
      '      <span class="cb-welcome-icon">&#x2728;</span>',
      '      <strong>Chao ban! Minh la tro ly AI cua AFFiNE.</strong>',
      '      Hoi minh bat cu dieu gi ve AFFiNE nhe!',
      '    </div>',
      '    <div id="cb-suggestions"></div>',
      '  </div>',
      '  <div id="cb-typing">',
      '    <div class="cb-msg-avatar">&#x1F916;</div>',
      '    <div class="cb-typing-dots">',
      '      <div class="cb-dot"></div><div class="cb-dot"></div><div class="cb-dot"></div>',
      '    </div>',
      '  </div>',
      '  <div id="cb-input-area">',
      '    <div id="cb-input-row">',
      '      <textarea id="cb-input" placeholder="Hoi ve AFFiNE..." rows="1" maxlength="2000" aria-label="Nhap cau hoi"></textarea>',
      '      <button id="cb-send" aria-label="Gui">',
      '        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>',
      '      </button>',
      '    </div>',
      '    <div id="cb-hint">Enter de gui · Shift+Enter xuong dong</div>',
      '  </div>',
      '</div>',
    ].join('\n');
    document.body.appendChild(root);
  }

  function init() {
    buildWidget();
    bindEvents();
    renderSuggestions();
    autoResizeTextarea();
  }

  function bindEvents() {
    document.getElementById('cb-toggle').addEventListener('click', function() { togglePanel(); });
    document.getElementById('cb-send').addEventListener('click', function() { sendMessage(); });
    document.getElementById('cb-input').addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    document.getElementById('cb-clear-btn').addEventListener('click', function() { clearHistory(); });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && isOpen) { togglePanel(false); }
    });
  }

  function renderSuggestions() {
    const container = document.getElementById('cb-suggestions');
    if (!container) return;
    SUGGESTIONS.forEach(function(q) {
      const btn = document.createElement('button');
      btn.className = 'cb-suggestion';
      btn.textContent = q;
      btn.addEventListener('click', function() {
        document.getElementById('cb-input').value = q;
        hideSuggestions();
        sendMessage();
      });
      container.appendChild(btn);
    });
  }

  function hideSuggestions() {
    const s = document.getElementById('cb-suggestions');
    if (s) s.remove();
  }

  function togglePanel(forceState) {
    isOpen = forceState !== undefined ? forceState : !isOpen;
    const panel = document.getElementById('cb-panel');
    const toggle = document.getElementById('cb-toggle');
    const iconChat = document.getElementById('cb-icon-chat');
    const iconClose = document.getElementById('cb-icon-close');

    if (isOpen) {
      panel.classList.remove('hidden');
      panel.classList.add('visible');
      toggle.classList.add('open');
      iconChat.style.display = 'none';
      iconClose.style.display = 'block';
      document.getElementById('cb-input').focus();
      resetBadge();
    } else {
      panel.classList.remove('visible');
      panel.classList.add('hidden');
      toggle.classList.remove('open');
      iconChat.style.display = 'block';
      iconClose.style.display = 'none';
    }
  }

  function resetBadge() {
    unreadCount = 0;
    const badge = document.getElementById('cb-badge');
    badge.classList.remove('show');
    badge.textContent = '';
  }

  function incrementBadge() {
    if (isOpen) return;
    unreadCount++;
    const badge = document.getElementById('cb-badge');
    badge.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
    badge.classList.add('show');
  }

  function sendMessage() {
    if (isStreaming) return;
    const input = document.getElementById('cb-input');
    const message = input.value.trim();
    if (!message) return;

    hideSuggestions();
    input.value = '';
    input.style.height = 'auto';

    appendMessage('user', message);
    showTyping(true);
    setInputDisabled(true);
    isStreaming = true;

    const botMsgEl = createBotMessageEl();
    const bubbleEl = botMsgEl.querySelector('.cb-msg-bubble');
    document.getElementById('cb-messages').appendChild(botMsgEl);
    scrollToBottom();

    fetch(API_BASE + '/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message, sessionId: sessionId }),
    }).then(function(response) {
      if (!response.ok) {
        return response.json().catch(function() { return { error: 'Loi ket noi' }; }).then(function(err) {
          bubbleEl.textContent = 'Loi: ' + (err.error || 'Loi khong xac dinh');
          showTyping(false);
          setInputDisabled(false);
          isStreaming = false;
        });
      }
      showTyping(false);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let buffer = '';

      function read() {
        return reader.read().then(function(result) {
          if (result.done) {
            const timeEl = document.createElement('div');
            timeEl.className = 'cb-msg-time';
            timeEl.textContent = formatTime(new Date());
            botMsgEl.querySelector('.cb-msg-content').appendChild(timeEl);
            if (!isOpen) incrementBadge();
            setInputDisabled(false);
            isStreaming = false;
            scrollToBottom();
            document.getElementById('cb-input').focus();
            return;
          }
          buffer += decoder.decode(result.value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          lines.forEach(function(line) {
            if (line.indexOf('data: ') === 0) {
              const data = line.slice(6).trim();
              if (data === '[DONE]') return;
              try {
                const parsed = JSON.parse(data);
                const choices = parsed.choices;
                if (choices && choices[0] && choices[0].delta && choices[0].delta.content) {
                  fullText += choices[0].delta.content;
                  bubbleEl.innerHTML = renderMarkdown(fullText);
                  scrollToBottom();
                }
              } catch (e) { /* partial chunk */ }
            }
          });
          return read();
        });
      }
      return read();
    }).catch(function(error) {
      showTyping(false);
      bubbleEl.textContent = 'Khong the ket noi den chatbot. Vui long thu lai.';
      console.error('[ChatWidget]', error);
      setInputDisabled(false);
      isStreaming = false;
      scrollToBottom();
    });
  }

  function appendMessage(role, text) {
    const container = document.getElementById('cb-messages');
    const msgEl = document.createElement('div');
    msgEl.className = 'cb-msg ' + role;

    const avatarEl = document.createElement('div');
    avatarEl.className = 'cb-msg-avatar';
    avatarEl.textContent = role === 'user' ? String.fromCodePoint(0x1F464) : String.fromCodePoint(0x1F916);

    const contentEl = document.createElement('div');
    contentEl.className = 'cb-msg-content';

    const bubbleEl = document.createElement('div');
    bubbleEl.className = 'cb-msg-bubble';
    bubbleEl.innerHTML = role === 'user' ? escapeHtml(text) : renderMarkdown(text);

    const timeEl = document.createElement('div');
    timeEl.className = 'cb-msg-time';
    timeEl.textContent = formatTime(new Date());

    contentEl.appendChild(bubbleEl);
    contentEl.appendChild(timeEl);
    msgEl.appendChild(avatarEl);
    msgEl.appendChild(contentEl);
    container.appendChild(msgEl);
    scrollToBottom();
  }

  function createBotMessageEl() {
    const msgEl = document.createElement('div');
    msgEl.className = 'cb-msg bot';

    const avatarEl = document.createElement('div');
    avatarEl.className = 'cb-msg-avatar';
    avatarEl.textContent = String.fromCodePoint(0x1F916);

    const contentEl = document.createElement('div');
    contentEl.className = 'cb-msg-content';

    const bubbleEl = document.createElement('div');
    bubbleEl.className = 'cb-msg-bubble';
    bubbleEl.textContent = String.fromCodePoint(0x258C);

    contentEl.appendChild(bubbleEl);
    msgEl.appendChild(avatarEl);
    msgEl.appendChild(contentEl);
    return msgEl;
  }

  function showTyping(show) {
    const el = document.getElementById('cb-typing');
    if (show) {
      el.classList.add('show');
      document.getElementById('cb-messages').appendChild(el);
      scrollToBottom();
    } else {
      el.classList.remove('show');
    }
  }

  function setInputDisabled(disabled) {
    document.getElementById('cb-input').disabled = disabled;
    document.getElementById('cb-send').disabled = disabled;
  }

  function scrollToBottom() {
    const el = document.getElementById('cb-messages');
    el.scrollTop = el.scrollHeight;
  }

  function clearHistory() {
    if (!confirm('Xoa toan bo lich su chat?')) return;
    fetch(API_BASE + '/history/' + sessionId, { method: 'DELETE' }).catch(function() {});
    sessionId = generateId();
    sessionStorage.setItem(SESSION_KEY, sessionId);
    const container = document.getElementById('cb-messages');
    container.innerHTML = [
      '<div class="cb-welcome">',
      '<span class="cb-welcome-icon">&#x2728;</span>',
      '<strong>Lich su da duoc xoa.</strong>',
      'Hoi minh bat cu dieu gi ve AFFiNE nhe!',
      '</div>',
      '<div id="cb-suggestions"></div>',
    ].join('');
    renderSuggestions();
  }

  function autoResizeTextarea() {
    const input = document.getElementById('cb-input');
    input.addEventListener('input', function() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });
  }

  function generateId() {
    return 'cb_' + Math.random().toString(36).slice(2, 11) + '_' + Date.now();
  }

  function formatTime(date) {
    return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  }

  function escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text).replace(/[&<>"']/g, function(m) { return map[m]; });
  }

  function renderMarkdown(text) {
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
