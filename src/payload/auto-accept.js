/**
 * Auto-Accept Payload — CDP injected script
 *
 * Finds and clicks Accept/Apply buttons ONLY in:
 *   1. Chat/Agent panel action buttons (not code blocks or message text)
 *   2. Editor diff view (chatEditing toolbar, inline diff actions)
 *
 * DOES NOT scan: Walkthrough pages, settings, random tabs, extension UIs.
 * DOES NOT click: Code blocks, inline <code>, prose text that happens to contain "accept".
 *
 * Targeting logic:
 * - On MAIN workbench: scan only editor diff containers
 * - On CHAT PANEL iframe: scan only action bar areas, NOT code/prose content
 * - NEVER falls back to full-document scan
 */
'use strict';

// Config: payload uses hardcoded constants for reliability
// Dynamic config injection was removed (never consumed — see audit_2026-02-17)

// ── Constants ────────────────────────────────────

// EXACT words that indicate an accept button. Used with word-boundary matching.
var ACCEPT_WORDS = [
  'accept', 'accept all', 'accept all files',
  'approve', 'apply', 'apply all',
  'confirm', 'allow', 'allow once',
  'save all', 'overwrite',
  'proceed', 'keep', 'keep all',
  'yes', 'ok',
  'run',
  'retry', 'try again', 'continue',
];

// Words that DISQUALIFY a button even if it contains accept words.
var REJECT_WORDS = [
  'skip', 'reject', 'cancel', 'close', 'dismiss', 'decline',
  'deny', 'discard', 'undo', 'revert', 'debug', 'start',
  'stop', 'restart', 'terminal', 'delete', 'remove', 'open',
  'copy', 'edit', 'thought',
];

// Dangerous terminal commands — skip auto-run, let user decide
var DANGEROUS_COMMANDS = [
  // File/directory destruction
  'rm ', 'rm -', 'rmdir ', 'shred ', 'unlink ',
  // Windows file destruction
  'del ', 'del/', 'rd ', 'rd/',
  // Disk/format
  'format ', 'mkfs', 'dd if=',
  // Permission escalation
  'chmod 777', 'chmod -R 777', 'chown ',
  // System damage
  '> /dev/', ':(){', 'shutdown', 'reboot',
  // Database destruction
  'drop table', 'drop database', 'delete from', 'truncate ',
  // Git destructive
  'git push --force', 'git push -f', 'git reset --hard',
  'git clean -fd', 'git clean -xfd',
  // Remote code execution
  'curl | sh', 'curl | bash', 'wget | sh', 'wget | bash',
  // Package removal
  'npm uninstall', 'pip uninstall', 'apt remove', 'apt purge',
];

// ── Cursor Dialog Handling ────────────────────────
var USAGE_LIMIT_COOLDOWN_MS = 30000;
var USAGE_LIMIT_MAX_RETRIES = 3;
var __usageLimitRetryCount = 0;
var __lastUsageLimitResend = 0;

// Selectors for actual UI action buttons — NOT generic spans or links
var BUTTON_SELECTORS = [
  'button',
  '[role="button"]',
  '.monaco-button',
  '.bg-ide-button-background',
  'span[class*="bg-ide-button"]',
  'span.cursor-pointer',
  // Cursor-specific: Anysphere buttons are <div> elements, not <button>
  '.anysphere-text-button',
  '.anysphere-secondary-button',
  '.anysphere-focus-outline-button',
  '[data-click-ready="true"]',
].join(', ');

// ── TARGET CONTAINERS ────────────────────────────
// On the MAIN workbench document, scan ONLY these editor/diff containers:
var EDITOR_DIFF_SELECTORS = [
  '.chat-editing-session',
  '.chatEditing',
  '.modified-in-chat',
  '.inline-chat-widget',
  '.diff-review-widget',
  // Cursor-specific: composer area where Keep/Accept/Run buttons live
  '.composer-pane-controls-feedback',
  '.composer-tool-call-control-row',
  '.composer-single-file-block',
  // Cursor-specific: editor-level diff review toolbar (Keep All, Undo All)
  '.editor-group-container',
  '.file-modifications-toolbar',
  '.modifications-toolbar',
  '.review-flow-wrapper',
  // Cursor: top-level diff actions bar
  '.diff-actions-bar',
  '.diff-actions',
];

