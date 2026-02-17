/**
 * Probe Payload — Diagnostic version
 *
 * Returns comprehensive DOM information to debug buttons:0 issue.
 * Checks: total elements, body existence, shadow roots, iframes,
 * and dumps the first few elements to understand page structure.
 */
"use strict";

// Deep querySelectorAll — pierces open Shadow DOM boundaries
function deepQuerySelectorAll(root, selector) {
  var results = [];
  if (!root) return results;

  try {
    var found = root.querySelectorAll(selector);
    for (var i = 0; i < found.length; i++) results.push(found[i]);
  } catch (e) {
    /* ignore */
  }

  try {
    var allElements = root.querySelectorAll("*");
    for (var i = 0; i < allElements.length; i++) {
      var el = allElements[i];
      if (el.shadowRoot) {
        var shadowResults = deepQuerySelectorAll(el.shadowRoot, selector);
        for (var j = 0; j < shadowResults.length; j++)
          results.push(shadowResults[j]);
      }
    }
  } catch (e) {
    /* ignore */
  }

  return results;
}

// Recursively find all accessible documents (main + nested iframes)
function getDocuments(root) {
  if (!root) root = document;
  var docs = [root];
  try {
    var iframes = root.querySelectorAll("iframe, frame, webview");
    for (var i = 0; i < iframes.length; i++) {
      try {
        var iDoc =
          iframes[i].contentDocument ||
          (iframes[i].contentWindow && iframes[i].contentWindow.document);
        if (iDoc) {
          var nested = getDocuments(iDoc);
          for (var j = 0; j < nested.length; j++) docs.push(nested[j]);
        }
      } catch (e) {
        /* cross-origin */
      }
    }
  } catch (e) {
    /* ignore */
  }
  return docs;
}

var docs = getDocuments();
var totalButtons = 0;
var totalEditables = 0;
var totalShadowRoots = 0;
var totalElements = 0;

var selectors =
  'button, [role="button"], a[class*="button"], .bg-ide-button-background, span[class*="bg-ide-button"], span[class*="cursor-pointer"], [class*="anysphere"], .action-label, .monaco-button';

for (var i = 0; i < docs.length; i++) {
  try {
    totalButtons += deepQuerySelectorAll(docs[i], selectors).length;
    totalEditables += deepQuerySelectorAll(
      docs[i],
      '[contenteditable="true"]',
    ).length;
    var allEls = docs[i].querySelectorAll("*");
    totalElements += allEls.length;
    for (var j = 0; j < allEls.length; j++) {
      if (allEls[j].shadowRoot) totalShadowRoots++;
    }
  } catch (e) {
    /* skip */
  }
}

// Diagnostic info — understanding workbench DOM structure
var diag = {
  bodyExists: !!document.body,
  bodyChildCount: document.body ? document.body.children.length : -1,
  htmlLength: document.documentElement
    ? document.documentElement.outerHTML.length
    : 0,
  headTitle: document.title,
  iframeCount: document.querySelectorAll("iframe, frame, webview").length,
  topLevelTags: [],
};

// What are the top-level body children? (first 10)
if (document.body) {
  var bodyKids = document.body.children;
  for (var k = 0; k < Math.min(bodyKids.length, 10); k++) {
    var kid = bodyKids[k];
    var info = kid.tagName;
    if (kid.id) info += "#" + kid.id;
    if (kid.className && typeof kid.className === "string")
      info += "." + kid.className.split(" ").slice(0, 2).join(".");
    diag.topLevelTags.push(info);
  }
}

return JSON.stringify({
  ok: true,
  title: document.title,
  url: location.href,
  time: Date.now(),
  buttons: totalButtons,
  editables: totalEditables,
  documents: docs.length,
  shadowRoots: totalShadowRoots,
  totalElements: totalElements,
  diag: diag,
});
