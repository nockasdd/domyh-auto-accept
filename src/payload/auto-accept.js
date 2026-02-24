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

// Runtime configuration support
// The extension side is expected to set `window.__autoAcceptConfig`
// to a plain JSON object matching AutoAcceptRuntimeConfig. This payload
// keeps a safe default and merges any provided values at runtime.

var DEFAULT_RUNTIME_CONFIG = {
  enabled: true,
  clickRun: true,
  clickProceed: true,
  clickAcceptAll: true,
  clickAllowOnce: true,
  clickAllowConversation: true,
  clickSend: true,
  bannedCommands: [],
  dangerousCommands: [],
  forbiddenZonesExtra: [],
  pollFrequencyMs: 800,
  proceedThrottleMs: 4000,
  userScrollCooldownMs: 3000,
  maxClicksPerCycle: 20,
  logLevel: 'none',
};

function getRuntimeConfig() {
  var cfg = DEFAULT_RUNTIME_CONFIG;
  try {
    if (typeof window !== 'undefined' && window.__autoAcceptConfig) {
      var external = window.__autoAcceptConfig;
      // Shallow merge — keys not provided by extension fall back to defaults
      cfg = {
        enabled: typeof external.enabled === 'boolean' ? external.enabled : DEFAULT_RUNTIME_CONFIG.enabled,
        clickRun: typeof external.clickRun === 'boolean' ? external.clickRun : DEFAULT_RUNTIME_CONFIG.clickRun,
        clickProceed: typeof external.clickProceed === 'boolean' ? external.clickProceed : DEFAULT_RUNTIME_CONFIG.clickProceed,
        clickAcceptAll: typeof external.clickAcceptAll === 'boolean' ? external.clickAcceptAll : DEFAULT_RUNTIME_CONFIG.clickAcceptAll,
        clickAllowOnce: typeof external.clickAllowOnce === 'boolean' ? external.clickAllowOnce : DEFAULT_RUNTIME_CONFIG.clickAllowOnce,
        clickAllowConversation: typeof external.clickAllowConversation === 'boolean'
          ? external.clickAllowConversation
          : DEFAULT_RUNTIME_CONFIG.clickAllowConversation,
        clickSend: typeof external.clickSend === 'boolean' ? external.clickSend : DEFAULT_RUNTIME_CONFIG.clickSend,
        bannedCommands: Array.isArray(external.bannedCommands) ? external.bannedCommands.slice() : DEFAULT_RUNTIME_CONFIG.bannedCommands,
        dangerousCommands: Array.isArray(external.dangerousCommands) ? external.dangerousCommands.slice() : DEFAULT_RUNTIME_CONFIG.dangerousCommands,
        forbiddenZonesExtra: Array.isArray(external.forbiddenZonesExtra)
          ? external.forbiddenZonesExtra.slice()
          : DEFAULT_RUNTIME_CONFIG.forbiddenZonesExtra,
        pollFrequencyMs:
          typeof external.pollFrequencyMs === 'number' && external.pollFrequencyMs > 0
            ? external.pollFrequencyMs
            : DEFAULT_RUNTIME_CONFIG.pollFrequencyMs,
        proceedThrottleMs:
          typeof external.proceedThrottleMs === 'number' && external.proceedThrottleMs > 0
            ? external.proceedThrottleMs
            : DEFAULT_RUNTIME_CONFIG.proceedThrottleMs,
        userScrollCooldownMs:
          typeof external.userScrollCooldownMs === 'number' && external.userScrollCooldownMs > 0
            ? external.userScrollCooldownMs
            : DEFAULT_RUNTIME_CONFIG.userScrollCooldownMs,
        maxClicksPerCycle:
          typeof external.maxClicksPerCycle === 'number' && external.maxClicksPerCycle > 0
            ? external.maxClicksPerCycle
            : DEFAULT_RUNTIME_CONFIG.maxClicksPerCycle,
        logLevel: external.logLevel === 'debug' || external.logLevel === 'info' || external.logLevel === 'none'
          ? external.logLevel
          : DEFAULT_RUNTIME_CONFIG.logLevel,
      };
    }
  } catch (e) {
    // In case anything goes wrong, fall back to defaults
    cfg = DEFAULT_RUNTIME_CONFIG;
  }
  return cfg;
}

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
  'copy', 'edit', 'thought', 'review',
  // Cursor-specific: dropdown/menu buttons that should NOT be clicked
  'ask every time', 'use allowlist', 'run everything', 'allowlist',
  'every time', 'everything',
  // Reject buttons with "allowlist" in text (e.g., "Allowlist 'cd' + 1")
  // These are secondary buttons, not the primary "Run" button
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
// Persist state in window to survive across CDP evaluations
if (typeof window !== 'undefined') {
  window.__usageLimitState = window.__usageLimitState || { count: 0, lastResend: 0 };
}

// ── User Scroll Detection ─────────────────────────
// Track when user is actively scrolling to prevent auto-clicking buttons
// This prevents interrupting users who are reading previous chat messages
// NOTE: Cooldown is read from runtime config on every event, this value is only a fallback.
var USER_SCROLL_COOLDOWN_MS = DEFAULT_RUNTIME_CONFIG.userScrollCooldownMs; // default 3s, override via runtime config
var PROGRAMMATIC_SCROLL_MARKER_MS = 1000; // Increased to 1000ms to account for scroll animations and delays
var SCROLLBAR_DETECTION_WIDTH = 30; // Width of scrollbar detection area (pixels)
var SCROLL_POSITION_THRESHOLD = 3; // Minimum scroll change to detect drag (pixels)
var SCROLL_DEBOUNCE_MS = 100; // Debounce time for scroll events to avoid false positives

// Throttle for sensitive actions (e.g., Proceed) so they are not double-clicked
// across multiple polling cycles while the UI is still visible.
// NOTE: Actual throttle is read from runtime config in shouldSkipProceedClick().
var PROCEED_THROTTLE_MS = DEFAULT_RUNTIME_CONFIG.proceedThrottleMs; // default 4s, override via runtime config

if (typeof window !== 'undefined') {
  window.__autoAcceptClickState = window.__autoAcceptClickState || {
    lastProceedClick: 0,
  };
}

function shouldSkipProceedClick() {
  try {
    if (typeof window === 'undefined') return false;
    var state = window.__autoAcceptClickState || (window.__autoAcceptClickState = { lastProceedClick: 0 });
    var now = Date.now();
    var cfg = getRuntimeConfig();
    var throttleMs = (cfg && typeof cfg.proceedThrottleMs === 'number' && cfg.proceedThrottleMs > 0)
      ? cfg.proceedThrottleMs
      : PROCEED_THROTTLE_MS;
    if (now - state.lastProceedClick < throttleMs) {
      return true; // Recently clicked Proceed — skip this attempt
    }
    state.lastProceedClick = now;
    return false;
  } catch (e) {
    return false;
  }
}

// Initialize scroll state for a window (works for both main window and iframes)
function initializeScrollState(win) {
  if (!win || typeof win === 'undefined') return;
  win.__userScrollState = win.__userScrollState || { 
    isScrolling: false, 
    lastScrollTime: 0,
    lastProgrammaticScrollTime: 0, // Track when we programmatically scroll
    scrollTimeout: null,
    isMouseDown: false,
    mouseDownTime: 0,
    isScrollbarDrag: false, // Track if user is dragging scrollbar
    lastKnownScrollTop: undefined, // Track scroll position for drag detection
    trackedScrollContainers: {}, // Track scroll positions for multiple containers
    scrollDebounceTimeout: null // Debounce timeout for scroll events
  };
}