// On the CHAT PANEL iframe, the real Antigravity panel body structure is:
//   <div class="h-full w-full">
//     <div class="relative flex h-full w-full flex-col">
//       <div id="conversation">  ← messages live here
//         ... chat messages with code blocks ...
//       </div>
//       <div class="...">  ← input area
//   ...
// Buttons we want are ACTION buttons, NOT text/code in messages.
// We identify chat panel by: it's an iframe (window !== window.top)
// AND it has #conversation or notify-user-container.

// ── Shadow DOM Piercing ──────────────────────────

function deepQuerySelectorAll(root, selector) {
  var results = [];
  if (!root) return results;

  try {
    var found = root.querySelectorAll(selector);
    for (var i = 0; i < found.length; i++) results.push(found[i]);
  } catch (e) { /* ignore */ }

  try {
    var allElements = root.querySelectorAll('*');
    for (var i = 0; i < allElements.length; i++) {
      var el = allElements[i];
      if (el.shadowRoot) {
        var shadowResults = deepQuerySelectorAll(el.shadowRoot, selector);
        for (var j = 0; j < shadowResults.length; j++) results.push(shadowResults[j]);
      }
    }
  } catch (e) { /* ignore */ }

  return results;
}

// ── Button Detection ─────────────────────────────

/**
 * Get normalized text from a button element.
 * Only gets DIRECT button text, not nested code block content.
 * Handles buttons with shortcut spans: <button><span>Run</span><span>Alt+⏎</span></button>
 */
