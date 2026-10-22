/*
 * Prefers Checker: popup.js
 *
 * On open: find the active tab, run the instant probe in it, enrich and
 * score the evidence with core.js, and render one row per preference.
 * The deep test runs in the service worker (background.js); progress and
 * results come back through chrome.storage.session so they survive the
 * popup closing mid-test.
 */
/* global PrefersCore, PrefersAnalyzer */
'use strict';

var state = {
  tab: null,
  base: null,
  deepStates: null,
  deepRestored: false
};

var els = {};

function $(id) { return document.getElementById(id); }

function isAnalyzableUrl(url) {
  if (!url) return false;
  var blocked = ['chrome://', 'chrome-extension://', 'about:', 'edge://', 'devtools://', 'view-source:'];
  for (var i = 0; i < blocked.length; i++) {
    if (url.indexOf(blocked[i]) === 0) return false;
  }
  if (url.indexOf('https://chromewebstore.google.com') === 0) return false;
  if (url.indexOf('https://chrome.google.com/webstore') === 0) return false;
  return /^https?:\/\//.test(url) || url.indexOf('file://') === 0;
}

function showError(text) {
  els.error.textContent = text;
  els.error.hidden = false;
}

function render() {
  if (!state.base) return;
  var verdicts = PrefersCore.evaluateAll(state.base, state.deepStates);
  var summary = PrefersCore.summarize(verdicts);
  els.overall.textContent = summary.text + (state.deepStates ? ' (deep test)' : ' (instant scan)');
  els.rows.textContent = '';

  PrefersCore.FEATURES.forEach(function (feature) {
    var v = verdicts[feature.key];
    var row = document.createElement('section');
    row.className = 'row';

    var top = document.createElement('div');
    top.className = 'row-top';
    var name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = feature.name;
    var pill = document.createElement('span');
    pill.className = 'pill pill-' + v.status;
    pill.textContent = PrefersCore.STATUS_LABELS[v.status] || v.status;
    top.appendChild(name);
    top.appendChild(pill);
    row.appendChild(top);

    var evidence = document.createElement('p');
    evidence.className = 'row-evidence';
    evidence.textContent = v.evidence;
    row.appendChild(evidence);

    if (v.details && v.details.length) {
      var details = document.createElement('details');
      var summaryEl = document.createElement('summary');
      summaryEl.textContent = 'Details';
      details.appendChild(summaryEl);
      var ul = document.createElement('ul');
      v.details.forEach(function (line) {
        var li = document.createElement('li');
        li.textContent = line;
        ul.appendChild(li);
      });
      details.appendChild(ul);
      row.appendChild(details);
    }

    els.rows.appendChild(row);
  });
}

function addSheetNote() {
  if (!state.base || !state.base.sheets) return;
  var inaccessible = state.base.sheets.inaccessible;
  if (inaccessible > 0) {
    var li = document.createElement('li');
    li.textContent = inaccessible + ' stylesheet(s) on this page are cross-origin and were invisible to this scan.';
    els.notesList.appendChild(li);
  }
}

async function runInstantScan() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  var tab = tabs && tabs[0];
  if (!tab) {
    showError('No active tab found.');
    return;
  }
  state.tab = tab;
  els.pageUrl.textContent = tab.url || '';
  els.pageUrl.title = tab.url || '';

  if (!isAnalyzableUrl(tab.url)) {
    showError('This page cannot be analyzed. Browser internal pages and the Chrome Web Store block extensions.');
    els.overall.textContent = '';
    els.deepButton.disabled = true;
    return;
  }

  var results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: PrefersAnalyzer.runProbe
    });
  } catch (err) {
    showError('The probe could not run on this page: ' + (err && err.message ? err.message : err));
    els.deepButton.disabled = true;
    return;
  }
  var raw = results && results[0] && results[0].result;
  if (!raw) {
    showError('The probe returned nothing for this page.');
    els.deepButton.disabled = true;
    return;
  }
  if (raw.error) {
    showError('The probe hit an error on this page: ' + raw.error);
  }
  state.base = PrefersCore.enrichEvidence(raw);
  render();
  addSheetNote();
  restoreDeepResults();
}

async function restoreDeepResults() {
  try {
    var stored = await chrome.storage.session.get('prefersCheckerDeepResult');
    var result = stored.prefersCheckerDeepResult;
    if (result && result.ok && state.tab && result.tabId === state.tab.id &&
        Date.now() - result.ts < 15 * 60 * 1000) {
      state.deepStates = result.states;
      state.deepRestored = true;
      render();
      els.deepStatus.textContent = 'Showing deep test results from earlier in this browser session. Run the test again for fresh numbers.';
    }
  } catch (e) { /* storage is best-effort */ }
}

function setDeepRunning(running, label) {
  els.deepButton.disabled = running;
  els.deepButton.textContent = running ? 'Running deep test...' : 'Run deep test';
  if (label) els.deepStatus.textContent = label;
}

async function runDeepTest() {
  if (!state.tab) return;
  setDeepRunning(true, 'Attaching the debugger...');
  var result;
  try {
    result = await chrome.runtime.sendMessage({
      type: 'prefers-checker/run-deep',
      tabId: state.tab.id
    });
  } catch (err) {
    setDeepRunning(false, 'Deep test failed: ' + (err && err.message ? err.message : err));
    return;
  }
  if (!result) {
    // The service worker stores results even if this response is lost.
    try {
      var stored = await chrome.storage.session.get('prefersCheckerDeepResult');
      result = stored.prefersCheckerDeepResult;
    } catch (e) { /* fall through */ }
  }
  if (result && result.ok) {
    state.deepStates = result.states;
    render();
    var errored = Object.keys(result.stateErrors || {});
    setDeepRunning(false, errored.length
      ? 'Deep test finished. Some emulated states were unavailable: ' + errored.join(', ') + '.'
      : 'Deep test finished. Emulation was cleared and the page was left as it was.');
  } else {
    setDeepRunning(false, result && result.error ? result.error : 'Deep test failed.');
  }
}

function watchProgress() {
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'session') return;
    var progress = changes.prefersCheckerProgress && changes.prefersCheckerProgress.newValue;
    if (progress && state.tab && progress.tabId === state.tab.id && els.deepButton.disabled) {
      els.deepStatus.textContent = 'Step ' + progress.step + ' of ' + progress.total + ': ' + progress.label;
    }
  });
}

document.addEventListener('DOMContentLoaded', function () {
  els.pageUrl = $('page-url');
  els.overall = $('overall');
  els.error = $('error');
  els.rows = $('rows');
  els.deepButton = $('deep-button');
  els.deepStatus = $('deep-status');
  els.notesList = $('notes-list');
  els.deepButton.addEventListener('click', runDeepTest);
  watchProgress();
  runInstantScan();
});
