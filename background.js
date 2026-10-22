/*
 * Prefers Checker: background.js (MV3 service worker)
 *
 * Runs the deep test. Attaches chrome.debugger to the active tab, then for
 * each emulated state calls Emulation.setEmulatedMedia (the DevTools
 * protocol, the same mechanism as the Rendering panel in DevTools),
 * re-runs the page probe via chrome.scripting, and collects the evidence.
 * Emulation is cleared and the debugger detached at the end, whatever
 * happens.
 *
 * Results are written to chrome.storage.session so the popup can show
 * them even if it was closed and reopened during the test.
 */
/* global PrefersCore, PrefersAnalyzer */
'use strict';

importScripts('core.js', 'analyzer.js');

var PROTOCOL_VERSION = '1.3';

var DEEP_STATES = [
  { name: 'baseline', label: 'Baseline (no emulation)', features: [] },
  {
    name: 'motionReduce', label: 'Emulating prefers-reduced-motion: reduce',
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  },
  {
    name: 'schemeDark', label: 'Emulating prefers-color-scheme: dark',
    features: [{ name: 'prefers-color-scheme', value: 'dark' }]
  },
  {
    name: 'schemeLight', label: 'Emulating prefers-color-scheme: light',
    features: [{ name: 'prefers-color-scheme', value: 'light' }]
  },
  {
    name: 'contrastMore', label: 'Emulating prefers-contrast: more',
    features: [{ name: 'prefers-contrast', value: 'more' }]
  },
  {
    name: 'transparencyReduce', label: 'Emulating prefers-reduced-transparency: reduce',
    features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }]
  },
  {
    name: 'dataReduce', label: 'Emulating prefers-reduced-data: reduce',
    features: [{ name: 'prefers-reduced-data', value: 'reduce' }]
  }
];

function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function debuggerCommand(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId: tabId }, method, params || {});
}

function setProgress(tabId, step, total, label) {
  var progress = { tabId: tabId, step: step, total: total, label: label, ts: Date.now() };
  return chrome.storage.session.set({ prefersCheckerProgress: progress }).catch(function () {});
}

async function probeTab(tabId) {
  var results = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: PrefersAnalyzer.runProbe
  });
  if (!results || !results[0] || !results[0].result) {
    throw new Error('The page probe returned nothing.');
  }
  return PrefersCore.enrichEvidence(results[0].result);
}

async function runDeepTest(tabId) {
  var states = {};
  var stateErrors = {};
  var attached = false;

  try {
    await chrome.debugger.attach({ tabId: tabId }, PROTOCOL_VERSION);
    attached = true;
  } catch (err) {
    return {
      ok: false,
      tabId: tabId,
      error: 'Could not attach the debugger: ' + (err && err.message ? err.message : err) +
        ' If DevTools is open on this tab, close it and try again.'
    };
  }

  try {
    for (var i = 0; i < DEEP_STATES.length; i++) {
      var state = DEEP_STATES[i];
      await setProgress(tabId, i + 1, DEEP_STATES.length, state.label);
      try {
        await debuggerCommand(tabId, 'Emulation.setEmulatedMedia', {
          media: '',
          features: state.features
        });
      } catch (err) {
        // Some browsers cannot emulate some features (reduced data and
        // reduced transparency are the usual suspects). Record it and
        // probe anyway: matchMedia in the probe shows whether it flipped,
        // and the scorers report that honestly.
        stateErrors[state.name] = String(err && err.message ? err.message : err);
      }
      // Reduced data gets a longer settle window to observe late loads.
      await wait(state.name === 'dataReduce' ? 900 : 450);
      try {
        states[state.name] = await probeTab(tabId);
      } catch (err) {
        stateErrors[state.name] = 'Probe failed: ' + (err && err.message ? err.message : err);
      }
    }
  } finally {
    try {
      await debuggerCommand(tabId, 'Emulation.setEmulatedMedia', { media: '', features: [] });
    } catch (e) { /* best effort */ }
    if (attached) {
      try { await chrome.debugger.detach({ tabId: tabId }); } catch (e) { /* best effort */ }
    }
  }

  var result = {
    ok: true,
    tabId: tabId,
    ts: Date.now(),
    states: states,
    stateErrors: stateErrors
  };
  await chrome.storage.session.set({ prefersCheckerDeepResult: result }).catch(function () {});
  await chrome.storage.session.remove('prefersCheckerProgress').catch(function () {});
  return result;
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message && message.type === 'prefers-checker/run-deep' && typeof message.tabId === 'number') {
    runDeepTest(message.tabId).then(function (result) {
      sendResponse(result);
    }).catch(function (err) {
      sendResponse({
        ok: false,
        tabId: message.tabId,
        error: 'Deep test failed: ' + (err && err.message ? err.message : err)
      });
    });
    return true; // async response
  }
  return false;
});