function getButtonText(el) {
  var text = '';
  try {
    // Try aria-label first (most reliable for VS Code buttons)
    text = el.getAttribute('aria-label') || '';
    if (!text) {
      // For buttons with multiple spans (label + shortcut), get first span only
      var spans = el.querySelectorAll(':scope > span');
      if (spans.length > 1) {
        // First span is usually the label, others are keyboard shortcuts
        text = (spans[0].textContent || '').trim();
      }
      if (!text) {
        // Get textContent but keep it short — real button text is < 30 chars
        text = (el.textContent || el.innerText || '').substring(0, 60);
      }
    }
    if (!text) {
      text = el.getAttribute('title') || '';
    }
  } catch (e) { /* ignore */ }
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * STRICT check: is this button text an accept action?
 * Uses WORD matching, NOT substring — "getAutoAcceptDetectOnly" will NOT match.
 */
function isAcceptButton(text) {
  if (!text) return false;
  // Max 60 chars — real buttons are short. Long text = code or message content.
  if (text.length > 60) return false;

  // Check reject words first
  for (var i = 0; i < REJECT_WORDS.length; i++) {
    if (text === REJECT_WORDS[i] || text.indexOf(REJECT_WORDS[i]) === 0) return false;
  }

  // Check accept words — STRICT matching
  for (var i = 0; i < ACCEPT_WORDS.length; i++) {
    var word = ACCEPT_WORDS[i];
    // Exact match
    if (text === word) return true;
    // Text starts with word and next char is space or end
    if (text.indexOf(word) === 0 && (text.length === word.length || text[word.length] === ' ')) return true;
  }

  return false;
}

/**
 * Check if an element is inside a code block, prose content, or message text.
 * These are FORBIDDEN zones — we never click buttons here.
 */
function isInsideCodeOrProse(el) {
  var parent = el;
  var depth = 0;
  while (parent && depth < 15) {
    var tag = parent.tagName;
    if (tag === 'PRE' || tag === 'CODE') return true;

    var cls = parent.className || '';
    if (typeof cls === 'string') {
      // Skip buttons inside prose/markdown rendered content
      if (cls.indexOf('prose') !== -1) return true;
      // Skip buttons inside code preview blocks
      if (cls.indexOf('code-block') !== -1 || cls.indexOf('codeblock') !== -1) return true;
      // Skip inline code containers
      if (cls.indexOf('inline') !== -1 && tag === 'PRE') return true;
    }

    parent = parent.parentElement;
    depth++;
  }
  return false;
}

/**
 * CRITICAL: Check if element is inside workbench UI zones we MUST NEVER touch.
 * These contain selectable text with 'accept' that would cause self-toggle.
 *
 * Forbidden zones:
 *   - Status bar: "Auto Accept: ON" toggle → clicking = self-disable
 *   - Explorer sidebar: folder "extension-auto-accept" → clicking = navigation
 *   - Activity bar: icon buttons on the left
 *   - Title bar: window title text
 *   - Notifications: toast messages
 *   - Panel header: terminal/problems area
 */
function isInsideForbiddenZone(el) {
  var parent = el;
  var depth = 0;
  while (parent && depth < 50) {
    var id = parent.id || '';
    var cls = parent.className || '';
    var part = parent.getAttribute ? (parent.getAttribute('part') || '') : '';

    // Status bar (contains "Auto Accept: ON" toggle)
    if (id === 'workbench.parts.statusbar') return true;
    if (cls.indexOf('statusbar') !== -1 && cls.indexOf('part') !== -1) return true;

    // Explorer / Sidebar
    if (id === 'workbench.parts.sidebar') return true;
    if (id === 'workbench.parts.auxiliarybar') return true;
    if (cls.indexOf('explorer-folders') !== -1) return true;
    if (cls.indexOf('file-explorer') !== -1) return true;

    // Activity bar (left icon bar)
    if (id === 'workbench.parts.activitybar') return true;

    // Title bar
    if (id === 'workbench.parts.titlebar') return true;

    // Panel (terminal, problems, output, debug console)
    if (id === 'workbench.parts.panel') return true;

    // Notifications
    if (cls.indexOf('notifications-center') !== -1) return true;
    if (cls.indexOf('notification-toast') !== -1) return true;

    // Part attribute matching
    if (part === 'statusbar' || part === 'sidebar' || part === 'activitybar' || part === 'titlebar' || part === 'panel') return true;

    // Antigravity-specific: extension UI elements
    if (cls.indexOf('auto-accept') !== -1 || cls.indexOf('domyh') !== -1) return true;
    // Settings editor
    if (id === 'workbench.parts.editor' && cls.indexOf('settings') !== -1) return true;
    // Walkthrough pages
    if (cls.indexOf('getting-started') !== -1 || cls.indexOf('walkthrough') !== -1) return true;

    // Cross shadow DOM boundaries upward
    parent = parent.parentElement || (parent.getRootNode && parent.getRootNode().host) || null;
    depth++;
  }
  return false;
}

/**
 * Check if element is visible and clickable.
 */
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
  } catch (e) {
    return false;
  }
}

// ── Container Detection ──────────────────────────

/**
 * Detect if we're running inside the Antigravity chat panel iframe.
 * The real chat panel has specific identifiers in its DOM.
 */
function isChatPanelIframe() {
  try {
    // Must be an iframe (not the main workbench)
    if (window === window.top) return false;
  } catch (e) {
    // Cross-origin check failed — we're in an iframe
    return true;
  }

  // Check for known Antigravity chat panel markers
  if (document.getElementById('conversation')) return true;
  if (document.querySelector('.notify-user-container')) return true;
  if (document.querySelector('[data-tooltip-id="cascade-header-menu"]')) return true;

  return false;
}

/**
 * Find editor diff containers on the main workbench.
 */