// Initialize state for current window
if (typeof window !== 'undefined') {
  initializeScrollState(window);
  
  // Helper function to find scrollable container at a point
  function findScrollableContainerAtPoint(x, y, doc) {
    if (!doc) return null;
    var el = doc.elementFromPoint(x, y);
    var maxDepth = 12; // Increased depth to find deeply nested scrollable containers
    var bestContainer = null;
    var bestScore = 0;
    
    while (el && maxDepth-- > 0) {
      try {
        var win = doc.defaultView || window;
        var style = win.getComputedStyle(el);
        var hasVerticalScroll = style.overflowY === 'auto' || style.overflowY === 'scroll' ||
                                style.overflow === 'auto' || style.overflow === 'scroll';
        var hasHorizontalScroll = style.overflowX === 'auto' || style.overflowX === 'scroll' ||
                                  style.overflow === 'auto' || style.overflow === 'scroll';
        
        if (hasVerticalScroll || hasHorizontalScroll) {
          var rect = el.getBoundingClientRect();
          var scrollHeight = el.scrollHeight || 0;
          var clientHeight = el.clientHeight || 0;
          var scrollWidth = el.scrollWidth || 0;
          var clientWidth = el.clientWidth || 0;
          
          // Score container: prefer larger scrollable areas
          var score = 0;
          if (hasVerticalScroll && scrollHeight > clientHeight) {
            score += (scrollHeight - clientHeight) / 10;
            // Check if point is in vertical scrollbar area (right edge)
            if (x >= rect.right - SCROLLBAR_DETECTION_WIDTH && x <= rect.right) {
              score += 1000; // High score for scrollbar area
            }
          }
          if (hasHorizontalScroll && scrollWidth > clientWidth) {
            score += (scrollWidth - clientWidth) / 10;
            // Check if point is in horizontal scrollbar area (bottom edge)
            if (y >= rect.bottom - SCROLLBAR_DETECTION_WIDTH && y <= rect.bottom) {
              score += 1000; // High score for scrollbar area
            }
          }
          
          if (score > bestScore) {
            bestScore = score;
            bestContainer = el;
          }
        }
      } catch (err) { /* skip */ }
      el = el.parentElement;
    }
    
    return bestContainer;
  }
  
  // Helper function to check if point is in scrollbar area
  function isPointInScrollbarArea(x, y, container) {
    try {
      var rect = container.getBoundingClientRect();
      var win = container.ownerDocument ? container.ownerDocument.defaultView : window;
      var style = win.getComputedStyle(container);
      var hasVerticalScroll = style.overflowY === 'auto' || style.overflowY === 'scroll' ||
                              style.overflow === 'auto' || style.overflow === 'scroll';
      var hasHorizontalScroll = style.overflowX === 'auto' || style.overflowX === 'scroll' ||
                                style.overflow === 'auto' || style.overflow === 'scroll';
      
      // Check vertical scrollbar (right edge)
      if (hasVerticalScroll && x >= rect.right - SCROLLBAR_DETECTION_WIDTH && x <= rect.right) {
        return true;
      }
      // Check horizontal scrollbar (bottom edge)
      if (hasHorizontalScroll && y >= rect.bottom - SCROLLBAR_DETECTION_WIDTH && y <= rect.bottom) {
        return true;
      }
    } catch (err) { /* skip */ }
    return false;
  }
  
  // Initialize scroll detection listeners for a window (works for both main window and iframes)
  // This function is defined in global scope so it can be called from anywhere
  window.initializeScrollListeners = function(win, doc) {
    if (!win || !doc) return;
    // Check if already initialized for this window
    if (win.__scrollListenersInitialized) return;
    win.__scrollListenersInitialized = true;
    
    // Ensure state is initialized
    initializeScrollState(win);
    
    // Track mouse wheel events (most reliable indicator of user scroll)
    var handleWheel = function(e) {
      var state = win.__userScrollState;
      if (!state) return;
      // Wheel events are ALWAYS user-initiated
      state.isScrolling = true;
      state.lastScrollTime = Date.now();
      // Clear any existing timeout
      if (state.scrollTimeout) clearTimeout(state.scrollTimeout);
      // Clear debounce timeout
      if (state.scrollDebounceTimeout) clearTimeout(state.scrollDebounceTimeout);
      var cfg = getRuntimeConfig();
      var cooldownMs = (cfg && typeof cfg.userScrollCooldownMs === 'number' && cfg.userScrollCooldownMs > 0)
        ? cfg.userScrollCooldownMs
        : USER_SCROLL_COOLDOWN_MS;
      state.scrollTimeout = setTimeout(function() {
        state.isScrolling = false;
      }, cooldownMs);
    };
    
    // Track mouse down - check if on scrollbar or if user is about to drag
    var handleMouseDown = function(e) {
      var state = win.__userScrollState;
      if (!state) return;
      state.isMouseDown = true;
      state.mouseDownTime = Date.now();
      state.isScrollbarDrag = false;
      
      // Find scrollable container at click point
      var container = findScrollableContainerAtPoint(e.clientX, e.clientY, doc);
      if (container && isPointInScrollbarArea(e.clientX, e.clientY, container)) {
        // User clicked on scrollbar - mark as scrolling
        state.isScrollbarDrag = true;
        state.isScrolling = true;
        state.lastScrollTime = Date.now();
        
        // Track initial scroll position for this container
        var containerId = container.id || (container.className ? container.className.toString().substring(0, 50) : '') || 'container-' + Date.now();
        state.trackedScrollContainers[containerId] = {
          element: container,
          lastScrollTop: container.scrollTop || 0,
          lastScrollLeft: container.scrollLeft || 0
        };
        
        if (state.scrollTimeout) clearTimeout(state.scrollTimeout);
        state.scrollTimeout = setTimeout(function() {
          state.isScrolling = false;
        }, USER_SCROLL_COOLDOWN_MS);
      }
    };
    
    // Track mouse move - if mouse is down and moving, user might be dragging scrollbar
    var handleMouseMove = function(e) {
      var state = win.__userScrollState;
      if (!state) return;
      
      // If mouse is down and moving, check if we're dragging scrollbar
      if (state.isMouseDown && e.buttons !== undefined && (e.buttons & 1) === 1) {
        // Left mouse button is pressed and mouse is moving = potential drag
        var container = findScrollableContainerAtPoint(e.clientX, e.clientY, doc);
        
        // Check if we're in scrollbar area or already dragging
        if (container && (state.isScrollbarDrag || isPointInScrollbarArea(e.clientX, e.clientY, container))) {
          state.isScrollbarDrag = true;
          state.isScrolling = true;
          state.lastScrollTime = Date.now();
          
          // Track scroll position changes for this container
          var containerId = container.id || (container.className ? container.className.toString().substring(0, 50) : '') || 'container-' + Date.now();
          var tracked = state.trackedScrollContainers[containerId];
          if (!tracked) {
            tracked = {
              element: container,
              lastScrollTop: container.scrollTop || 0,
              lastScrollLeft: container.scrollLeft || 0
            };
            state.trackedScrollContainers[containerId] = tracked;
          }
          
          // Check if scroll position changed (user is dragging)
          var currentScrollTop = container.scrollTop || 0;
          var currentScrollLeft = container.scrollLeft || 0;
          if (Math.abs(currentScrollTop - tracked.lastScrollTop) > SCROLL_POSITION_THRESHOLD ||
              Math.abs(currentScrollLeft - tracked.lastScrollLeft) > SCROLL_POSITION_THRESHOLD) {
            // Scroll position changed = user is actively dragging
            tracked.lastScrollTop = currentScrollTop;
            tracked.lastScrollLeft = currentScrollLeft;
            state.isScrolling = true;
            state.lastScrollTime = Date.now();
          }
          
          if (state.scrollTimeout) clearTimeout(state.scrollTimeout);
          state.scrollTimeout = setTimeout(function() {
            state.isScrolling = false;
          }, USER_SCROLL_COOLDOWN_MS);
        } else {
          // Also check document-level scroll position as fallback
          // This catches drags that might not be detected by container detection
          var docScrollTop = (doc.documentElement && doc.documentElement.scrollTop) || 
                             (doc.body && doc.body.scrollTop) || 0;
          if (typeof state.lastKnownScrollTop === 'undefined') {
            state.lastKnownScrollTop = docScrollTop;
          } else if (Math.abs(docScrollTop - state.lastKnownScrollTop) > SCROLL_POSITION_THRESHOLD) {
            // Scroll position changed significantly while mouse is down = user is dragging
            state.isScrolling = true;
            state.lastScrollTime = Date.now();
            if (state.scrollTimeout) clearTimeout(state.scrollTimeout);
            state.scrollTimeout = setTimeout(function() {
              state.isScrolling = false;
            }, USER_SCROLL_COOLDOWN_MS);
          }
          state.lastKnownScrollTop = docScrollTop;
        }
      }
    };
    
    var handleMouseUp = function() {
      var state = win.__userScrollState;
      if (!state) return;
      state.isMouseDown = false;
      
      // Keep scrollbar drag flag for a short time after mouse up
      // (user might have been dragging and will continue)
      if (state.isScrollbarDrag) {
        // Reset scrollbar drag flag after a short delay
        setTimeout(function() {
          if (state) state.isScrollbarDrag = false;
        }, 100);
      }
      
      // If user was scrolling, keep the flag for a bit after mouse up
      // (user might have been reading and will continue scrolling)
      if (state.isScrolling) {
        if (state.scrollTimeout) clearTimeout(state.scrollTimeout);
        state.scrollTimeout = setTimeout(function() {
          if (state) state.isScrolling = false;
        }, USER_SCROLL_COOLDOWN_MS);
      }
    };
    
    // Track scroll events - distinguish between user scroll and programmatic scroll
    // Use debounce to avoid false positives from rapid scroll events
    var handleScroll = function(e) {
      var state = win.__userScrollState;
      if (!state) return;
      
      // Clear existing debounce timeout
      if (state.scrollDebounceTimeout) clearTimeout(state.scrollDebounceTimeout);
      
      // Debounce scroll detection to avoid false positives
      state.scrollDebounceTimeout = setTimeout(function() {
        if (!state) return;
        var now = Date.now();
        
        // Check if this is a programmatic scroll (we just scrolled programmatically)
        var timeSinceProgrammaticScroll = now - state.lastProgrammaticScrollTime;
        if (timeSinceProgrammaticScroll < PROGRAMMATIC_SCROLL_MARKER_MS) {
          // This is likely a programmatic scroll - don't mark as user scrolling
          return;
        }
        
        // Check if this scroll happened while mouse is down (user dragging)
        if (state.isMouseDown || state.isScrollbarDrag) {
          // Mouse is down or scrollbar is being dragged = user is likely scrolling
          state.isScrolling = true;
          state.lastScrollTime = now;
          if (state.scrollTimeout) clearTimeout(state.scrollTimeout);
          state.scrollTimeout = setTimeout(function() {
            if (state) state.isScrolling = false;
          }, USER_SCROLL_COOLDOWN_MS);
          return;
        }
        
        // Check time since last scroll - if very recent, might be programmatic
        // If it's been more than 200ms since last scroll, it's likely a new user scroll
        var timeSinceLastScroll = now - state.lastScrollTime;
        if (timeSinceLastScroll > 200) { // Increased threshold to 200ms for better detection
          // This looks like a user scroll (not programmatic)
          state.isScrolling = true;
          state.lastScrollTime = now;
          if (state.scrollTimeout) clearTimeout(state.scrollTimeout);
          state.scrollTimeout = setTimeout(function() {
            if (state) state.isScrolling = false;
          }, USER_SCROLL_COOLDOWN_MS);
        }
      }, SCROLL_DEBOUNCE_MS);
    };
    
    // Add listeners to document and window with capture phase for better detection
    doc.addEventListener('wheel', handleWheel, { passive: true, capture: true });
    doc.addEventListener('mousedown', handleMouseDown, { capture: true });
    doc.addEventListener('mousemove', handleMouseMove, { passive: true, capture: true });
    doc.addEventListener('mouseup', handleMouseUp, { capture: true });
    doc.addEventListener('scroll', handleScroll, { passive: true, capture: true });
    
    // Also listen on window for scroll events
    win.addEventListener('scroll', handleScroll, { passive: true, capture: true });
    
    // Track mouse leave to reset mouse down state
    doc.addEventListener('mouseleave', function() {
      var state = win.__userScrollState;
      if (state) {
        state.isMouseDown = false;
        state.isScrollbarDrag = false;
      }
    }, { capture: true });
  }
  
  // Initialize scroll detection listeners for main window
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.initializeScrollListeners(window, document);
  }
}

// CRITICAL: Also initialize scroll detection for current context (works for both main window and iframes)
// This ensures scroll detection works even when payload is injected into iframes
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  // Check if already initialized
  if (!window.__scrollListenersInitialized && window.initializeScrollListeners) {
    try {
      window.initializeScrollListeners(window, document);
    } catch (e) { /* ignore */ }
  }
}

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
  '.anysphere-button', // Run button uses this class
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
  // Antigravity Implementation Plan / artifact view (Proceed button)
  '.artifact-view',
  // Cursor-specific: composer area where Keep/Accept/Run buttons live
  '.composer-pane-controls-feedback',
  '.composer-tool-call-control-row',
  '.composer-single-file-block',
  '#composer-files-edited-header',
  '.composer-files-edited-header',
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

