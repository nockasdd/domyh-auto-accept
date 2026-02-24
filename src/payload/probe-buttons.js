/**
 * Probe Buttons Payload — Diagnostic (NO CLICKING)
 *
 * Finds and reports all potential Accept/Keep All buttons.
 * Uses same detection logic as auto-accept.js for consistency.
 * Returns detailed report for debugging — does NOT click anything.
 */
'use strict';

var BUTTON_SELECTORS = [
  'button', '[role="button"]', '.monaco-button', '.bg-ide-button-background',
  'span[class*="bg-ide-button"]', 'span.cursor-pointer',
  '.anysphere-text-button', '.anysphere-secondary-button',
  '.anysphere-focus-outline-button', '.anysphere-button',
  '[data-click-ready="true"]',
].join(', ');

var EDITOR_DIFF_SELECTORS = [
  '.composer-pane-controls-feedback', '.composer-tool-call-control-row',
  '.composer-single-file-block', '#composer-files-edited-header',
  '.composer-files-edited-header', '.editor-group-container',
  '.file-modifications-toolbar', '.modifications-toolbar',
  '.review-flow-wrapper', '.diff-actions-bar', '.diff-actions',
];

var ACCEPT_WORDS = ['accept', 'accept all', 'accept all files', 'approve', 'apply', 'apply all',
  'confirm', 'allow', 'allow once', 'save all', 'overwrite', 'proceed', 'keep', 'keep all',
  'yes', 'ok', 'run', 'retry', 'try again', 'continue'];

var REJECT_WORDS = ['skip', 'reject', 'cancel', 'close', 'dismiss', 'decline', 'deny', 'discard',
  'undo', 'revert', 'debug', 'start', 'stop', 'restart', 'terminal', 'delete', 'remove',
  'open', 'copy', 'edit', 'thought', 'review'];

function deepQuerySelectorAll(root, selector, maxDepth) {
  maxDepth = maxDepth || 5;
  var results = [];
  if (!root || maxDepth <= 0) return results;
  try {
    var found = root.querySelectorAll(selector);
    for (var i = 0; i < found.length; i++) results.push(found[i]);
  } catch (e) { /* ignore */ }
  try {
    var allElements = root.querySelectorAll('*');
    var limit = Math.min(allElements.length, 100);
    for (var i = 0; i < limit; i++) {
      var el = allElements[i];
      if (el.shadowRoot) {
        var shadowResults = deepQuerySelectorAll(el.shadowRoot, selector, maxDepth - 1);
        for (var j = 0; j < shadowResults.length; j++) results.push(shadowResults[j]);
      }
    }
  } catch (e) { /* ignore */ }
  return results;
}

function getButtonText(el) {
  var text = '';
  try {
    // Priority 1: aria-label
    text = el.getAttribute('aria-label') || '';
    // CRITICAL: Prefer DIRECT text nodes of the element (e.g. <button>Allow<span>Alt+⏎</span></button>)
    // This avoids mis-reading the shortcut span ("Alt+⏎") as the button label.
    if (!text) {
      try {
        var directTextParts = [];
        for (var dn = 0; dn < (el.childNodes ? el.childNodes.length : 0); dn++) {
          var node = el.childNodes[dn];
          if (node && node.nodeType === 3) { // TEXT_NODE
            var t = (node.textContent || '').trim();
            if (t) directTextParts.push(t);
          }
        }
        if (directTextParts.length > 0) {
          text = directTextParts.join(' ');
        }
      } catch (e) { /* ignore */ }
    }
    // Priority 2: first direct span child (for structured buttons)
    if (!text) {
      var directSpans = el.querySelectorAll(':scope > span');
      if (directSpans.length > 0) {
        // Get first span's text (usually the button label)
        var firstSpan = directSpans[0];
        var firstSpanText = (firstSpan.textContent || '').trim();
        if (firstSpanText) {
          text = firstSpanText;
        }
      }
    }
    // Priority 3: nested spans with truncate class or short text
    if (!text) {
      var nestedSpans = el.querySelectorAll('span');
      for (var i = 0; i < nestedSpans.length; i++) {
        var spanText = (nestedSpans[i].textContent || '').trim();
        if (spanText && (nestedSpans[i].classList.contains('truncate') || spanText.length < 30)) {
          text = spanText;
          break;
        }
      }
    }
    // Priority 4: textContent/innerText
    if (!text) {
      text = (el.textContent || el.innerText || '').substring(0, 60);
    }
    // Priority 5: title attribute
    if (!text) {
      text = el.getAttribute('title') || '';
    }
  } catch (e) { /* ignore */ }
  // Normalize text: remove special characters (⏎, ⇧, etc.) and keyboard shortcuts
  // These are often appended to button text (e.g., "run⏎", "Allowlist 'cd' + 1⇧⏎")
  text = text.trim()
    .replace(/[⏎⇧⌘⌥⌃⌫↵↩]/g, '') // Remove keyboard shortcut symbols
    .replace(/\s*\+\s*\d+\s*/g, '') // Remove "+ 1", "+ 3" patterns
    .replace(/\s+/g, ' ') // Normalize whitespace
    .toLowerCase();
  return text;
}