function findEditorDiffContainers() {
  var containers = [];
  for (var s = 0; s < EDITOR_DIFF_SELECTORS.length; s++) {
    var found = deepQuerySelectorAll(document, EDITOR_DIFF_SELECTORS[s]);
    for (var f = 0; f < found.length; f++) {
      containers.push(found[f]);
    }
  }
  return containers;
}

/**
 * In the chat panel iframe, find ONLY the action button areas.
 * Specifically look for:
 * - notify-user-container buttons (Proceed, Accept buttons in review cards)
 * - bg-ide-button elements (Antigravity styled action buttons)
 * - Buttons NOT inside prose/code content
 *
 * We do NOT add the entire document as a container.
 * Instead, we find buttons directly and filter aggressively.
 */
function findChatPanelButtons() {
  var buttons = [];
  var found = deepQuerySelectorAll(document, BUTTON_SELECTORS);

  for (var i = 0; i < found.length; i++) {
    var btn = found[i];

    // CRITICAL: Skip buttons inside code blocks, prose, or message text
    if (isInsideCodeOrProse(btn)) continue;
    // Workbench forbidden zones (status bar, explorer, etc.)
    if (isInsideForbiddenZone(btn)) continue;

    var text = getButtonText(btn);
    if (!text) continue;

    // Skip long text — real action buttons have short labels
    if (text.length > 60) continue;

    if (isAcceptButton(text) && isElementClickable(btn)) {
      buttons.push(btn);
    }
  }

  return buttons;
}

// ── Dangerous Command Safety ─────────────────────

/**
 * Check if a terminal command text contains dangerous patterns.
 * If dangerous, we SKIP auto-run and let the user decide.
 */
function isDangerousCommand(commandText) {
  var lower = commandText.toLowerCase().trim();
  for (var i = 0; i < DANGEROUS_COMMANDS.length; i++) {
    if (lower.indexOf(DANGEROUS_COMMANDS[i]) !== -1) return true;
  }
  return false;
}

/**
 * Extract the command text from the terminal "Run command?" panel.
 * The command is in a <pre> element inside the same container as the Run button.
 * DOM: DIV.border.rounded → PRE → [SPAN cwd] [SPAN " > "] [text: actual command]
 */
function getCommandTextForRunButton(btn) {
  var container = btn;
  for (var d = 0; d < 10 && container; d++) {
    var cls = (container.className || '').toString();
    if (cls.indexOf('border') !== -1 && cls.indexOf('rounded') !== -1) break;
    container = container.parentElement;
  }
  if (!container) return '';

  var pre = container.querySelector('pre');
  if (!pre) return '';

  // Get text after the " > " separator (cwd > command)
  var fullText = pre.textContent || '';
  var separatorIdx = fullText.indexOf(' > ');
  return separatorIdx !== -1 ? fullText.substring(separatorIdx + 3).trim() : fullText.trim();
}

// ── Iframe Traversal ─────────────────────────────

/**
 * Scan accessible iframes from the main workbench page.
 * The Antigravity chat panel is an iframe that IS accessible via contentDocument
 * but does NOT appear as a CDP Runtime execution context.
 * This function traverses it directly from the main page.
 */
