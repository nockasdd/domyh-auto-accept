/**
 * Send-Prompt Payload — Injected via CDP to type text into chat input
 *
 * Uses document.execCommand('insertText') for React compatibility.
 */
  'use strict';

  var text = typeof __text !== 'undefined' ? __text : '';
  var selectorHint = typeof __selector !== 'undefined' ? __selector : '';

  if (!text) {
    return JSON.stringify({ success: false, error: 'No text provided' });
  }

  // Find the chat input field
  function findChatInput() {
    // Try specific selector first
    if (selectorHint) {
      var specific = document.querySelector(selectorHint);
      if (specific) return specific;
    }

    // Find contenteditable divs (common in VS Code-based IDEs)
    var editables = document.querySelectorAll('[contenteditable="true"]');
    var candidates = [];

    for (var i = 0; i < editables.length; i++) {
      var el = editables[i];
      // Skip IME overlays and narrow elements
      if (el.className && el.className.includes('ime')) continue;
      if (el.offsetWidth < 100) continue;
      if (el.offsetHeight < 20) continue;

      var score = 0;
      var cls = el.className || '';

      // Prefer elements with chat-related class names
      if (cls.includes('cursor-text') || cls.includes('overflow')) score += 10;
      if (cls.includes('editor') || cls.includes('input')) score += 5;
      if (cls.includes('chat') || cls.includes('prompt')) score += 15;

      // Prefer visible elements
      if (el.offsetParent) score += 5;

      candidates.push({ el: el, score: score });
    }

    // Also try textarea/input elements
    var inputs = document.querySelectorAll('textarea[class*="chat"], textarea[class*="input"], input[class*="chat"]');
    for (var j = 0; j < inputs.length; j++) {
      candidates.push({ el: inputs[j], score: 20 });
    }

    if (candidates.length === 0) {
      return null;
    }

    // Sort by score descending
    candidates.sort(function(a, b) { return b.score - a.score; });
    return candidates[0].el;
  }

  var input = findChatInput();
  if (!input) {
    return JSON.stringify({ success: false, error: 'Chat input not found' });
  }

  try {
    // Focus the input
    input.focus();

    // Clear existing content
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      input.value = '';
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // Contenteditable — use execCommand for React compatibility
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Wait for React state cycle, then press Enter
    setTimeout(function() {
      var enterEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(enterEvent);
    }, 300);

    return JSON.stringify({ success: true });
  } catch (e) {
    return JSON.stringify({ success: false, error: e.message || String(e) });
  }