function isAcceptButton(text) {
  if (!text) return false;
  // Max 60 chars — real buttons are short. Long text = code or message content.
  if (text.length > 60) return false;

  // Check reject words first (case-insensitive)
  var lowerText = text.toLowerCase();
  
  // Special case: Reject buttons with "allowlist" anywhere in text (e.g., "Allowlist 'cd' + 1", "Use Allowlist")
  // These are dropdown/secondary buttons, not the primary "Run" button
  if (lowerText.indexOf('allowlist') !== -1) return false;
  
  for (var i = 0; i < REJECT_WORDS.length; i++) {
    var rejectWord = REJECT_WORDS[i].toLowerCase();
    // Exact match or starts with reject word
    if (lowerText === rejectWord || lowerText.indexOf(rejectWord) === 0) return false;
    // Contains reject word (for phrases like "ask every time", "use allowlist", "run everything")
    if (lowerText.indexOf(rejectWord) !== -1) {
      // For single words, check word boundaries
      if (rejectWord.indexOf(' ') === -1) {
        // Single word: check word boundaries using regex
        var regex = new RegExp('\\b' + rejectWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
        if (regex.test(lowerText)) return false;
      } else {
        // Multi-word phrase: check if phrase exists
        if (lowerText.indexOf(rejectWord) !== -1) return false;
      }
    }
  }

  // Check accept words — STRICT matching
  // IMPORTANT: For "run" button, only accept if text is exactly "run" (not "allowlist 'cd' + 1" or similar)
  for (var i = 0; i < ACCEPT_WORDS.length; i++) {
    var word = ACCEPT_WORDS[i];
    // Exact match (case-insensitive)
    if (lowerText === word.toLowerCase()) return true;
    // Text starts with word and next char is space or end
    if (lowerText.indexOf(word.toLowerCase()) === 0 && (lowerText.length === word.length || lowerText[word.length] === ' ')) return true;
    // For multi-word patterns like "keep all", check if text contains the full phrase
    if (word.indexOf(' ') !== -1 && lowerText.indexOf(word.toLowerCase()) !== -1) {
      // Ensure it's not part of a longer word (word boundaries)
      var idx = lowerText.indexOf(word.toLowerCase());
      var before = idx === 0 ? ' ' : lowerText[idx - 1];
      var after = idx + word.length >= lowerText.length ? ' ' : lowerText[idx + word.length];
      if ((before === ' ' || before === '') && (after === ' ' || after === '')) {
        return true;
      }
    }
  }

  return false;
}

function isInsideCodeOrProse(el) {
  var cls = (el.className || '').toString();
  if (cls.indexOf('composer-run-button') !== -1 || cls.indexOf('composer-skip-button') !== -1 ||
      cls.indexOf('composer-tool-call-control') !== -1) return false;
  var parent = el;
  for (var d = 0; d < 15 && parent; d++) {
    var parentCls = (parent.className || '').toString();
    if (parentCls.indexOf('composer-tool-call-control') !== -1 ||
        parentCls.indexOf('composer-tool-call-control-row') !== -1) return false;
    if (parent.tagName === 'PRE' || parent.tagName === 'CODE') return true;
    if (parentCls.indexOf('prose') !== -1 && parentCls.indexOf('composer-tool-call') === -1) return true;
    if (parentCls.indexOf('code-block') !== -1 || parentCls.indexOf('codeblock') !== -1) return true;
    parent = parent.parentElement;
  }
  return false;
}

function isInsideForbiddenZone(el) {
  // CRITICAL: Check element's own classes FIRST (fast path for Run buttons)
  // This ensures Run buttons with class "composer-run-button" are allowed immediately
  var elCls = (el.className || '').toString();
  
  // Check for composer-run-button, composer-skip-button, composer-tool-call-control
  if (elCls.indexOf('composer-run-button') !== -1 ||
      elCls.indexOf('composer-skip-button') !== -1 ||
      elCls.indexOf('composer-tool-call-control') !== -1) {
    // But check if it's a dropdown button first (these should be skipped)
    if (elCls.indexOf('composer-tool-call-allowlist-button') !== -1 ||
        elCls.indexOf('composer-tool-call-menu-button') !== -1) {
      return true; // Dropdown buttons should be skipped
    }
    return false; // Allow Run/Skip buttons immediately
  }
  
  var parent = el;
  var depth = 0;
  // ALLOW: Composer area (Keep All, Accept, Run buttons, etc.) — even if inside auxiliarybar
  // CRITICAL: Check for composer areas FIRST, before checking forbidden zones
  // This ensures Run buttons in composer-tool-call-control-row are allowed
  while (parent && depth < 100) {
    var id = parent.id || '';
    var cls = (parent.className || '').toString();
    // Allow composer headers and pane controls
    if (id === 'composer-files-edited-header' || cls.indexOf('composer-files-edited-header') !== -1 ||
        cls.indexOf('composer-pane-controls-feedback') !== -1) {
      return false; // Allow composer areas
    }
    // Allow composer-tool-call containers
    // This includes composer-tool-call-control-row where Run buttons live
    if (cls.indexOf('composer-tool-call') !== -1 ||
        cls.indexOf('composer-tool-call-control-row') !== -1 ||
        cls.indexOf('composer-tool-call-status-row') !== -1) {
      return false; // Allow composer tool calls
    }
    parent = parent.parentElement || (parent.getRootNode && parent.getRootNode().host) || null;
    depth++;
  }
  
  parent = el;
  depth = 0;
  // Check direct IDs first (fast path)
  var directId = el.id || '';
  if (directId === 'workbench.parts.statusbar' || directId === 'workbench.parts.sidebar' ||
      directId === 'workbench.parts.activitybar' || directId === 'workbench.parts.titlebar' ||
      directId === 'workbench.parts.panel' || directId === 'workbench.parts.auxiliarybar') {
    return true;
  }
  
  // Check forbidden zones
  while (parent && depth < 100) {
    var id = parent.id || '';
    if (id === 'workbench.parts.statusbar' || id === 'workbench.parts.sidebar' ||
        id === 'workbench.parts.activitybar' || id === 'workbench.parts.titlebar' ||
        id === 'workbench.parts.panel' || id === 'workbench.parts.auxiliarybar') return true;
    parent = parent.parentElement || (parent.getRootNode && parent.getRootNode().host) || null;
    depth++;
  }
  return false;
}

function isElementClickable(el) {
  try {
    if (el.offsetParent === null && el.style && el.style.position !== 'fixed') return false;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    if (style.pointerEvents === 'none') return false;
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
    if (rect.right < 0 || rect.left > window.innerWidth) return false;
    return true;
  } catch (e) { return false; }
}

function findContainers() {
  var containers = [];
  for (var s = 0; s < EDITOR_DIFF_SELECTORS.length; s++) {
    var found = deepQuerySelectorAll(document, EDITOR_DIFF_SELECTORS[s]);
    for (var f = 0; f < found.length; f++) containers.push(found[f]);
  }
  return containers;
}

var report = {
  timestamp: Date.now(),
  url: typeof location !== 'undefined' ? location.href : '',
  containersFound: 0,
  buttonsScanned: 0,
  keepAllFound: false,
  keepAllDetails: null,
  candidates: [],
  composerHeaderExists: !!document.getElementById('composer-files-edited-header'),
  composerPaneExists: !!document.querySelector('.composer-pane-controls-feedback'),
};

var containers = findContainers();
report.containersFound = containers.length;

var checked = new Set();
for (var c = 0; c < containers.length; c++) {
  var btns = deepQuerySelectorAll(containers[c], BUTTON_SELECTORS);
  for (var i = 0; i < btns.length; i++) {
    var btn = btns[i];
    if (checked.has(btn)) continue;
    checked.add(btn);
    report.buttonsScanned++;

    var text = getButtonText(btn);
    var inCode = isInsideCodeOrProse(btn);
    var inForbidden = isInsideForbiddenZone(btn);
    var accept = isAcceptButton(text);
    var clickable = isElementClickable(btn);
    var wouldClick = accept && !inCode && !inForbidden && clickable;

    var entry = {
      text: text,
      tag: btn.tagName,
      classes: (btn.className || '').toString().substring(0, 80),
      inCodeOrProse: inCode,
      inForbiddenZone: inForbidden,
      isAcceptButton: accept,
      isClickable: clickable,
      wouldClick: wouldClick,
    };

    if (text.indexOf('keep') !== -1 || text === 'keep all') {
      report.keepAllFound = wouldClick;
      report.keepAllDetails = entry;
    }
    if (text && text.length < 40) report.candidates.push(entry);
  }
}

var composerHeaders = document.querySelectorAll('#composer-files-edited-header, .composer-files-edited-header');
for (var ch = 0; ch < composerHeaders.length; ch++) {
  var headerBtns = deepQuerySelectorAll(composerHeaders[ch], BUTTON_SELECTORS);
  for (var hb = 0; hb < headerBtns.length; hb++) {
    var hBtn = headerBtns[hb];
    if (checked.has(hBtn)) continue;
    checked.add(hBtn);
    report.buttonsScanned++;

    var hText = getButtonText(hBtn);
    var hInCode = isInsideCodeOrProse(hBtn);
    var hInForbidden = isInsideForbiddenZone(hBtn);
    var hAccept = isAcceptButton(hText);
    var hClickable = isElementClickable(hBtn);
    var hWouldClick = hAccept && !hInCode && !hInForbidden && hClickable;

    var hEntry = {
      text: hText,
      tag: hBtn.tagName,
      classes: (hBtn.className || '').toString().substring(0, 80),
      inCodeOrProse: hInCode,
      inForbiddenZone: hInForbidden,
      isAcceptButton: hAccept,
      isClickable: hClickable,
      wouldClick: hWouldClick,
      source: 'composer-header',
    };

    if (hText.indexOf('keep') !== -1 || hText === 'keep all') {
      report.keepAllFound = hWouldClick;
      report.keepAllDetails = hEntry;
    }
    if (hText && hText.length < 40) report.candidates.push(hEntry);
  }
}

// Fallback: Scan entire document for Keep All buttons (if not found in containers)
if (!report.keepAllDetails) {
  report.scanMode = 'full-document-fallback';
  var allButtons = deepQuerySelectorAll(document, BUTTON_SELECTORS);
  for (var ab = 0; ab < allButtons.length; ab++) {
    var aBtn = allButtons[ab];
    if (checked.has(aBtn)) continue;
    var aText = getButtonText(aBtn);
    if (aText.indexOf('keep') !== -1 || aText === 'keep all') {
      var aInCode = isInsideCodeOrProse(aBtn);
      var aInForbidden = isInsideForbiddenZone(aBtn);
      var aAccept = isAcceptButton(aText);
      var aClickable = isElementClickable(aBtn);
      var aWouldClick = aAccept && !aInCode && !aInForbidden && aClickable;
      
      report.keepAllFound = aWouldClick;
      report.keepAllDetails = {
        text: aText,
        tag: aBtn.tagName,
        classes: (aBtn.className || '').toString().substring(0, 80),
        id: aBtn.id || '',
        parentId: aBtn.parentElement ? (aBtn.parentElement.id || '') : '',
        parentClasses: aBtn.parentElement ? ((aBtn.parentElement.className || '').toString().substring(0, 80)) : '',
        inCodeOrProse: aInCode,
        inForbiddenZone: aInForbidden,
        isAcceptButton: aAccept,
        isClickable: aClickable,
        wouldClick: aWouldClick,
        source: 'full-document-scan',
      };
      break;
    }
  }
}

// Additional diagnostics
report.diagnostics = {
  windowTop: window === window.top,
  documentReady: document.readyState,
  bodyExists: !!document.body,
  totalElements: document.querySelectorAll('*').length,
  iframeCount: document.querySelectorAll('iframe').length,
  webviewCount: document.querySelectorAll('webview').length,
  composerHeaderById: !!document.getElementById('composer-files-edited-header'),
  composerHeaderByQuery: document.querySelectorAll('#composer-files-edited-header').length,
  composerPaneByQuery: document.querySelectorAll('.composer-pane-controls-feedback').length,
  anysphereButtons: document.querySelectorAll('.anysphere-text-button, .anysphere-button').length,
  dataClickReadyButtons: document.querySelectorAll('[data-click-ready="true"]').length,
};

return JSON.stringify(report);