function scanIframeDocuments() {
  var results = [];
  var iframes = document.querySelectorAll('iframe');

  for (var fi = 0; fi < iframes.length; fi++) {
    try {
      var doc = iframes[fi].contentDocument || (iframes[fi].contentWindow && iframes[fi].contentWindow.document);
      if (!doc) continue;

      // Check if this iframe is a chat panel (has #conversation or known markers)
      var isChat = !!doc.getElementById('conversation') ||
        !!doc.querySelector('.notify-user-container') ||
        !!doc.querySelector('[data-tooltip-id="cascade-header-menu"]');

      if (!isChat) continue;

      // Scan for accept buttons in this chat iframe document
      var found = doc.querySelectorAll(BUTTON_SELECTORS);
      for (var i = 0; i < found.length; i++) {
        var btn = found[i];

        // Skip buttons inside code blocks or prose content
        if (isInsideCodeOrProse(btn)) continue;

        var text = getButtonText(btn);
        if (!text) continue;
        if (text.length > 60) continue;

        if (isAcceptButton(text) && isElementClickable(btn)) {
          // Safety gate: check dangerous commands for "run" buttons
          if (text === 'run') {
            var cmdText = getCommandTextForRunButton(btn);
            if (cmdText && isDangerousCommand(cmdText)) continue;
          }
          results.push(btn);
        }
      }
    } catch (e) {
      // Cross-origin iframe — skip
    }
  }

  // Also check shadow DOM for iframes
  try {
    var allElements = document.querySelectorAll('*');
    for (var si = 0; si < allElements.length; si++) {
      if (!allElements[si].shadowRoot) continue;
      var shadowIframes = allElements[si].shadowRoot.querySelectorAll('iframe');
      for (var sfi = 0; sfi < shadowIframes.length; sfi++) {
        try {
          var sDoc = shadowIframes[sfi].contentDocument || (shadowIframes[sfi].contentWindow && shadowIframes[sfi].contentWindow.document);
          if (!sDoc) continue;
          var sIsChat = !!sDoc.getElementById('conversation') || !!sDoc.querySelector('.notify-user-container');
          if (!sIsChat) continue;

          var sFound = sDoc.querySelectorAll(BUTTON_SELECTORS);
          for (var sb = 0; sb < sFound.length; sb++) {
            if (isInsideCodeOrProse(sFound[sb])) continue;
            var sText = getButtonText(sFound[sb]);
            if (!sText || sText.length > 60) continue;
            if (isAcceptButton(sText) && isElementClickable(sFound[sb])) {
              if (sText === 'run') {
                var sCmdText = getCommandTextForRunButton(sFound[sb]);
                if (sCmdText && isDangerousCommand(sCmdText)) continue;
              }
              results.push(sFound[sb]);
            }
          }
        } catch (e) { /* cross-origin */ }
      }
    }
  } catch (e) { /* ignore */ }

  return results;
}

// ── Scroll-to-Bottom Auto-Click ──────────────────

/**
 * Find and click the "Scroll to bottom" button if it's visible.
 * This ensures the chat panel is scrolled down to show latest content
 * (including new accept/run buttons) before we scan for them.
 *
 * Only targets buttons with exact aria-label="Scroll to bottom".
 * Only clicks when actually visible (opacity > 0, non-zero rect).
 *
 * @param {Document} doc - The document to search in
 * @returns {boolean} true if a scroll button was clicked
 */
