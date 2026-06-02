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

  // ─── TTS State ─────────────────────────────────────────────────────────────
  let ttsAudio = null;        // current Audio object
  let ttsPlaying = false;
  let ttsSpeakingEl = null;   // bot bubble element being spoken
  const TTS_VOICES = [
    { label: '🇻🇳 Nữ (Neural2)', value: 'vi-VN-Neural2-A', lang: 'vi-VN' },
    { label: '🇻🇳 Nam (Neural2)', value: 'vi-VN-Neural2-D', lang: 'vi-VN' },
    { label: '🇺🇸 Female (Journey)', value: 'en-US-Journey-F', lang: 'en-US' },
    { label: '🇺🇸 Male (Journey)', value: 'en-US-Journey-D', lang: 'en-US' },
  ];
  let ttsVoice = TTS_VOICES[0];
  let ttsRate = 1.0;


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
      /* TTS mini-player (hidden by default) */
      '  <div id="cb-tts-player" style="display:none">',
      '    <div id="cb-tts-controls">',
      '      <button id="cb-tts-play" title="Play / Pause" aria-label="Play Pause TTS">&#9654;</button>',
      '      <div id="cb-tts-info">',
      '        <span id="cb-tts-label">Dang doc...</span>',
      '        <div id="cb-tts-progress-bar"><div id="cb-tts-progress"></div></div>',
      '      </div>',
      '      <select id="cb-tts-rate" title="Toc do doc" aria-label="Toc do">',
      '        <option value="0.75">0.75x</option>',
      '        <option value="1.0" selected>1x</option>',
      '        <option value="1.25">1.25x</option>',
      '        <option value="1.5">1.5x</option>',
      '        <option value="2.0">2x</option>',
      '      </select>',
      '      <select id="cb-tts-voice" title="Giong doc" aria-label="Giong doc">',
      '      </select>',
      '      <button id="cb-tts-stop" title="Dung doc" aria-label="Stop TTS">&#9632;</button>',
      '    </div>',
      '  </div>',
      '</div>',
    ].join('\n');
    document.body.appendChild(root);
    // Populate voice selector
    var voiceSel = document.getElementById('cb-tts-voice');
    TTS_VOICES.forEach(function(v, i) {
      var opt = document.createElement('option');
      opt.value = i;
      opt.textContent = v.label;
      voiceSel.appendChild(opt);
    });
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
    // TTS controls
    document.getElementById('cb-tts-play').addEventListener('click', ttsTogglePlay);
    document.getElementById('cb-tts-stop').addEventListener('click', ttsStop);
    document.getElementById('cb-tts-rate').addEventListener('change', function() {
      ttsRate = parseFloat(this.value);
      if (ttsAudio) ttsAudio.playbackRate = ttsRate;
    });
    document.getElementById('cb-tts-voice').addEventListener('change', function() {
      ttsVoice = TTS_VOICES[parseInt(this.value, 10)] || TTS_VOICES[0];
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
                const content = parsed.content !== undefined ? parsed.content : (parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content);
                if (content) {
                  fullText += content;
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

  // ─── TTS Functions ─────────────────────────────────────────────────────────

  /** Speak a bot message bubble (extract plain text from HTML) */
  function ttsSpeak(bubbleEl) {
    var text = (bubbleEl.innerText || bubbleEl.textContent || '').trim();
    if (!text) return;

    ttsStop();
    ttsSpeakingEl = bubbleEl;

    // Show loading state
    var player = document.getElementById('cb-tts-player');
    var label = document.getElementById('cb-tts-label');
    var playBtn = document.getElementById('cb-tts-play');
    player.style.display = 'block';
    label.textContent = 'Dang tai giong noi...';
    playBtn.textContent = '⏳';

    var body = JSON.stringify({
      text: text,
      voice: ttsVoice.value,
      languageCode: ttsVoice.lang,
      speakingRate: ttsRate,
    });

    fetch(API_BASE + '/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
    }).then(function(resp) {
      if (!resp.ok) return resp.json().then(function(e) { throw new Error(e.error || 'TTS error'); });
      return resp.blob();
    }).then(function(blob) {
      var url = URL.createObjectURL(blob);
      ttsAudio = new Audio(url);
      ttsAudio.playbackRate = ttsRate;
      ttsPlaying = true;

      label.textContent = ttsVoice.label;
      playBtn.textContent = '⏸';

      // Progress bar
      ttsAudio.addEventListener('timeupdate', function() {
        if (ttsAudio.duration) {
          var pct = (ttsAudio.currentTime / ttsAudio.duration) * 100;
          document.getElementById('cb-tts-progress').style.width = pct + '%';
        }
      });
      ttsAudio.addEventListener('ended', function() {
        ttsPlaying = false;
        playBtn.textContent = '▶';
        document.getElementById('cb-tts-progress').style.width = '100%';
        URL.revokeObjectURL(url);
      });
      ttsAudio.play();
    }).catch(function(err) {
      label.textContent = '⚠ ' + (err.message || 'Loi TTS');
      playBtn.textContent = '▶';
      console.error('[TTS]', err);
    });
  }

  function ttsTogglePlay() {
    if (!ttsAudio) return;
    var playBtn = document.getElementById('cb-tts-play');
    if (ttsPlaying) {
      ttsAudio.pause();
      ttsPlaying = false;
      playBtn.textContent = '▶';
    } else {
      ttsAudio.play();
      ttsPlaying = true;
      playBtn.textContent = '⏸';
    }
  }

  function ttsStop() {
    if (ttsAudio) {
      ttsAudio.pause();
      ttsAudio.src = '';
      ttsAudio = null;
    }
    ttsPlaying = false;
    ttsSpeakingEl = null;
    var player = document.getElementById('cb-tts-player');
    if (player) player.style.display = 'none';
    var progress = document.getElementById('cb-tts-progress');
    if (progress) progress.style.width = '0%';
    var playBtn = document.getElementById('cb-tts-play');
    if (playBtn) playBtn.textContent = '▶';
  }

  // ─── Message Helpers ────────────────────────────────────────────────────────

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
    var msgEl = document.createElement('div');
    msgEl.className = 'cb-msg bot';

    var avatarEl = document.createElement('div');
    avatarEl.className = 'cb-msg-avatar';
    avatarEl.textContent = String.fromCodePoint(0x1F916);

    var contentEl = document.createElement('div');
    contentEl.className = 'cb-msg-content';

    var bubbleEl = document.createElement('div');
    bubbleEl.className = 'cb-msg-bubble';
    bubbleEl.textContent = String.fromCodePoint(0x258C);

    // TTS speak button
    var ttsBtn = document.createElement('button');
    ttsBtn.className = 'cb-tts-btn';
    ttsBtn.title = 'Doc tin nhan nay';
    ttsBtn.innerHTML = '&#128266;';
    ttsBtn.addEventListener('click', function() { ttsSpeak(bubbleEl); });

    contentEl.appendChild(bubbleEl);
    contentEl.appendChild(ttsBtn);
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