function deepQuerySelectorAll(root, selector, maxDepth) {
  maxDepth = maxDepth || 5; // Limit depth to prevent O(n) full DOM scan
  var results = [];
  if (!root || maxDepth <= 0) return results;

  try {
    var found = root.querySelectorAll(selector);
    for (var i = 0; i < found.length; i++) results.push(found[i]);
  } catch (e) { /* ignore */ }

  try {
    // Limit shadow DOM traversal depth
    var allElements = root.querySelectorAll('*');
    var limit = Math.min(allElements.length, 100); // Cap at 100 elements per level
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
        // Check nested spans (e.g., anysphere-text-button structure)
        var nestedSpans = el.querySelectorAll('span');
        for (var i = 0; i < nestedSpans.length; i++) {
          var spanText = (nestedSpans[i].textContent || '').trim();
          // Prefer spans with class "truncate" (common in Cursor buttons)
          if (spanText && (nestedSpans[i].classList.contains('truncate') || spanText.length < 30)) {
            text = spanText;
            break;
          }
        }
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
  // Normalize text: remove special characters (⏎, ⇧, etc.) and keyboard shortcuts
  // These are often appended to button text (e.g., "run⏎", "Allowlist 'cd' + 1⇧⏎")
  text = text.trim()
    .replace(/[⏎⇧⌘⌥⌃⌫↵↩]/g, '') // Remove keyboard shortcut symbols
    .replace(/\s*\+\s*\d+\s*/g, '') // Remove "+ 1", "+ 3" patterns
    .replace(/\s+/g, ' ') // Normalize whitespace
    .toLowerCase();
  return text;
}

/**
 * STRICT check: is this button text an accept action?
 * Uses WORD matching, NOT substring — "getAutoAcceptDetectOnly" will NOT match.
 */
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

/**
 * Check if an element is inside a code block, prose content, or message text.
 * These are FORBIDDEN zones — we never click buttons here.
 */
function isInsideCodeOrProse(el) {
  var parent = el;
  var depth = 0;
  // Check if button is in composer tool call controls (these are OK)
  var cls = (el.className || '').toString();
  // CRITICAL: Skip dropdown/menu buttons - they should NEVER be clicked
  // These buttons open menus/dropdowns, not execute actions
  if (cls.indexOf('composer-tool-call-allowlist-button') !== -1 ||
      cls.indexOf('composer-tool-call-menu-button') !== -1 ||
      cls.indexOf('composer-tool-call-menu-controls') !== -1) {
    return true; // These are dropdowns - SKIP them (treat as "inside code/prose")
  }
  // Allow Run and Skip buttons, but NOT dropdowns
  if (cls.indexOf('composer-run-button') !== -1 || cls.indexOf('composer-skip-button') !== -1 ||
      cls.indexOf('composer-tool-call-control') !== -1) {
    return false; // These buttons are OK (but check for dropdown above first)
  }
  
  while (parent && depth < 15) {
    var tag = parent.tagName;
    // Allow buttons inside composer tool call containers
    var parentCls = (parent.className || '').toString();
    if (parentCls.indexOf('composer-tool-call-control') !== -1 ||
        parentCls.indexOf('composer-tool-call-control-row') !== -1) {
      return false; // These containers are OK
    }
    
    if (tag === 'PRE' || tag === 'CODE') return true;

    if (typeof parentCls === 'string') {
      // Skip buttons inside prose/markdown rendered content
      if (parentCls.indexOf('prose') !== -1 && parentCls.indexOf('composer-tool-call') === -1) return true;
      // Skip buttons inside code preview blocks (but allow composer terminal command editor)
      if (parentCls.indexOf('code-block') !== -1 || parentCls.indexOf('codeblock') !== -1) {
        if (parentCls.indexOf('composer-terminal-command-editor') === -1) return true;
      }
      // Skip inline code containers
      if (parentCls.indexOf('inline') !== -1 && tag === 'PRE') return true;
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
  // CRITICAL: Check element's own classes FIRST (fast path for Run buttons)
  // This ensures Run buttons with class "composer-run-button" are allowed immediately
  var isCursor = isCursorIDE();
  var elCls = (el.className || '').toString();

  // CRITICAL: Check for composer-run-button class FIRST (fastest path)
  // This is the most reliable way to identify Run buttons in Cursor
  if (isCursor && (elCls.indexOf('composer-run-button') !== -1 ||
      elCls.indexOf('composer-skip-button') !== -1 ||
      elCls.indexOf('composer-tool-call-control') !== -1)) {
    // But check if it's a dropdown button first (these should be skipped)
    if (elCls.indexOf('composer-tool-call-allowlist-button') !== -1 ||
        elCls.indexOf('composer-tool-call-menu-button') !== -1) {
      return true; // Dropdown buttons should be skipped
    }
    return false; // Allow Run/Skip buttons immediately
  }

  // Special-case: Cursor "Run" button in the terminal run panel.
  // New Cursor UIs sometimes drop explicit composer-* classes and only use generic flex classes.
  // When that happens, the button still has anysphere-* button classes and text "run".
  // We MUST allow this even if it's inside auxiliarybar, while still keeping global safeguards.
  // CRITICAL FIX: Also check by text "run" even if button doesn't have anysphere class
  try {
    if (isCursor) {
      var btnText = getButtonText(el);
      if (btnText === 'run') {
        // Additional check: ensure this is a Run button in composer context
        // Look for nearby composer-tool-call or composer-terminal elements
        var parent = el;
        for (var p = 0; p < 20 && parent; p++) {
          var pCls = (parent.className || '').toString();
          if (pCls.indexOf('composer-tool-call') !== -1 ||
              pCls.indexOf('composer-terminal') !== -1 ||
              pCls.indexOf('composer-pane') !== -1) {
            return false; // This is a Run button in composer context - allow it
          }
          parent = parent.parentElement;
        }
        // If we can't find composer context, still allow if button has cursor-pointer class
        // (this is a common pattern for Cursor buttons)
        if (elCls.indexOf('cursor-pointer') !== -1 || elCls.indexOf('cursor-p') !== -1) {
          return false; // Likely a Run button - allow it
        }
        // Also allow if button has anysphere class (original logic)
        if (elCls.indexOf('anysphere') !== -1) {
          return false; // Anysphere button with text "run" - allow it
        }
      }
    }
  } catch (e) { /* ignore */ }
  
  var parent = el;
  var depth = 0;
  // ALLOW: Composer area (Keep All, Accept, Run buttons, etc.) — even if inside auxiliarybar
  // ONLY for Cursor IDE to avoid interfering with Antigravity
  // CRITICAL: Check for composer areas FIRST, before checking forbidden zones
  // This ensures Run buttons in composer-tool-call-control-row are allowed
  while (parent && depth < 100) {
    var id = parent.id || '';
    var cls = (parent.className || '').toString();
    // Allow entire Antigravity agent side panel (diff header, Accept all, etc. live here),
    // even if the overall page is a Walkthrough.
    if (cls.indexOf('antigravity-agent-side-panel') !== -1) {
      return false;
    }
    // Allow Antigravity artifact view (Implementation Plan) — Proceed button lives here.
    // Even if the parent page is a Walkthrough, this panel is a safe, explicit action area.
    if (cls.indexOf('artifact-view') !== -1) {
      return false;
    }
    // Allow composer headers and pane controls (both IDEs)
    if (id === 'composer-files-edited-header' || cls.indexOf('composer-files-edited-header') !== -1 ||
        cls.indexOf('composer-pane-controls-feedback') !== -1) {
      return false; // Allow composer areas (both IDEs may have these)
    }
    // Allow composer-tool-call containers (Cursor-specific)
    // This includes composer-tool-call-control-row where Run buttons live
    if (isCursor && (cls.indexOf('composer-tool-call') !== -1 ||
        cls.indexOf('composer-tool-call-control-row') !== -1 ||
        cls.indexOf('composer-tool-call-status-row') !== -1)) {
      return false; // Allow composer tool calls (Cursor-specific)
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
  while (parent && depth < 100) {
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
 * Detect if we're running in Cursor IDE (not Antigravity or other forks).
 * Cursor has distinctive DOM markers like composer panels and anysphere buttons.
 */
function isCursorIDE() {
  // Check for Cursor-specific markers
  if (document.querySelector('.composer-rendered-message')) return true;
  if (document.querySelector('.composer-pane-controls-feedback')) return true;
  if (document.querySelector('.composer-files-edited-header')) return true;
  if (document.querySelector('.composer-tool-call')) return true;
  if (document.querySelector('.anysphere-button')) return true;
  if (document.querySelector('.anysphere-text-button')) return true;
  return false;
}

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
  // Cursor composer panel markers
  if (document.querySelector('.composer-rendered-message')) return true;
  if (document.querySelector('.composer-pane-controls-feedback')) return true;

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
 * Check if a Run button should be allowed to click.
 * Returns { allowed: boolean, cmdText: string, reason: string }
 * Handles both terminal commands and MCP tool calls.
 */
function shouldAllowRunButton(btn) {
  var cmdText = getCommandTextForRunButton(btn);
  // Check if this is an MCP tool call (has composer-tool-call-header-content)
  if (!cmdText) {
    var toolCallContainer = btn;
    for (var tc = 0; tc < 10 && toolCallContainer; tc++) {
      var tcCls = (toolCallContainer.className || '').toString();
      if (tcCls.indexOf('composer-tool-call') !== -1) {
        var hasMCPHeader = !!toolCallContainer.querySelector('.composer-tool-call-header-content');
        if (hasMCPHeader) {
          // MCP tool calls are safe, allow even without command text
          return { allowed: true, cmdText: 'mcp-tool-call', reason: 'mcp-tool-call' };
        }
      }
      toolCallContainer = toolCallContainer.parentElement;
    }
    // Fail-closed: if we can't parse command text, don't click
    return { allowed: false, cmdText: '', reason: 'no-command-text' };
  }
  // MCP tool calls are not dangerous terminal commands
  if (cmdText === 'mcp-tool-call' || cmdText.indexOf('mcp-tool-call') !== -1) {
    return { allowed: true, cmdText: cmdText, reason: 'mcp-tool-call' };
  }
  // Check dangerous commands
  if (isDangerousCommand(cmdText)) {
    return { allowed: false, cmdText: cmdText, reason: 'dangerous-command' };
  }
  return { allowed: true, cmdText: cmdText, reason: 'safe-command' };
}

/**
 * Check if a terminal command text contains dangerous patterns.
 * If dangerous, we SKIP auto-run and let the user decide.
 */
function isDangerousCommand(commandText) {
  var lower = commandText.toLowerCase().trim();
  // Check built-in dangerous patterns
  for (var i = 0; i < DANGEROUS_COMMANDS.length; i++) {
    var pattern = DANGEROUS_COMMANDS[i];
    // Use word-boundary matching for commands that should be at start or after space
    // e.g., "rm " should match "rm -rf" but not "confirm"
    if (pattern.endsWith(' ')) {
      // Commands ending with space: match at start or after space/start-of-line
      if (lower.indexOf(pattern) === 0 || lower.indexOf(' ' + pattern) !== -1) {
        return true;
      }
    } else {
      // Other patterns: substring match (e.g., "drop table", "git push --force")
      if (lower.indexOf(pattern) !== -1) return true;
    }
  }
  // Check user-configured bannedCommands (regex patterns)
  if (typeof __config !== 'undefined' && __config.bannedCommands && Array.isArray(__config.bannedCommands)) {
    for (var j = 0; j < __config.bannedCommands.length; j++) {
      try {
        var regex = new RegExp(__config.bannedCommands[j], 'i');
        if (regex.test(commandText)) return true;
      } catch (e) {
        // Invalid regex — skip
      }
    }
  }
  return false;
}

/**
 * Extract the command text from the terminal "Run command?" panel.
 * Supports multiple formats:
 * 1. Old format: DIV.border.rounded → PRE → [SPAN cwd] [SPAN " > "] [text: actual command]
 * 2. New format (Cursor): .composer-terminal-command-editor → Monaco editor → text content
 * 3. MCP tool calls: May not have terminal command editor (tool name is in header)
 */
function getCommandTextForRunButton(btn) {
  var container = btn;
  // Find the composer tool call container
  // CRITICAL: Search up to 30 levels to find composer container
  for (var d = 0; d < 30 && container; d++) {
    var cls = (container.className || '').toString();
    var id = container.id || '';
    // Look for composer-tool-call, composer-terminal, or any composer-related markers
    if (cls.indexOf('composer-tool-call') !== -1 || 
        cls.indexOf('composer-terminal') !== -1 ||
        cls.indexOf('composer') !== -1 ||
        id.indexOf('composer') !== -1) {
      break;
    }
    container = container.parentElement;
    if (!container) break;
  }
  
  // If still no container, try searching siblings and nearby elements
  if (!container) {
    var parent = btn.parentElement;
    if (parent) {
      // Search siblings for composer elements
      var siblings = parent.children;
      for (var s = 0; s < siblings.length; s++) {
        var sCls = (siblings[s].className || '').toString();
        if (sCls.indexOf('composer-tool-call') !== -1 || 
            sCls.indexOf('composer-terminal') !== -1 ||
            sCls.indexOf('composer') !== -1) {
          container = siblings[s];
          break;
        }
      }
      // Also check parent's parent for composer elements
      if (!container && parent.parentElement) {
        var grandParent = parent.parentElement;
        var gpCls = (grandParent.className || '').toString();
        if (gpCls.indexOf('composer-tool-call') !== -1 || 
            gpCls.indexOf('composer-terminal') !== -1 ||
            gpCls.indexOf('composer') !== -1) {
          container = grandParent;
        }
      }
    }
  }

  // Generic fallback for non-composer UIs (e.g. Antigravity "Run command?" cards)
  // If we still don't have a container, walk up a few levels looking for a block
  // that actually contains the command (typically a <pre> element with the command).
  if (!container) {
    container = btn.parentElement;
    var fallbackDepth = 0;
    while (container && fallbackDepth < 10) {
      try {
        if (container.querySelector && container.querySelector('pre')) {
          // Found an ancestor that wraps the <pre> command block — good enough
          break;
        }
      } catch (e) { /* ignore query errors */ }
      container = container.parentElement;
      fallbackDepth++;
    }
  }

  // Last resort: if we still can't find container, give up
  if (!container) return '';

  // Last resort: if we can't find container, try to find command editor directly
  // This handles cases where Run button is in a complex DOM structure
  if (!container) {
    var nearby = btn;
    for (var n = 0; n < 20 && nearby; n++) {
      var cmdEditor = nearby.querySelector('.composer-terminal-command-editor, .simple-code-render, .composer-terminal-command-wrapper, pre');
      if (cmdEditor) {
        container = nearby;
        break;
      }
      nearby = nearby.parentElement;
      if (!nearby) break;
    }
  }
  
  if (!container) return '';

  // Check if this is an MCP tool call (not a terminal command)
  // MCP tool calls have .composer-tool-call-header-content with tool name
  var isMCPToolCall = !!container.querySelector('.composer-tool-call-header-content');
  if (isMCPToolCall) {
    // For MCP tool calls, extract tool name from header
    var headerContent = container.querySelector('.composer-tool-call-header-content');
    if (headerContent) {
      var toolName = (headerContent.textContent || '').trim();
      // Return a safe identifier (MCP tools are not dangerous terminal commands)
      return toolName || 'mcp-tool-call';
    }
    // If we can't extract tool name, still allow (MCP tools are safe)
    return 'mcp-tool-call';
  }

  // Try new format: Monaco editor in .composer-terminal-command-editor
  var commandEditor = container.querySelector('.composer-terminal-command-editor, .simple-code-render');
  if (commandEditor) {
    // Monaco editor stores text in view-lines
    var viewLines = commandEditor.querySelectorAll('.view-line');
    if (viewLines.length > 0) {
      var lines = [];
      for (var i = 0; i < viewLines.length; i++) {
        // Get textContent from view-line (handles all nested spans)
        var lineText = (viewLines[i].textContent || '').trim();
        if (lineText) lines.push(lineText);
      }
      if (lines.length > 0) {
        // Join lines with space (Monaco editor may split long commands across lines)
        var fullCmd = lines.join(' ').trim();
        // Remove $ prefix if present (terminal prompt)
        fullCmd = fullCmd.replace(/^\$\s*/, '').trim();
        // Remove PowerShell command prefix if present (cd "path"; npm run ...)
        var prefixMatch = fullCmd.match(/^cd\s+"[^"]+"\s*[;&]\s*(.+)$/i);
        if (prefixMatch) return prefixMatch[1].trim();
        return fullCmd;
      }
    }
    // Fallback 1: Try to get text from view-lines container directly
    var viewLinesContainer = commandEditor.querySelector('.view-lines, .lines-content');
    if (viewLinesContainer) {
      var viewLinesText = (viewLinesContainer.textContent || '').trim();
      if (viewLinesText) {
        viewLinesText = viewLinesText.replace(/^\$\s*/, '').trim();
        var prefixMatch = viewLinesText.match(/^cd\s+"[^"]+"\s*[;&]\s*(.+)$/i);
        if (prefixMatch) return prefixMatch[1].trim();
        return viewLinesText;
      }
    }
    // Fallback 2: get textContent from editor (handles all nested elements)
    var editorText = (commandEditor.textContent || '').trim();
    if (editorText) {
      // Remove $ prefix if present
      editorText = editorText.replace(/^\$\s*/, '').trim();
      // Remove command prefix if present
      var prefixMatch = editorText.match(/^cd\s+"[^"]+"\s*[;&]\s*(.+)$/i);
      if (prefixMatch) return prefixMatch[1].trim();
      return editorText;
    }
  }
  
  // Fallback: Try to find command editor in a wider search (including wrapper)
  if (!commandEditor) {
    var widerSearch = container;
    for (var ws = 0; ws < 10 && widerSearch; ws++) {
      commandEditor = widerSearch.querySelector('.composer-terminal-command-editor, .simple-code-render, .composer-terminal-command-wrapper');
      if (commandEditor) {
        // Try to get text from Monaco editor first
        var monacoLines = commandEditor.querySelectorAll('.view-line');
        if (monacoLines.length > 0) {
          var monacoText = [];
          for (var ml = 0; ml < monacoLines.length; ml++) {
            var mlText = (monacoLines[ml].textContent || '').trim();
            if (mlText) monacoText.push(mlText);
          }
          if (monacoText.length > 0) {
            var fullCmd = monacoText.join(' ').trim().replace(/^\$\s*/, '').trim();
            var prefixMatch = fullCmd.match(/^cd\s+"[^"]+"\s*[;&]\s*(.+)$/i);
            if (prefixMatch) return prefixMatch[1].trim();
            return fullCmd;
          }
        }
        // Fallback: get textContent from editor
        var cmdText = (commandEditor.textContent || '').trim();
        if (cmdText) {
          cmdText = cmdText.replace(/^\$\s*/, '').trim();
          var prefixMatch = cmdText.match(/^cd\s+"[^"]+"\s*[;&]\s*(.+)$/i);
          if (prefixMatch) return prefixMatch[1].trim();
          return cmdText;
        }
        break;
      }
      widerSearch = widerSearch.parentElement;
      if (!widerSearch) break;
    }
  }

  // Try old format: <pre> element
  var pre = container.querySelector('pre');
  if (pre) {
    var fullText = pre.textContent || '';
    var separatorIdx = fullText.indexOf(' > ');
    return separatorIdx !== -1 ? fullText.substring(separatorIdx + 3).trim() : fullText.trim();
  }

  // Last-resort heuristic: scan for code-like text that looks like a shell command.
  // This is to handle new Cursor UIs where the command is rendered without the
  // old pre/simple-code-render structure.
  try {
    var bestCandidate = '';
    var codeLikeNodes = container.querySelectorAll('code, pre, span, div, p');
    for (var ci = 0; ci < codeLikeNodes.length; ci++) {
      var nodeText = (codeLikeNodes[ci].textContent || '').trim();
      if (!nodeText) continue;
      // Skip very short or very long texts (likely not a single command line)
      if (nodeText.length < 4 || nodeText.length > 300) continue;
      // Heuristic: must look like a shell command
      if (
        nodeText.indexOf('npm ') === -1 &&
        nodeText.indexOf('pnpm ') === -1 &&
        nodeText.indexOf('yarn ') === -1 &&
        nodeText.indexOf('bun ') === -1 &&
        nodeText.indexOf('node ') === -1 &&
        nodeText.indexOf('python ') === -1 &&
        nodeText.indexOf('pip ') === -1 &&
        nodeText.indexOf('cd ') === -1 &&
        nodeText.indexOf('git ') === -1
      ) {
        continue;
      }
      // Prefer the longest reasonable candidate
      if (nodeText.length > bestCandidate.length) {
        bestCandidate = nodeText;
      }
    }
    if (bestCandidate) {
      // Strip leading shell prompt if present
      bestCandidate = bestCandidate.replace(/^\$\s*/, '').trim();
      // Remove PowerShell/terminal "cd ...; " prefix if present
      var prefixMatch2 = bestCandidate.match(/^cd\s+"[^"]+"\s*[;&]\s*(.+)$/i);
      if (prefixMatch2) return prefixMatch2[1].trim();
      return bestCandidate;
    }
  } catch (e) { /* ignore */ }

  return '';
}

// ── Iframe Traversal ─────────────────────────────

/**
 * Scan accessible iframes from the main workbench page.
 * The Antigravity chat panel is an iframe that IS accessible via contentDocument
 * but does NOT appear as a CDP Runtime execution context.
 * This function traverses it directly from the main page.
 * 
 * IMPORTANT: For Antigravity, we scan ALL accessible iframes, not just those with known markers,
 * because the chat panel iframe may not have the expected markers.
 */
function scanIframeDocuments() {
  var results = [];
  var blocked = 0;
  var iframes = document.querySelectorAll('iframe');
  var scannedIframes = 0;
  var accessibleIframes = 0;

  for (var fi = 0; fi < iframes.length; fi++) {
    try {
      var doc = iframes[fi].contentDocument || (iframes[fi].contentWindow && iframes[fi].contentWindow.document);
      if (!doc) {
        // Cross-origin or not accessible
        continue;
      }
      accessibleIframes++;
      
      // CRITICAL: Initialize scroll detection for this iframe window
      // This ensures user scroll detection works inside iframes (e.g., Antigravity chat panel)
      var iWin = iframes[fi].contentWindow || doc.defaultView;
        if (iWin) {
          try {
            // Try to call initializeScrollListeners from main window or current window
            var initFn = (typeof window !== 'undefined' && window.initializeScrollListeners) || 
                         (typeof initializeScrollListeners !== 'undefined' && initializeScrollListeners);
            if (initFn) {
              initFn(iWin, doc);
            } else {
              // Fallback: manually initialize state for iframe
              initializeScrollState(iWin);
            }
          } catch (e) { /* ignore initialization errors */ }
        }

      // Check if this iframe is a chat panel (has known markers)
      var isChat = !!doc.getElementById('conversation') ||
        !!doc.querySelector('.notify-user-container') ||
        !!doc.querySelector('[data-tooltip-id="cascade-header-menu"]') ||
        !!doc.querySelector('.composer-rendered-message') ||
        !!doc.querySelector('.composer-pane-controls-feedback');

      // For Antigravity: scan ALL accessible iframes, not just those with known markers
      // The chat panel iframe may not have the expected markers, but still contain buttons
      // We'll scan it anyway and filter by button text/selectors
      if (!isChat) {
        // Still scan non-chat iframes for Antigravity (they might contain buttons)
        // But prioritize chat iframes
      }

      scannedIframes++;

      // Scan for accept buttons in this iframe document
      // Use deepQuerySelectorAll to handle shadow DOM
      var found = deepQuerySelectorAll(doc, BUTTON_SELECTORS);
      
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
            var runCheck = shouldAllowRunButton(btn);
            if (!runCheck.allowed) {
              blocked++;
              continue;
            }
          }
          results.push(btn);
        }
      }
    } catch (e) {
      // Cross-origin iframe — skip silently
      // This is expected for some iframes
    }
  }

  // Return diagnostic info for debugging
  return {
    buttons: results,
    blocked: blocked,
    scannedIframes: scannedIframes,
    accessibleIframes: accessibleIframes,
    totalIframes: iframes.length
  };

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
                var sRunCheck = shouldAllowRunButton(sFound[sb]);
                if (!sRunCheck.allowed) {
                  blocked++;
                  continue;
                }
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
 * Check if user is currently scrolling (to prevent interrupting them).
 * @param {Window} win - The window to check (default: current window)
 * @returns {boolean} true if user is actively scrolling
 */
function isUserScrolling(win) {
  win = win || window;
  try {
    if (typeof win.__userScrollState !== 'undefined') {
      var state = win.__userScrollState;
      var now = Date.now();
      
      // Check if explicitly marked as scrolling
      if (state.isScrolling) {
        return true;
      }
      
      // Check if scrollbar is being dragged (most reliable indicator)
      if (state.isScrollbarDrag) {
        return true;
      }
      
      // Check if still within cooldown period after last user scroll
      var timeSinceLastScroll = now - state.lastScrollTime;
      if (timeSinceLastScroll < USER_SCROLL_COOLDOWN_MS) {
        // But exclude if this was a programmatic scroll
        var timeSinceProgrammaticScroll = now - state.lastProgrammaticScrollTime;
        if (timeSinceProgrammaticScroll < PROGRAMMATIC_SCROLL_MARKER_MS) {
          // Recent programmatic scroll - don't block
          return false;
        }
        // User scroll within cooldown - block
        return true;
      }
      
      // Check if mouse is currently down (user might be dragging)
      if (state.isMouseDown) {
        var timeSinceMouseDown = now - state.mouseDownTime;
        // If mouse has been down for more than 50ms, likely a drag
        if (timeSinceMouseDown > 50) {
          return true;
        }
      }
    }
  } catch (e) { /* ignore */ }
  return false;
}

/**
 * Detect if the chat panel has been scrolled up (user is viewing older messages).
 * For Antigravity, the main chat scroll container wraps the #conversation element
 * and has overflow-y: auto/scroll.
 *
 * When the user is scrolled significantly away from the bottom, we should NOT
 * auto-scroll or click the "Scroll to bottom" button, even if scroll events
 * are not perfectly detected by isUserScrolling().
 *
 * @param {Document} doc - The document to check in
 * @returns {boolean} true if chat is scrolled up (not near bottom)
 */
function isChatScrolledUp(doc) {
  try {
    if (!doc) return false;
    var win = doc.defaultView || window;
    var conversation = doc.getElementById('conversation');
    if (!conversation) return false;

    // Find nearest scrollable ancestor of #conversation
    var el = conversation.parentElement;
    var maxDepth = 10;
    var scrollContainer = null;

    while (el && maxDepth-- > 0) {
      try {
        var style = win.getComputedStyle(el);
        var hasScroll = style.overflowY === 'auto' || style.overflowY === 'scroll' ||
                        style.overflow === 'auto' || style.overflow === 'scroll';
        if (hasScroll && el.scrollHeight > el.clientHeight + 10) {
          scrollContainer = el;
          break;
        }
      } catch (e) { /* ignore */ }
      el = el.parentElement;
    }

    if (!scrollContainer) return false;

    var maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
    if (maxScroll <= 0) return false;

    var distanceFromBottom = maxScroll - scrollContainer.scrollTop;
    // If we're more than 80px away from the bottom, treat as "scrolled up"
    return distanceFromBottom > 80;
  } catch (e) { /* ignore */ }
  return false;
}

/**
 * Scroll the outer scrollbar container (the main chat panel scrollbar) to bottom.
 * This scrolls the container that wraps the chat content, not just the inner content.
 * For Antigravity, this is typically the main scrollable container with the chat messages.
 * @param {Document} doc - The document to search in
 * @returns {boolean} true if scrollbar was found and scrolled
 */
function scrollOuterScrollbarToBottom(doc) {
  try {
    var win = doc.defaultView || window;
    
    // Strategy 1: Find the main scrollable container by looking for elements with:
    // - overflow-y: auto/scroll
    // - Significant scroll height (> 500px)
    // - Preferably chat-related class/id
    var scrollableContainers = doc.querySelectorAll('*');
    var candidates = [];
    
    for (var i = 0; i < scrollableContainers.length; i++) {
      var el = scrollableContainers[i];
      try {
        var style = win.getComputedStyle(el);
        var hasScroll = style.overflowY === 'auto' || style.overflowY === 'scroll' ||
                        style.overflow === 'auto' || style.overflow === 'scroll';
        if (!hasScroll) continue;
        
        var scrollHeight = el.scrollHeight;
        var clientHeight = el.clientHeight;
        var hasScrollbar = scrollHeight > clientHeight;
        
        // Only consider containers with actual scrollable content
        if (hasScrollbar && scrollHeight > 500) {
          var className = (el.className || '').toString();
          var id = el.id || '';
          
          // Score containers: higher score = better candidate
          var score = 0;
          
          // Chat-related indicators (highest priority)
          if (id === 'conversation' || className.indexOf('conversation') !== -1) score += 1000;
          if (className.indexOf('chat') !== -1 || id.indexOf('chat') !== -1) score += 800;
          if (className.indexOf('overflow') !== -1 || className.indexOf('scroll') !== -1) score += 200;
          
          // Prefer containers with more scrollable content
          score += Math.min(scrollHeight / 10, 500);
          
          candidates.push({
            element: el,
            score: score,
            scrollHeight: scrollHeight,
            clientHeight: clientHeight
          });
        }
      } catch (e) { /* skip element */ }
    }
    
    // Sort by score (highest first)
    candidates.sort(function(a, b) { return b.score - a.score; });
    
    // Strategy 2: Also check document.body and document.documentElement
    if (doc.body) {
      try {
        var bodyStyle = win.getComputedStyle(doc.body);
        if (bodyStyle.overflowY === 'auto' || bodyStyle.overflowY === 'scroll' ||
            bodyStyle.overflow === 'auto' || bodyStyle.overflow === 'scroll') {
          var bodyScrollHeight = doc.body.scrollHeight;
          var bodyClientHeight = doc.body.clientHeight;
          if (bodyScrollHeight > bodyClientHeight) {
            candidates.push({
              element: doc.body,
              score: 300 + Math.min(bodyScrollHeight / 10, 500),
              scrollHeight: bodyScrollHeight,
              clientHeight: bodyClientHeight
            });
          }
        }
      } catch (e) { /* skip */ }
    }
    
    if (doc.documentElement) {
      try {
        var htmlStyle = win.getComputedStyle(doc.documentElement);
        if (htmlStyle.overflowY === 'auto' || htmlStyle.overflowY === 'scroll' ||
            htmlStyle.overflow === 'auto' || htmlStyle.overflow === 'scroll') {
          var htmlScrollHeight = doc.documentElement.scrollHeight;
          var htmlClientHeight = doc.documentElement.clientHeight;
          if (htmlScrollHeight > htmlClientHeight) {
            candidates.push({
              element: doc.documentElement,
              score: 200 + Math.min(htmlScrollHeight / 10, 500),
              scrollHeight: htmlScrollHeight,
              clientHeight: htmlClientHeight
            });
          }
        }
      } catch (e) { /* skip */ }
    }
    
    // Try scrolling the best candidate
    if (candidates.length > 0) {
      // Sort again to ensure best candidate is first
      candidates.sort(function(a, b) { return b.score - a.score; });
      var bestContainer = candidates[0].element;
      
      var currentScroll = bestContainer.scrollTop;
      var maxScroll = bestContainer.scrollHeight - bestContainer.clientHeight;
      
      // Only scroll if not already at bottom (within 10px threshold)
      if (maxScroll - currentScroll > 10) {
        // Mark as programmatic scroll to avoid triggering user scroll detection
        // CRITICAL: Mark BEFORE scrolling so handleScroll knows it's programmatic
        if (win && win.__userScrollState) {
          win.__userScrollState.lastProgrammaticScrollTime = Date.now();
          // Also update lastScrollTime to prevent immediate false positive
          win.__userScrollState.lastScrollTime = Date.now();
        }
        
        // Scroll to bottom
        bestContainer.scrollTop = maxScroll;
        
        // Also try scrollTo as fallback (some browsers need this)
        if (bestContainer.scrollTo) {
          bestContainer.scrollTo({
            top: maxScroll,
            behavior: 'auto'
          });
        }
        
        return true;
      }
    }
  } catch (e) { /* ignore */ }
  return false;
}

/**
 * Find and click the "Scroll to bottom" button if it's visible.
 * This ensures the chat panel is scrolled down to show latest content
 * (including new accept/run buttons) before we scan for them.
 *
 * Only targets buttons with exact aria-label="Scroll to bottom".
 * Only clicks when actually visible (opacity > 0, non-zero rect).
 * Does NOT click if user is currently scrolling (to avoid interrupting them).
 *
 * @param {Document} doc - The document to search in
 * @returns {boolean} true if a scroll button was clicked
 */
function clickScrollToBottomIfVisible(doc) {
  try {
    // CRITICAL: Don't click if user is actively scrolling
    var win = doc.defaultView || window;
    if (isUserScrolling(win)) {
      return false;
    }
    
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
      // Use persisted state from window (survives across CDP evaluations)
      var state = (typeof window !== 'undefined' && window.__usageLimitState) || { count: 0, lastResend: 0 };
      
      // Safety guards: max retries + cooldown
      if (state.count >= USAGE_LIMIT_MAX_RETRIES) return { action: 'usage-limit-maxed' };
      if (now - state.lastResend < USAGE_LIMIT_COOLDOWN_MS) return { action: 'usage-limit-cooldown' };

      // Close popup
      var closeBtn = popup.querySelector('.composer-warning-popup-close-button');
      if (closeBtn) closeBtn.click();

      // CRITICAL: Focus into chat editor to show the Send button
      // The Send button only appears when the editor is focused/active
      var input = document.querySelector('.aislash-editor-input[contenteditable="true"], .aislash-editor-input-readonly[contenteditable="false"]');
      if (!input) {
        // Fallback: try to find any editor input
        input = document.querySelector('.aislash-editor-input, [class*="editor-input"], [class*="chat-input"]');
      }
      
      if (!input) return { action: 'usage-limit-no-input' };
      
      // Verify chat input has content
      if (!(input.textContent || '').trim()) return { action: 'usage-limit-empty-input' };

      // CRITICAL: Focus the editor to trigger Send button visibility
      // The Send button only appears when the editor is focused/active
      try {
        // Focus the input
        input.focus();
        // Also try clicking to ensure it's active
        input.click();
        // Make it editable if it's readonly
        if (input.getAttribute('contenteditable') === 'false') {
          input.setAttribute('contenteditable', 'true');
        }
        // Trigger focus event to ensure UI updates
        var focusEvent = new Event('focus', { bubbles: true });
        input.dispatchEvent(focusEvent);
        // Also trigger input event to ensure React/UI framework updates
        var inputEvent = new Event('input', { bubbles: true });
        input.dispatchEvent(inputEvent);
      } catch (e) { /* ignore focus errors */ }

      // Try to find Send button with multiple selectors
      // The button appears after editor is focused
      var sendBtn = null;
      
      // Try multiple selectors for Send button
      sendBtn = document.querySelector('.send-with-mode .anysphere-icon-button, .anysphere-icon-button[data-mode="agent"], .send-with-mode button');
      
      if (!sendBtn) {
        // Also try finding by icon class (arrow-up icon)
        var allIconButtons = document.querySelectorAll('.anysphere-icon-button, button[class*="anysphere"]');
        for (var i = 0; i < allIconButtons.length; i++) {
          var btn = allIconButtons[i];
          var icon = btn.querySelector('.codicon-arrow-up-two, .codicon-arrow-up');
          // Also check if button contains the icon as direct child
          var btnText = (btn.textContent || '').trim();
          var btnClasses = (btn.className || '').toString();
          if (icon || btnClasses.indexOf('arrow-up') !== -1) {
            sendBtn = btn;
            break;
          }
        }
      }
      
      // If still not found, try finding by parent container
      if (!sendBtn) {
        var sendContainer = document.querySelector('.send-with-mode');
        if (sendContainer) {
          sendBtn = sendContainer.querySelector('button, .anysphere-icon-button, [role="button"]');
        }
      }
      
      if (sendBtn && isElementClickable(sendBtn)) {
        sendBtn.click();
        // Update persisted state
        state.count++;
        state.lastResend = now;
        if (typeof window !== 'undefined') {
          window.__usageLimitState = state;
        }
        return { action: 'usage-limit-resent', retryCount: state.count };
      }
      
      // If Send button not found, return action to retry on next scan
      // The editor is now focused, so button should appear on next poll
      return { action: 'usage-limit-focused-waiting-send', retryCount: state.count };
    }
  }

  // ── Dialog C: Web search confirmation dialog ──
  // This dialog appears when Cursor wants to search the web for information
  // It has "Confirm search" text and "Continue"/"Cancel" buttons
  var webSearchDialog = document.querySelector('.composer-tool-former-message');
  if (webSearchDialog) {
    // Check if this is a web search confirmation dialog
    // Look for "Confirm search" text or web search indicators
    var dialogText = (webSearchDialog.textContent || '').toLowerCase();
    var hasConfirmSearch = dialogText.indexOf('confirm search') !== -1 || 
                          dialogText.indexOf('search the web') !== -1 ||
                          dialogText.indexOf('web search') !== -1;
    
    // Also check for "Auto-search web" checkbox which is a strong indicator
    var hasAutoSearchCheckbox = !!webSearchDialog.querySelector('[role="checkbox"]') &&
                                (webSearchDialog.textContent || '').indexOf('Auto-search web') !== -1;
    
    if (hasConfirmSearch || hasAutoSearchCheckbox) {
      // Find the "Continue" button - it has class "anysphere-button" (primary button)
      // NOT "anysphere-text-button" which is the Cancel button
      var continueBtn = null;
      
      // Strategy 1: Find by class and text content
      var allButtons = webSearchDialog.querySelectorAll('.anysphere-button, [data-click-ready="true"]');
      for (var i = 0; i < allButtons.length; i++) {
        var btn = allButtons[i];
        var btnText = getButtonText(btn);
        // Continue button has class "anysphere-button" and text "continue"
        if (btnText === 'continue' && btn.classList.contains('anysphere-button')) {
          continueBtn = btn;
          break;
        }
      }
      
      // Strategy 2: If not found, try finding by position (Continue is usually the last button)
      if (!continueBtn) {
        var buttons = webSearchDialog.querySelectorAll('.anysphere-button, .anysphere-text-button, [data-click-ready="true"]');
        // Continue button is typically the last button (rightmost)
        // Cancel button has class "anysphere-text-button", Continue has "anysphere-button"
        for (var j = buttons.length - 1; j >= 0; j--) {
          var btn2 = buttons[j];
          var btnText2 = getButtonText(btn2);
          if (btnText2 === 'continue' || (btnText2 !== 'cancel' && btn2.classList.contains('anysphere-button'))) {
            continueBtn = btn2;
            break;
          }
        }
      }
      
      // Strategy 3: Find by excluding Cancel button
      if (!continueBtn) {
        var cancelBtn = null;
        var allBtns = webSearchDialog.querySelectorAll('.anysphere-button, .anysphere-text-button, [data-click-ready="true"]');
        for (var k = 0; k < allBtns.length; k++) {
          var btn3 = allBtns[k];
          var btnText3 = getButtonText(btn3);
          if (btnText3 === 'cancel') {
            cancelBtn = btn3;
          } else if (btnText3 === 'continue' || btn3.classList.contains('anysphere-button')) {
            continueBtn = btn3;
          }
        }
        // If we found Cancel but not Continue, the other button must be Continue
        if (!continueBtn && cancelBtn && allBtns.length === 2) {
          for (var m = 0; m < allBtns.length; m++) {
            if (allBtns[m] !== cancelBtn) {
              continueBtn = allBtns[m];
              break;
            }
          }
        }
      }
      
      if (continueBtn && isElementClickable(continueBtn)) {
        continueBtn.click();
        return { action: 'dialog-continue', dialogType: 'web-search' };
      }
    }
  }

  return null; // No dialog detected
}

// ── Main Execution ───────────────────────────────

/**
 * Detect "Running command" cards that may remain visible in UI while terminal
 * shell events are missing or already ended. This is diagnostic-only here;
 * recovery is handled by extension-side watchdog logic.
 */
function detectRunningCommandCards(doc) {
  var info = { detected: false, count: 0 };
  if (!doc) return info;

  try {
    var nodes = doc.querySelectorAll('div, span');
    var limit = Math.min(nodes.length, 600);
    for (var i = 0; i < limit; i++) {
      var n = nodes[i];
      var t = (n.textContent || '').trim().toLowerCase();
      if (t !== 'running command') continue;

      // Find a nearby container that also has a "Cancel" button/text.
      var anc = n;
      var hasCancel = false;
      for (var d = 0; d < 8 && anc; d++) {
        try {
          var btns = anc.querySelectorAll('button, [role="button"], span, div');
          var bLimit = Math.min(btns.length, 80);
          for (var b = 0; b < bLimit; b++) {
            var bt = (btns[b].textContent || '').trim().toLowerCase();
            if (bt === 'cancel') {
              hasCancel = true;
              break;
            }
          }
        } catch (e) { /* ignore */ }
        if (hasCancel) break;
        anc = anc.parentElement;
      }

      if (hasCancel) {
        info.detected = true;
        info.count += 1;
      }
    }
  } catch (e) { /* ignore */ }

  return info;
}

function findAndClickAcceptButtons() {
  var runtimeConfig = getRuntimeConfig();
  // Global runtime gate — allow extension to disable payload without removing it.
  if (!runtimeConfig.enabled) {
    return {
      clicked: [],
      blocked: 0,
      scanMode: 'disabled',
      scrollClicked: false,
    };
  }

  var clickedButtons = [];
  var blockedCount = 0;
  var scanMode = 'none';
  var scrolledInMainChat = false;
  var checkedElements = new Set(); // Shared across all branches to avoid duplicate clicks
  var runningCommandInfo = detectRunningCommandCards(typeof document !== 'undefined' ? document : null);

  // ── Branch 0.5: Antigravity chat panel in MAIN document (no iframe) ──
  // New Antigravity versions render the agent chat panel directly in the main
  // workbench document under a container with id="conversation".
  // In this case, we still want the same behavior as the iframe chat:
  //   - auto-scroll to bottom when user is NOT scrolling and chat is near bottom
  //   - click the floating "Scroll to bottom" button when appropriate
  try {
    if (typeof document !== 'undefined' && typeof window !== 'undefined') {
      var mainConversation = document.getElementById('conversation');
      if (mainConversation && window === window.top) {
        scanMode = 'chat-main-document';
        var mainUserScrolling = isUserScrolling(window);
        var mainChatScrolledUp = isChatScrolledUp(document);
        var mainScrolled = false;

        if (!mainUserScrolling && !mainChatScrolledUp) {
          // First, try to scroll the outer scrollbar (main chat container)
          mainScrolled = scrollOuterScrollbarToBottom(document);

          // Then try clicking the "Scroll to bottom" button if available
          if (!mainScrolled) {
            mainScrolled = clickScrollToBottomIfVisible(document);
          }
        }

        // For main-document chat, also auto-click chat-panel buttons just like
        // the iframe chat branch, but ONLY when user is not actively scrolling
        // and the chat is not scrolled up.
        if (!mainUserScrolling && !mainChatScrolledUp) {
          var mainChatButtons = findChatPanelButtons();
          for (var mcb = 0; mcb < mainChatButtons.length; mcb++) {
            var mBtn = mainChatButtons[mcb];
            var mText = getButtonText(mBtn);
            if (!mText) continue;
            // Respect runtime config for Proceed auto-clicks
            if (mText === 'proceed' && !runtimeConfig.clickProceed) continue;
            // Mark as checked so later branches (editor-diff, iframe, etc.)
            // do NOT click the same Proceed/Accept button again.
            checkedElements.add(mBtn);
            // Throttle Proceed so it is not double-clicked across polling cycles
            if (mText === 'proceed' && shouldSkipProceedClick()) continue;
            try {
              mBtn.click();
              clickedButtons.push(mText);
            } catch (e) { /* ignore */ }
          }
        }

        // If we scrolled, remember it; do NOT return early so other branches still run.
        scrolledInMainChat = mainScrolled;
      }
    }
  } catch (e) { /* ignore */ }

  // ── Phase 0: Handle Cursor-specific dialogs (BEFORE generic scan) ──
  var dialogResult = handleCursorDialogs();
  if (dialogResult) {
    var dialogClicked = (dialogResult.action.indexOf('resent') !== -1 || dialogResult.action.indexOf('continue') !== -1)
      ? [dialogResult.action] : [];
    
    // If we're waiting for Send button to appear (after focusing editor), try to find and click it
    if (dialogResult.action === 'usage-limit-focused-waiting-send') {
      // Editor is already focused, now try to find Send button
      var sendBtn = null;
      sendBtn = document.querySelector('.send-with-mode .anysphere-icon-button, .anysphere-icon-button[data-mode="agent"], .send-with-mode button');
      
      if (!sendBtn) {
        // Also try finding by icon class (arrow-up icon)
        var allIconButtons = document.querySelectorAll('.anysphere-icon-button, button[class*="anysphere"]');
        for (var i = 0; i < allIconButtons.length; i++) {
          var btn = allIconButtons[i];
          var icon = btn.querySelector('.codicon-arrow-up-two, .codicon-arrow-up');
          var btnClasses = (btn.className || '').toString();
          if (icon || btnClasses.indexOf('arrow-up') !== -1) {
            sendBtn = btn;
            break;
          }
        }
      }
      
      if (!sendBtn) {
        var sendContainer = document.querySelector('.send-with-mode');
        if (sendContainer) {
          sendBtn = sendContainer.querySelector('button, .anysphere-icon-button, [role="button"]');
        }
      }
      
      if (sendBtn && isElementClickable(sendBtn)) {
        sendBtn.click();
        // Update persisted state
        var state = (typeof window !== 'undefined' && window.__usageLimitState) || { count: 0, lastResend: 0 };
        state.count++;
        state.lastResend = Date.now();
        if (typeof window !== 'undefined') {
          window.__usageLimitState = state;
        }
        return {
          clicked: ['usage-limit-resent'],
          scanMode: 'cursor-dialog-send',
          scrollClicked: false,
          dialogAction: { action: 'usage-limit-resent', retryCount: state.count },
        };
      }
      // Still waiting - return without clicking
      return {
        clicked: [],
        scanMode: 'cursor-dialog-waiting',
        scrollClicked: false,
        dialogAction: dialogResult,
      };
    }
    
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

    // CRITICAL: Only scroll/click if user is NOT actively scrolling
    // This prevents interrupting users who are reading previous messages
    var userIsScrolling = isUserScrolling();
    var chatScrolledUp = isChatScrolledUp(document);
    var scrolled = false;
    
    if (!userIsScrolling && !chatScrolledUp) {
      // First, try to scroll the outer scrollbar (main chat container)
      scrolled = scrollOuterScrollbarToBottom(document);
      
      // Then try clicking the "Scroll to bottom" button if available
      if (!scrolled) {
        scrolled = clickScrollToBottomIfVisible(document);
      }
    }

    // Only click buttons if user is not scrolling
    if (!userIsScrolling && !chatScrolledUp) {
      var buttons = findChatPanelButtons();

      for (var i = 0; i < buttons.length; i++) {
        var cBtn = buttons[i];
        var cText = getButtonText(cBtn);
        if (!cText) continue;
        // Respect runtime config for Proceed auto-clicks
        if (cText === 'proceed' && !runtimeConfig.clickProceed) continue;
        // Throttle Proceed so it is not double-clicked across polling cycles
        if (cText === 'proceed' && shouldSkipProceedClick()) continue;
        try {
          cBtn.click();
          clickedButtons.push(cText);
        } catch (e) { /* ignore */ }
      }
    }

    return { clicked: clickedButtons, scanMode: scanMode, scrollClicked: scrolled };
  }

  // Branch 2: We're on the main workbench — scan editor diff containers
  // IMPORTANT: This branch runs regardless of IDE type to find buttons in editor diff views
  var containers = findEditorDiffContainers();
  if (containers.length > 0) {
    scanMode = 'editor-diff';

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
          // Respect runtime config for Proceed / Run / Accept All auto-clicks
          if (text === 'proceed' && !runtimeConfig.clickProceed) continue;
          if (text === 'run' && !runtimeConfig.clickRun) continue;
          if (text === 'accept all' && !runtimeConfig.clickAcceptAll) continue;
          // Throttle Proceed so it is not double-clicked across polling cycles
          if (text === 'proceed' && shouldSkipProceedClick()) continue;
          // Safety gate: check dangerous commands for "run" buttons
          if (text === 'run') {
            var runCheck = shouldAllowRunButton(btn);
            if (!runCheck.allowed) {
              blockedCount++;
              continue;
            }
          }
          try {
            btn.click();
            clickedButtons.push(text);
          } catch (e) { /* ignore */ }
        }
      }
    }
  }

  // Branch 3: Traverse accessible iframes from the main workbench (MOVED UP for priority)
  // The chat panel iframe is same-origin and accessible via contentDocument,
  // but does NOT appear as a CDP Runtime execution context.
  // This is the PRIMARY path for finding Accept buttons on Antigravity.
  // IMPORTANT: Run this branch BEFORE Cursor-specific branches to ensure
  // Antigravity iframe buttons are found first. Antigravity buttons are ALWAYS in iframes.
  var scrolledInIframe = false;
  var iframeResult = scanIframeDocuments();
  var iframeButtons = iframeResult.buttons;
  blockedCount += iframeResult.blocked;
      if (iframeButtons.length > 0) {
    scanMode = scanMode === 'none' ? 'iframe-traverse' : scanMode + '+iframe';
    for (var ib = 0; ib < iframeButtons.length; ib++) {
      try {
        iframeButtons[ib].click();
        clickedButtons.push(getButtonText(iframeButtons[ib]));
      } catch (e) { /* ignore */ }
    }
  }

  // Also scroll-to-bottom in chat iframes from the main workbench
  // This helps ensure latest content is visible for button detection
  // CRITICAL: Only scroll if user is NOT actively scrolling
  try {
    var iframes = document.querySelectorAll('iframe');
    for (var si = 0; si < iframes.length; si++) {
      try {
        var iDoc = iframes[si].contentDocument || (iframes[si].contentWindow && iframes[si].contentWindow.document);
        if (!iDoc) continue;
        var iIsChat = !!iDoc.getElementById('conversation') || !!iDoc.querySelector('.notify-user-container');
        if (!iIsChat) continue;

        // CRITICAL: Initialize scroll detection for this iframe window
        // This ensures user scroll detection works inside iframes
        var iWin = iDoc.defaultView || (iframes[si].contentWindow);
        if (iWin) {
          try {
            // Try to call initializeScrollListeners from main window or current window
            var initFn = (typeof window !== 'undefined' && window.initializeScrollListeners) || 
                         (typeof initializeScrollListeners !== 'undefined' && initializeScrollListeners);
            if (initFn) {
              initFn(iWin, iDoc);
            } else {
              // Fallback: manually initialize state for iframe
              initializeScrollState(iWin);
            }
          } catch (e) { /* ignore initialization errors */ }
        }
        
        // Check if user is scrolling in this iframe's window
        var userIsScrollingInIframe = isUserScrolling(iWin);
        var chatScrolledUpInIframe = isChatScrolledUp(iDoc);
        
        if (!userIsScrollingInIframe && !chatScrolledUpInIframe) {
          // First try scrolling outer scrollbar
          if (scrollOuterScrollbarToBottom(iDoc)) {
            scrolledInIframe = true;
          } else if (clickScrollToBottomIfVisible(iDoc)) {
            scrolledInIframe = true;
          }
        }
      } catch (e) { /* cross-origin */ }
    }
  } catch (e) { /* ignore */ }

  // Branch 4: Antigravity "Run command?" cards on main workbench (no iframe)
  // New Antigravity versions render the agent panel directly in the main workbench
  // (no separate iframe). The terminal Run confirmation card has a header
  // "Run command?" and a primary "Run" button with shortcut text (e.g. "Alt+⏎").
  //
  // We detect these cards by:
  //   - Finding buttons with text exactly "run"
  //   - Ensuring they live inside a container whose text includes "run command?"
  //   - Applying the same dangerous-command safety gate as Cursor
  //
  // This branch is IDE-agnostic but highly specific to the "Run command?" layout,
  // so it should be safe for other IDEs.
  try {
    var allButtonsForRunCards = deepQuerySelectorAll(document, BUTTON_SELECTORS);
    for (var rcb = 0; rcb < allButtonsForRunCards.length; rcb++) {
      var rcBtn = allButtonsForRunCards[rcb];
      if (checkedElements.has(rcBtn)) continue;

      var rcText = getButtonText(rcBtn);
      if (!rcText || rcText !== 'run') continue; // Only care about real Run buttons here

      // Ensure this Run button belongs to a "Run command" confirmation card
      var rcParent = rcBtn.parentElement;
      var isRunCommandCard = false;
      for (var rd = 0; rd < 15 && rcParent; rd++) {
        try {
          var rcParentText = (rcParent.textContent || '').toLowerCase();
          // Support both old text "Run command?" and new text "Run command"
          if (
            rcParentText.indexOf('run command?') !== -1 ||
            rcParentText.indexOf('run command ?') !== -1 ||
            rcParentText.indexOf('run command') !== -1
          ) {
            isRunCommandCard = true;
            break;
          }
        } catch (e) { /* ignore text errors */ }
        rcParent = rcParent.parentElement;
      }
      if (!isRunCommandCard) continue;

      checkedElements.add(rcBtn);
      if (isInsideCodeOrProse(rcBtn)) continue;
      if (isInsideForbiddenZone(rcBtn)) continue;

      if (!isElementClickable(rcBtn)) continue;

      // Safety gate: check dangerous commands for this Run button
      var runCardCheck = shouldAllowRunButton(rcBtn);
      if (!runCardCheck.allowed) {
        blockedCount++;
        continue;
      }

      try {
        rcBtn.click();
        clickedButtons.push(rcText);
        scanMode = scanMode === 'none' ? 'run-command-card' : scanMode + '+run-card';
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }

  // Branch 5: Antigravity "Accept all" in agent changes header (no iframe)
  // The new Antigravity agent diff header shows:
  //   "Reject all" (secondary) and "Accept all" (primary) as span elements,
  //   plus a label like "1 File With Changes".
  // These are not <button> elements, so the generic BUTTON_SELECTORS miss them.
  //
  // We locate "Accept all" by:
  //   - Scanning span elements for text exactly "accept all"
  //   - Requiring an ancestor that contains "file with changes"
  // This is highly specific to the Antigravity agent header and should be safe.
  try {
    var spanCandidates = document.querySelectorAll('span');
    for (var asIdx = 0; asIdx < spanCandidates.length; asIdx++) {
      var spanEl = spanCandidates[asIdx];
      if (checkedElements.has(spanEl)) continue;

      var spanTextRaw = (spanEl.textContent || '').trim();
      if (!spanTextRaw) continue;
      var spanText = spanTextRaw.toLowerCase();
      if (spanText !== 'accept all') continue;

      // Heuristic 1: ensure we're inside the Antigravity agent side panel
      // (this is where the changes header + Accept all/Reject all live).
      var anc = spanEl.parentElement;
      var inAgentPanel = false;
      for (var ad = 0; ad < 20 && anc; ad++) {
        try {
          var ancCls = (anc.className || '').toString().toLowerCase();
          if (ancCls.indexOf('antigravity-agent-side-panel') !== -1) {
            inAgentPanel = true;
            break;
          }
        } catch (e) { /* ignore text errors */ }
        anc = anc.parentElement;
      }
      if (!inAgentPanel) continue;

      // Heuristic 2: require a sibling "Reject all" in the same control row.
      // This matches the Antigravity header layout and avoids relying on
      // "1 File With Changes" vs "2 Files With Changes" text.
      var parentRow = spanEl.parentElement;
      var hasRejectSibling = false;
      if (parentRow) {
        try {
          var sibSpans = parentRow.querySelectorAll('span');
          for (var ss = 0; ss < sibSpans.length; ss++) {
            if (sibSpans[ss] === spanEl) continue;
            var sibText = (sibSpans[ss].textContent || '').trim().toLowerCase();
            if (sibText === 'reject all') {
              hasRejectSibling = true;
              break;
            }
          }
        } catch (e) { /* ignore sibling errors */ }
      }
      if (!hasRejectSibling) continue;

      checkedElements.add(spanEl);
      if (isInsideCodeOrProse(spanEl)) continue;
      if (isInsideForbiddenZone(spanEl)) continue;
      if (!isElementClickable(spanEl)) continue;

      // "Accept all" here applies AI changes; treat it as an accept button.
      try {
        spanEl.click();
        clickedButtons.push('accept all');
        scanMode = scanMode === 'none' ? 'agent-accept-all' : scanMode + '+agent-accept-all';
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }

  // Branch 2.5: Cursor-specific — scan for composer headers (after iframe scan)
  // Composer headers contain Keep All/Accept buttons and may be anywhere in the document
  // (not necessarily in editor part — Cursor may render composer in auxiliarybar or elsewhere)
  // ONLY run for Cursor IDE to avoid interfering with Antigravity
  // NOTE: This branch runs regardless of clickedButtons.length to catch Keep All buttons
  var composerHeaders = [];
  if (isCursorIDE()) {
    composerHeaders = Array.from(document.querySelectorAll('#composer-files-edited-header, .composer-files-edited-header'));
  }
  for (var ch = 0; ch < composerHeaders.length; ch++) {
    var headerBtns = deepQuerySelectorAll(composerHeaders[ch], BUTTON_SELECTORS);
    for (var hb = 0; hb < headerBtns.length; hb++) {
      var hBtn = headerBtns[hb];
      if (checkedElements.has(hBtn)) continue;
      checkedElements.add(hBtn);
      if (isInsideCodeOrProse(hBtn)) continue;
      // NOTE: isInsideForbiddenZone allows composer area even if inside auxiliarybar
      if (isInsideForbiddenZone(hBtn)) continue;
      var hText = getButtonText(hBtn);
      if (!hText) continue;
      if (isAcceptButton(hText) && isElementClickable(hBtn)) {
        try {
          hBtn.click();
          clickedButtons.push(hText);
          scanMode = scanMode === 'none' ? 'composer-header' : scanMode + '+composer';
        } catch (e) { /* ignore */ }
      }
    }
  }

  // Branch 2.6: Scan workbench editor area for Anysphere buttons (Cursor-specific)
  // These buttons (Keep All, Accept, etc.) live OUTSIDE standard diff containers
  // but inside the editor part. They have distinctive Anysphere CSS classes.
  // NOTE: We scan even if clickedButtons.length > 0 to catch Run buttons in tool calls
  // ONLY run for Cursor IDE to avoid interfering with Antigravity
  var editorPart = null;
  if (isCursorIDE()) {
    editorPart = document.getElementById('workbench.parts.editor');
  }
  if (editorPart) {
    var anysphereSelectors = [
      '.anysphere-text-button',
      '.anysphere-secondary-button',
      '.anysphere-focus-outline-button',
      '.anysphere-button', // Run button
      '[data-click-ready="true"]',
    ].join(', ');
    var ansBtns = deepQuerySelectorAll(editorPart, anysphereSelectors);
    for (var ab = 0; ab < ansBtns.length; ab++) {
      var aBtn = ansBtns[ab];
      if (checkedElements.has(aBtn)) continue;
      checkedElements.add(aBtn);
      if (isInsideCodeOrProse(aBtn)) continue;
      if (isInsideForbiddenZone(aBtn)) continue;
      var aText = getButtonText(aBtn);
      if (!aText) continue;
      if (isAcceptButton(aText) && isElementClickable(aBtn)) {
        // Throttle Proceed so it is not double-clicked across polling cycles
        if (aText === 'proceed' && shouldSkipProceedClick()) continue;
        // Safety gate: check dangerous commands for "run" buttons
        if (aText === 'run') {
          var runCheck = shouldAllowRunButton(aBtn);
          if (!runCheck.allowed) {
            blockedCount++;
            continue;
          }
        }
        try {
          aBtn.click();
          clickedButtons.push(aText);
          scanMode = scanMode === 'none' ? 'anysphere-direct' : scanMode + '+anysphere';
        } catch (e) { /* ignore */ }
      }
    }
  }

  // Branch 2.7: Cursor-specific — scan ENTIRE document for composer-related buttons
  // Composer may be rendered outside editor part (e.g., in auxiliarybar, webview, etc.)
  // Scan for composer-pane-controls-feedback and anysphere buttons anywhere in document
  // ONLY run for Cursor IDE to avoid interfering with Antigravity
  // IMPORTANT: Also scan for composer-tool-call-control-row (where Run buttons live)
  // Run this branch even if clickedButtons.length > 0 to catch Run buttons after Keep All
  if (isCursorIDE()) {
    var composerPanes = document.querySelectorAll('.composer-pane-controls-feedback');
    for (var cp = 0; cp < composerPanes.length; cp++) {
      var paneBtns = deepQuerySelectorAll(composerPanes[cp], BUTTON_SELECTORS);
      for (var pb = 0; pb < paneBtns.length; pb++) {
        var pBtn = paneBtns[pb];
        if (checkedElements.has(pBtn)) continue;
        checkedElements.add(pBtn);
        if (isInsideCodeOrProse(pBtn)) continue;
        // isInsideForbiddenZone allows composer area
        if (isInsideForbiddenZone(pBtn)) continue;
        var pText = getButtonText(pBtn);
        if (!pText) continue;
        if (isAcceptButton(pText) && isElementClickable(pBtn)) {
          // Throttle Proceed so it is not double-clicked across polling cycles
          if (pText === 'proceed' && shouldSkipProceedClick()) continue;
          // Safety gate: check dangerous commands for "run" buttons
          if (pText === 'run') {
            var runCheck = shouldAllowRunButton(pBtn);
            if (!runCheck.allowed) {
              blockedCount++;
              continue;
            }
          }
          try {
            pBtn.click();
            clickedButtons.push(pText);
            scanMode = scanMode === 'none' ? 'composer-pane-full' : scanMode + '+composer-pane';
          } catch (e) { /* ignore */ }
        }
      }
    }
    // Also scan for anysphere buttons anywhere in document (fallback)
    var allAnysphereBtns = deepQuerySelectorAll(document, '.anysphere-text-button, .anysphere-button, [data-click-ready="true"]');
    for (var aab = 0; aab < allAnysphereBtns.length; aab++) {
      var aaBtn = allAnysphereBtns[aab];
      if (checkedElements.has(aaBtn)) continue;
      // Skip if already in a container we scanned
      var parent = aaBtn.parentElement;
      var skip = false;
      for (var c = 0; c < containers.length; c++) {
        if (containers[c].contains(aaBtn)) {
          skip = true;
          break;
        }
      }
      if (skip) continue;
      checkedElements.add(aaBtn);
      if (isInsideCodeOrProse(aaBtn)) continue;
      if (isInsideForbiddenZone(aaBtn)) continue;
      var aaText = getButtonText(aaBtn);
      if (!aaText) continue;
      if (isAcceptButton(aaText) && isElementClickable(aaBtn)) {
        // Throttle Proceed so it is not double-clicked across polling cycles
        if (aaText === 'proceed' && shouldSkipProceedClick()) continue;
        // Safety gate: check dangerous commands for "run" buttons
        if (aaText === 'run') {
          var runCheck = shouldAllowRunButton(aaBtn);
          if (!runCheck.allowed) {
            blockedCount++;
            continue;
          }
        }
        try {
          aaBtn.click();
          clickedButtons.push(aaText);
          scanMode = scanMode === 'none' ? 'anysphere-full-doc' : scanMode + '+anysphere-full';
        } catch (e) { /* ignore */ }
      }
    }
    
    // CRITICAL FIX: Also scan for ALL buttons with text "run" in full document
    // This catches Run buttons that don't have anysphere classes (new Cursor UI)
    // Only do this for Cursor IDE to avoid interfering with Antigravity
    if (isCursorIDE()) {
      var allRunBtns = deepQuerySelectorAll(document, BUTTON_SELECTORS);
      for (var rb = 0; rb < allRunBtns.length; rb++) {
        var runBtn = allRunBtns[rb];
        if (checkedElements.has(runBtn)) continue;
        // Skip if already in a container we scanned
        var runParent = runBtn.parentElement;
        var runSkip = false;
        for (var rc = 0; rc < containers.length; rc++) {
          if (containers[rc].contains(runBtn)) {
            runSkip = true;
            break;
          }
        }
        if (runSkip) continue;
        checkedElements.add(runBtn);
        if (isInsideCodeOrProse(runBtn)) continue;
        if (isInsideForbiddenZone(runBtn)) continue;
        var runText = getButtonText(runBtn);
        if (!runText || runText !== 'run') continue; // Only process "run" buttons
        if (isElementClickable(runBtn)) {
          // Safety gate: check dangerous commands for "run" buttons
          var runCheck = shouldAllowRunButton(runBtn);
          if (!runCheck.allowed) {
            blockedCount++;
            continue;
          }
          try {
            runBtn.click();
            clickedButtons.push(runText);
            scanMode = scanMode === 'none' ? 'run-button-full-doc' : scanMode + '+run-full';
          } catch (e) { /* ignore */ }
        }
      }
    }
  }

  // Include iframe diagnostics in return value for debugging
  var result = {
    clicked: clickedButtons,
    blocked: blockedCount,
    scanMode: scanMode,
    scrollClicked: scrolledInIframe || scrolledInMainChat,
    uiRunningCommand: runningCommandInfo.detected,
    uiRunningCommandCount: runningCommandInfo.count
  };
  
  // Add iframe diagnostics if available
  if (typeof iframeResult !== 'undefined' && iframeResult.totalIframes !== undefined) {
    result.iframeDiagnostics = {
      totalIframes: iframeResult.totalIframes,
      accessibleIframes: iframeResult.accessibleIframes || 0,
      scannedIframes: iframeResult.scannedIframes || 0,
      buttonsFound: (iframeResult.buttons || []).length
    };
  }
  
  return result;
}

// Execute with safety wrapper
try {
  var result = findAndClickAcceptButtons();
  return JSON.stringify({
    clicks: result.clicked.length,
    blocked: result.blocked || 0,
    total: result.clicked.length + (result.blocked || 0),
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