function clickScrollToBottomIfVisible(doc) {
  try {
    var scrollBtns = doc.querySelectorAll('button[aria-label="Scroll to bottom"]');
    for (var i = 0; i < scrollBtns.length; i++) {
      var btn = scrollBtns[i];

      // Check basic visibility
      var style = btn.ownerDocument.defaultView.getComputedStyle(btn);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (parseFloat(style.opacity) <= 0) continue;
      if (style.pointerEvents === 'none') continue;

      // Check bounding rect
      var rect = btn.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      btn.click();
      return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

// ── Cursor Dialog Handling ───────────────────────

/**
 * Handle Cursor-specific dialogs BEFORE generic button scan.
 * These dialogs have buttons that conflict with isAcceptButton() matching
 * (e.g. both "Continue without reverting" and "Continue and revert" match "continue").
 * We intercept them here and click the CORRECT button by CSS selector.
 */
function handleCursorDialogs() {
  // ── Dialog A: "Submit from a previous message?" ──
  var dialog = document.querySelector('.pretty-dialog-modal');
  if (dialog) {
    var title = dialog.querySelector('.pretty-dialog-title');
    var titleText = title ? (title.textContent || '').toLowerCase() : '';

    if (titleText.indexOf('previous message') !== -1 || titleText.indexOf('submit from') !== -1) {
      // Click "Continue without reverting" — the SECONDARY button (not primary)
      var continueBtn = dialog.querySelector('.anysphere-secondary-button.pretty-dialog-button');
      if (continueBtn && isElementClickable(continueBtn)) {
        continueBtn.click();
        return { action: 'dialog-continue', dialogType: 'submit-previous' };
      }
    }
  }

  // ── Dialog B: Warning popups that block chat (usage limit, unauthorized, etc.) ──
  var popup = document.querySelector('.composer-warning-popup');
  if (popup) {
    var popupTitle = popup.querySelector('.composer-error-title');
    var popupText = popupTitle ? (popupTitle.textContent || '').toLowerCase() : '';

    if (popupText.indexOf('usage limit') !== -1 || popupText.indexOf('hit your') !== -1 ||
      popupText.indexOf('unauthorized') !== -1 || popupText.indexOf('suspicious') !== -1) {
      var now = Date.now();
      // Safety guards: max retries + cooldown
      if (__usageLimitRetryCount >= USAGE_LIMIT_MAX_RETRIES) return { action: 'usage-limit-maxed' };
      if (now - __lastUsageLimitResend < USAGE_LIMIT_COOLDOWN_MS) return { action: 'usage-limit-cooldown' };

      // Close popup
      var closeBtn = popup.querySelector('.composer-warning-popup-close-button');
      if (closeBtn) closeBtn.click();

      // Verify chat input has content
      var input = document.querySelector('.aislash-editor-input[contenteditable="true"]');
      if (!input || !(input.textContent || '').trim()) return { action: 'usage-limit-empty-input' };

      // Click send button
      var sendBtn = document.querySelector('.send-with-mode .anysphere-icon-button');
      if (sendBtn && isElementClickable(sendBtn)) {
        sendBtn.click();
        __usageLimitRetryCount++;
        __lastUsageLimitResend = now;
        return { action: 'usage-limit-resent', retryCount: __usageLimitRetryCount };
      }
      return { action: 'usage-limit-no-send-btn' };
    }
  }

  return null; // No dialog detected
}

// ── Main Execution ───────────────────────────────

function findAndClickAcceptButtons() {
  var clickedButtons = [];
  var scanMode = 'none';

  // ── Phase 0: Handle Cursor-specific dialogs (BEFORE generic scan) ──
  var dialogResult = handleCursorDialogs();
  if (dialogResult) {
    var dialogClicked = (dialogResult.action.indexOf('resent') !== -1 || dialogResult.action.indexOf('continue') !== -1)
      ? [dialogResult.action] : [];
    return {
      clicked: dialogClicked,
      scanMode: 'cursor-dialog',
      scrollClicked: false,
      dialogAction: dialogResult,
    };
  }

  // Branch 1: We're in the chat panel iframe
  if (isChatPanelIframe()) {
    scanMode = 'chat-panel';

    // Scroll to bottom first — ensures latest content is visible
    var scrolled = clickScrollToBottomIfVisible(document);

    var buttons = findChatPanelButtons();

    for (var i = 0; i < buttons.length; i++) {
      try {
        buttons[i].click();
        clickedButtons.push(getButtonText(buttons[i]));
      } catch (e) { /* ignore */ }
    }

    return { clicked: clickedButtons, scanMode: scanMode, scrollClicked: scrolled };
  }

  // Branch 2: We're on the main workbench — scan editor diff containers
  var containers = findEditorDiffContainers();
  if (containers.length > 0) {
    scanMode = 'editor-diff';
    var checkedElements = new Set();

    for (var c = 0; c < containers.length; c++) {
      var btns = deepQuerySelectorAll(containers[c], BUTTON_SELECTORS);
      for (var i = 0; i < btns.length; i++) {
        var btn = btns[i];
        if (checkedElements.has(btn)) continue;
        checkedElements.add(btn);

        if (isInsideCodeOrProse(btn)) continue;
        if (isInsideForbiddenZone(btn)) continue;

        var text = getButtonText(btn);
        if (!text) continue;

        if (isAcceptButton(text) && isElementClickable(btn)) {
          try {
            btn.click();
            clickedButtons.push(text);
          } catch (e) { /* ignore */ }
        }
      }
    }
  }

  // Branch 2.5: Cursor-specific — scan workbench editor area for Anysphere buttons
  // These buttons (Keep All, Accept, etc.) live OUTSIDE standard diff containers
  // but inside the editor part. They have distinctive Anysphere CSS classes.
  if (clickedButtons.length === 0) {
    // Only scan inside the editor part, NOT sidebar/statusbar/panel
    var editorPart = document.getElementById('workbench.parts.editor');
    if (editorPart) {
      var anysphereSelectors = [
        '.anysphere-text-button',
        '.anysphere-secondary-button',
        '.anysphere-focus-outline-button',
        '[data-click-ready="true"]',
      ].join(', ');
      var ansBtns = deepQuerySelectorAll(editorPart, anysphereSelectors);
      for (var ab = 0; ab < ansBtns.length; ab++) {
        var aBtn = ansBtns[ab];
        if (isInsideCodeOrProse(aBtn)) continue;
        if (isInsideForbiddenZone(aBtn)) continue;
        var aText = getButtonText(aBtn);
        if (!aText) continue;
        if (isAcceptButton(aText) && isElementClickable(aBtn)) {
          try {
            aBtn.click();
            clickedButtons.push(aText);
            scanMode = scanMode === 'none' ? 'anysphere-direct' : scanMode + '+anysphere';
          } catch (e) { /* ignore */ }
        }
      }
    }
  }

  // Branch 3: Traverse accessible iframes from the main workbench
  // The chat panel iframe is same-origin and accessible via contentDocument,
  // but does NOT appear as a CDP Runtime execution context.
  // This is the PRIMARY path for finding Accept buttons on Antigravity.
  var scrolledInIframe = false;
  if (clickedButtons.length === 0) {
    var iframeButtons = scanIframeDocuments();
    if (iframeButtons.length > 0) {
      scanMode = scanMode === 'none' ? 'iframe-traverse' : scanMode + '+iframe';
      for (var ib = 0; ib < iframeButtons.length; ib++) {
        try {
          iframeButtons[ib].click();
          clickedButtons.push(getButtonText(iframeButtons[ib]));
        } catch (e) { /* ignore */ }
      }
    } else if (scanMode === 'none') {
      scanMode = 'no-targets';
    }

    // Also scroll-to-bottom in chat iframes from the main workbench
    try {
      var iframes = document.querySelectorAll('iframe');
      for (var si = 0; si < iframes.length; si++) {
        try {
          var iDoc = iframes[si].contentDocument || (iframes[si].contentWindow && iframes[si].contentWindow.document);
          if (!iDoc) continue;
          var iIsChat = !!iDoc.getElementById('conversation') || !!iDoc.querySelector('.notify-user-container');
          if (!iIsChat) continue;
          if (clickScrollToBottomIfVisible(iDoc)) {
            scrolledInIframe = true;
          }
        } catch (e) { /* cross-origin */ }
      }
    } catch (e) { /* ignore */ }
  }

  return { clicked: clickedButtons, scanMode: scanMode, scrollClicked: scrolledInIframe };
}

// Execute with safety wrapper
try {
  var result = findAndClickAcceptButtons();
  return JSON.stringify({
    clicks: result.clicked.length,
    blocked: 0,
    total: result.clicked.length,
    clickedType: result.clicked.length > 0 ? result.clicked[0] : null,
    buttons: result.clicked,
    scanMode: result.scanMode,
    scrollClicked: result.scrollClicked || false,
    dialogAction: result.dialogAction || null,
    timestamp: Date.now(),
  });
} catch (e) {
  return JSON.stringify({
    clicks: 0,
    blocked: 0,
    total: 0,
    clickedType: null,
    error: e.message || String(e),
  });
}
