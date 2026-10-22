/*
 * Prefers Checker: analyzer.js
 *
 * The probe suite that runs IN the page. runProbe is passed to
 * chrome.scripting.executeScript as a function, which means its source is
 * serialized and evaluated in the page context. It must therefore be
 * completely self-contained: every helper is nested inside runProbe and it
 * returns only plain JSON-able data.
 *
 * The probe gathers evidence only. All scoring lives in core.js.
 */
(function (global) {
  'use strict';

  function runProbe() {
    var result = {
      url: location.href,
      title: document.title,
      matchMedia: {},
      sheets: { accessible: 0, inaccessible: 0 },
      mediaTexts: [],
      colorSchemeProp: false,
      metaColorScheme: false,
      animationsRunning: 0,
      colors: { bodyBg: '', bodyColor: '', rootBg: '', rootColor: '' },
      samples: [],
      unmeasurableSamples: 0,
      transparency: { backdropCount: 0, translucentCount: 0, examined: 0 },
      data: { totalBytes: 0, resourceCount: 0, imageCount: 0, videoCount: 0, autoplayCount: 0 },
      error: ''
    };

    function mq(query) {
      try { return !!window.matchMedia(query).matches; } catch (e) { return false; }
    }

    function parseRgba(str) {
      if (!str) return null;
      var m = /^rgba?\(([^)]+)\)$/.exec(String(str).trim());
      if (!m) return null;
      var parts = m[1].split(/[\s,\/]+/).filter(function (p) { return p !== ''; });
      if (parts.length < 3) return null;
      var nums = parts.map(function (p) { return parseFloat(p); });
      for (var i = 0; i < nums.length; i++) {
        if (isNaN(nums[i])) return null;
      }
      return { r: nums[0], g: nums[1], b: nums[2], a: parts.length > 3 ? nums[3] : 1 };
    }

    function compositeOver(fg, bg) {
      var a = typeof fg.a === 'number' ? fg.a : 1;
      return {
        r: fg.r * a + bg.r * (1 - a),
        g: fg.g * a + bg.g * (1 - a),
        b: fg.b * a + bg.b * (1 - a)
      };
    }

    function labelFor(el) {
      var label = el.tagName.toLowerCase();
      if (el.id) {
        label += '#' + el.id;
      } else if (el.className && typeof el.className === 'string') {
        var classes = el.className.trim().split(/\s+/).slice(0, 2);
        if (classes.length && classes[0]) label += '.' + classes.join('.');
      }
      return label.slice(0, 48);
    }

    try {
      /* ---------- media query states ---------- */
      result.matchMedia = {
        motionReduce: mq('(prefers-reduced-motion: reduce)'),
        schemeLight: mq('(prefers-color-scheme: light)'),
        schemeDark: mq('(prefers-color-scheme: dark)'),
        contrastMore: mq('(prefers-contrast: more)'),
        contrastLess: mq('(prefers-contrast: less)'),
        transparencyReduce: mq('(prefers-reduced-transparency: reduce)'),
        dataReduce: mq('(prefers-reduced-data: reduce)')
      };

      /* ---------- stylesheet scan ---------- */
      var mediaTexts = [];
      var colorSchemeProp = false;

      function walkRules(rules, depth) {
        if (!rules || depth > 6) return;
        for (var i = 0; i < rules.length; i++) {
          var rule = rules[i];
          try {
            if (rule.type === 4) { // CSSRule.MEDIA_RULE
              if (rule.media && rule.media.mediaText) mediaTexts.push(rule.media.mediaText);
              if (rule.cssRules) walkRules(rule.cssRules, depth + 1);
            } else if (rule.type === 3) { // CSSRule.IMPORT_RULE
              if (rule.styleSheet && rule.styleSheet.cssRules) {
                walkRules(rule.styleSheet.cssRules, depth + 1);
              }
            } else if (rule.cssRules) { // grouping rules: supports, layer
              walkRules(rule.cssRules, depth + 1);
            } else if (rule.style && rule.style.getPropertyValue) {
              if (rule.style.getPropertyValue('color-scheme')) colorSchemeProp = true;
            }
          } catch (e) { /* a single unreadable rule is not fatal */ }
        }
      }

      var sheets = document.styleSheets;
      for (var si = 0; si < sheets.length; si++) {
        try {
          var rules = sheets[si].cssRules;
          if (!rules) throw new Error('no rules');
          result.sheets.accessible++;
          walkRules(rules, 0);
        } catch (e) {
          result.sheets.inaccessible++;
        }
      }
      result.mediaTexts = mediaTexts.slice(0, 500);
      result.colorSchemeProp = colorSchemeProp;
      result.metaColorScheme = !!document.querySelector('meta[name="color-scheme"]');

      /* ---------- live animations ---------- */
      try {
        var animations = document.getAnimations({ subtree: true });
        var running = 0;
        for (var ai = 0; ai < animations.length; ai++) {
          if (animations[ai].playState === 'running') running++;
        }
        result.animationsRunning = running;
      } catch (e) { /* getAnimations unsupported: leave 0 */ }

      /* ---------- page colors (for color-scheme comparison) ---------- */
      try {
        var bodyStyle = document.body ? window.getComputedStyle(document.body) : null;
        var rootStyle = window.getComputedStyle(document.documentElement);
        result.colors = {
          bodyBg: bodyStyle ? bodyStyle.backgroundColor : '',
          bodyColor: bodyStyle ? bodyStyle.color : '',
          rootBg: rootStyle ? rootStyle.backgroundColor : '',
          rootColor: rootStyle ? rootStyle.color : ''
        };
      } catch (e) { /* leave blanks */ }

      /* ---------- contrast sampling ---------- */
      function effectiveBackground(el) {
        var layers = [];
        var node = el;
        while (node && node.nodeType === 1) {
          var style = window.getComputedStyle(node);
          if (style.backgroundImage && style.backgroundImage !== 'none') {
            return null; // image or gradient behind the text: unmeasurable
          }
          var color = parseRgba(style.backgroundColor);
          if (color && color.a > 0) {
            layers.push(color);
            if (color.a >= 1) break;
          }
          node = node.parentElement;
        }
        var base = { r: 255, g: 255, b: 255 };
        for (var li = layers.length - 1; li >= 0; li--) {
          base = compositeOver(layers[li], base);
        }
        return base;
      }

      try {
        var all = document.body ? document.body.querySelectorAll('*') : [];
        var examined = 0;
        var unmeasurable = 0;
        for (var ei = 0; ei < all.length && result.samples.length < 60 && examined < 1500; ei++) {
          var el = all[ei];
          examined++;
          var hasText = false;
          for (var ci = 0; ci < el.childNodes.length; ci++) {
            var node2 = el.childNodes[ci];
            if (node2.nodeType === 3 && node2.textContent.trim()) { hasText = true; break; }
          }
          if (!hasText) continue;
          var cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          if (!(parseFloat(cs.fontSize) >= 11)) continue;
          var rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
          var bg = effectiveBackground(el);
          if (!bg) { unmeasurable++; continue; }
          var fg = parseRgba(cs.color);
          if (!fg) continue;
          var fgRgb = fg.a < 1 ? compositeOver(fg, bg) : { r: fg.r, g: fg.g, b: fg.b };
          result.samples.push({ label: labelFor(el), fg: fgRgb, bg: bg });
        }
        result.unmeasurableSamples = unmeasurable;
      } catch (e) { /* sampling is best-effort */ }

      /* ---------- transparency surfaces ---------- */
      try {
        var tAll = document.querySelectorAll('*');
        var tExamined = 0;
        var backdropCount = 0;
        var translucentCount = 0;
        for (var ti = 0; ti < tAll.length && tExamined < 800; ti++) {
          var tEl = tAll[ti];
          tExamined++;
          var tStyle = window.getComputedStyle(tEl);
          var bf = tStyle.backdropFilter || tStyle.webkitBackdropFilter || '';
          if (bf && bf !== 'none') backdropCount++;
          var tColor = parseRgba(tStyle.backgroundColor);
          if (tColor && tColor.a > 0.05 && tColor.a < 1) {
            var tRect = tEl.getBoundingClientRect();
            if (tRect.width * tRect.height >= 10000) translucentCount++;
          }
        }
        result.transparency = {
          backdropCount: backdropCount,
          translucentCount: translucentCount,
          examined: tExamined
        };
      } catch (e) { /* best-effort */ }

      /* ---------- data weight ---------- */
      try {
        var entries = (window.performance && performance.getEntriesByType)
          ? performance.getEntriesByType('resource') : [];
        var totalBytes = 0;
        for (var ri = 0; ri < entries.length; ri++) {
          totalBytes += entries[ri].transferSize || entries[ri].encodedBodySize || 0;
        }
        result.data = {
          totalBytes: totalBytes,
          resourceCount: entries.length,
          imageCount: document.querySelectorAll('img').length,
          videoCount: document.querySelectorAll('video').length,
          autoplayCount: document.querySelectorAll('video[autoplay]').length
        };
      } catch (e) { /* best-effort */ }
    } catch (err) {
      result.error = String(err && err.message ? err.message : err);
    }

    return result;
  }

  global.PrefersAnalyzer = { runProbe: runProbe };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.PrefersAnalyzer;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
