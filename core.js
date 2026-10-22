/*
 * Prefers Checker: core.js
 *
 * Pure, DOM-free logic shared by the popup, the service worker, and the
 * node test suite:
 *   - WCAG contrast math (parse colors, composite alpha, relative luminance)
 *   - CSS media query scanning (find the five user-preference features)
 *   - Evidence enrichment (turn a raw page probe into scored evidence)
 *   - Per-feature verdicts and the overall summary
 *
 * Loaded as a plain script in extension pages, via importScripts in the
 * service worker, and via require() in tests.
 */
(function (global) {
  'use strict';

  var FEATURES = [
    { key: 'motion', name: 'prefers-reduced-motion' },
    { key: 'scheme', name: 'prefers-color-scheme' },
    { key: 'contrast', name: 'prefers-contrast' },
    { key: 'transparency', name: 'prefers-reduced-transparency' },
    { key: 'data', name: 'prefers-reduced-data' }
  ];

  var STATUS_LABELS = {
    pass: 'Pass',
    partial: 'Partial',
    fail: 'Fail',
    unknown: 'Unknown',
    nottestable: 'Not testable'
  };

  /* ---------------- color math ---------------- */

  // Parse 'rgb()', 'rgba()', '#rgb', '#rrggbb', 'transparent' into
  // { r, g, b, a } with channels 0-255 and alpha 0-1. Returns null on failure.
  function parseColor(str) {
    if (!str || typeof str !== 'string') return null;
    var s = str.trim().toLowerCase();
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    var hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
    if (hex) {
      var h = hex[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: 1
      };
    }
    var fn = /^rgba?\(([^)]+)\)$/.exec(s);
    if (fn) {
      var parts = fn[1].split(/[\s,\/]+/).filter(function (p) { return p !== ''; });
      if (parts.length < 3) return null;
      var nums = parts.map(function (p) { return parseFloat(p); });
      for (var i = 0; i < nums.length; i++) {
        if (typeof nums[i] !== 'number' || isNaN(nums[i])) return null;
      }
      return { r: nums[0], g: nums[1], b: nums[2], a: parts.length > 3 ? nums[3] : 1 };
    }
    return null;
  }

  // Alpha-composite fg ({r,g,b,a}) over an opaque bg ({r,g,b}).
  function compositeOver(fg, bg) {
    var a = typeof fg.a === 'number' ? fg.a : 1;
    return {
      r: fg.r * a + bg.r * (1 - a),
      g: fg.g * a + bg.g * (1 - a),
      b: fg.b * a + bg.b * (1 - a)
    };
  }

  // WCAG 2.x relative luminance for an {r,g,b} color with channels 0-255.
  function relativeLuminance(color) {
    function channel(c) {
      var cs = c / 255;
      return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  }

  // WCAG contrast ratio between two {r,g,b} colors, 1 to 21.
  function contrastRatio(c1, c2) {
    var l1 = relativeLuminance(c1);
    var l2 = relativeLuminance(c2);
    var lighter = Math.max(l1, l2);
    var darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  /* ---------------- CSS scanning ---------------- */

  var MEDIA_PATTERNS = {
    motion: /prefers-reduced-motion/g,
    scheme: /prefers-color-scheme/g,
    contrast: /prefers-contrast/g,
    transparency: /prefers-reduced-transparency/g,
    data: /prefers-reduced-data/g,
    forcedColors: /forced-colors/g
  };

  // Count how many media query texts (or raw CSS text) mention each feature.
  function scanMediaQueries(texts) {
    var joined = (texts || []).join('\n');
    var counts = {};
    Object.keys(MEDIA_PATTERNS).forEach(function (key) {
      var matches = joined.match(MEDIA_PATTERNS[key]);
      counts[key] = matches ? matches.length : 0;
    });
    return counts;
  }

  function scanCssText(cssText) {
    return scanMediaQueries([cssText || '']);
  }

  /* ---------------- page weight ---------------- */

  // Page weight classes for the reduced-data check, based on total
  // transfer size of loaded resources:
  //   light    < 1.5 MB   (1,572,864 bytes)
  //   moderate 1.5 to 3 MB
  //   heavy    > 3 MB     (3,145,728 bytes)
  var LIGHT_LIMIT = 1.5 * 1024 * 1024;
  var HEAVY_LIMIT = 3 * 1024 * 1024;

  function classifyWeight(bytes) {
    if (bytes < LIGHT_LIMIT) return 'light';
    if (bytes <= HEAVY_LIMIT) return 'moderate';
    return 'heavy';
  }

  function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
    return bytes + ' B';
  }

  /* ---------------- evidence enrichment ---------------- */

  // A raw probe (analyzer.js) carries: mediaTexts, samples, colors,
  // matchMedia, sheet counts and per-feature raw measurements. Enrichment
  // derives rule counts and contrast statistics so scorers get one shape.
  function enrichEvidence(raw) {
    if (!raw) return raw;
    var counts = scanMediaQueries(raw.mediaTexts || []);
    var samples = raw.samples || [];
    var failing = 0;
    var worst = null;
    samples.forEach(function (s) {
      var ratio = contrastRatio(s.fg, s.bg);
      if (ratio < 4.5) {
        failing++;
        if (!worst || ratio < worst.ratio) {
          worst = { label: s.label, ratio: Math.round(ratio * 100) / 100 };
        }
      }
    });
    var data = raw.data || {};
    raw.mediaRuleCounts = counts;
    raw.features = {
      motion: {
        hasRules: counts.motion > 0,
        mediaRuleCount: counts.motion,
        animationsRunning: raw.animationsRunning || 0
      },
      scheme: {
        hasRules: counts.scheme > 0,
        mediaRuleCount: counts.scheme,
        metaColorScheme: !!raw.metaColorScheme,
        cssColorSchemeProp: !!raw.colorSchemeProp
      },
      contrast: {
        hasRules: counts.contrast > 0 || counts.forcedColors > 0,
        mediaRuleCount: counts.contrast,
        forcedColorsRules: counts.forcedColors,
        sampled: samples.length,
        failing: failing,
        worst: worst,
        unmeasurable: raw.unmeasurableSamples || 0
      },
      transparency: {
        hasRules: counts.transparency > 0,
        mediaRuleCount: counts.transparency,
        backdropCount: raw.transparency ? raw.transparency.backdropCount : 0,
        translucentCount: raw.transparency ? raw.transparency.translucentCount : 0,
        examined: raw.transparency ? raw.transparency.examined : 0
      },
      data: {
        hasRules: counts.data > 0,
        mediaRuleCount: counts.data,
        totalBytes: data.totalBytes || 0,
        resourceCount: data.resourceCount || 0,
        imageCount: data.imageCount || 0,
        videoCount: data.videoCount || 0,
        autoplayCount: data.autoplayCount || 0,
        weightClass: classifyWeight(data.totalBytes || 0)
      }
    };
    return raw;
  }

  /* ---------------- verdicts ---------------- */

  function verdict(status, evidence, details) {
    return { status: status, evidence: evidence, details: details || [] };
  }

  function colorsDiffer(a, b) {
    if (!a || !b) return false;
    var keys = ['bodyBg', 'bodyColor', 'rootBg', 'rootColor'];
    for (var i = 0; i < keys.length; i++) {
      if ((a[keys[i]] || '') !== (b[keys[i]] || '')) return true;
    }
    return false;
  }

  function scoreMotion(base, states) {
    var f = base.features.motion;
    var deep = states && states.motionReduce ? states.motionReduce.features.motion : null;
    if (deep) {
      if (deep.animationsRunning === 0) {
        if (f.animationsRunning === 0) {
          return verdict('pass', 'No running animations found; nothing to reduce.',
            ['Checked again under emulated reduce: still no running animations.']);
        }
        return verdict('pass', 'Animations stop when reduced motion is emulated.',
          [f.animationsRunning + ' animation(s) run normally, 0 under reduce.']);
      }
      if (f.hasRules) {
        return verdict('partial',
          'Reduced-motion rules exist, but ' + deep.animationsRunning + ' animation(s) still run under emulated reduce.',
          ['JavaScript-driven animations often ignore the media query even when CSS honors it.']);
      }
      return verdict('fail',
        deep.animationsRunning + ' animation(s) keep running under emulated reduced motion and no prefers-reduced-motion rules were found.', []);
    }
    // Instant evidence only.
    if (f.animationsRunning === 0) {
      return verdict('pass', 'No running animations found; nothing to reduce.',
        ['Run the deep test to confirm nothing animates under emulation either.']);
    }
    if (base.matchMedia && base.matchMedia.motionReduce) {
      return verdict(f.hasRules ? 'partial' : 'fail',
        'Your system requests reduced motion, yet ' + f.animationsRunning + ' animation(s) are running.',
        ['Run the deep test to confirm behavior under emulation.']);
    }
    if (f.hasRules) {
      return verdict('unknown',
        f.mediaRuleCount + ' prefers-reduced-motion rule(s) found; behavior not verified yet.',
        ['Run the deep test to check whether animations actually stop.']);
    }
    return verdict('unknown',
      f.animationsRunning + ' animation(s) running and no reduced-motion rules found.',
      ['Run the deep test to see what happens under emulated reduce.']);
  }

  function scoreScheme(base, states) {
    var f = base.features.scheme;
    var indicators = f.hasRules || f.metaColorScheme || f.cssColorSchemeProp;
    if (states && states.schemeDark && states.schemeLight) {
      if (colorsDiffer(states.schemeDark.colors, states.schemeLight.colors)) {
        return verdict('pass', 'Page colors change between light and dark emulation.',
          ['Compared computed body and root background and text colors across the two states.']);
      }
      if (indicators) {
        return verdict('partial',
          'Declares color-scheme support, but page colors did not change under emulation.',
          ['The declaration may only affect form controls and scrollbars, or the theme may be script-driven.']);
      }
      return verdict('fail',
        'No color-scheme support found and colors do not change under dark emulation.', []);
    }
    if (indicators) {
      var which = [];
      if (f.hasRules) which.push(f.mediaRuleCount + ' media rule(s)');
      if (f.metaColorScheme) which.push('a color-scheme meta tag');
      if (f.cssColorSchemeProp) which.push('the CSS color-scheme property');
      return verdict('unknown',
        'Color-scheme support declared (' + which.join(', ') + '); not verified yet.',
        ['Run the deep test to check the page actually restyles for dark.']);
    }
    return verdict('unknown',
      'No color-scheme indicators found.', ['Run the deep test to check dark emulation.']);
  }

  function scoreContrast(base, states) {
    var f = base.features.contrast;
    if (!f.sampled) {
      return verdict('unknown', 'No measurable text was sampled on this page.',
        ['Text over images or gradients is skipped by the sampler.']);
    }
    var baseLine = f.failing + ' of ' + f.sampled + ' sampled text elements below 4.5:1' +
      (f.worst ? ' (worst ' + f.worst.ratio.toFixed(2) + ':1 on ' + f.worst.label + ')' : '') + '.';
    if (states && states.contrastMore) {
      var m = states.contrastMore.features.contrast;
      if (f.failing > 0 && m.failing === 0) {
        return verdict('pass', 'All sampled text passes under emulated higher contrast.',
          ['Without emulation: ' + baseLine]);
      }
      if (m.failing < f.failing) {
        return verdict('partial',
          'Contrast improves under prefers-contrast: more, but ' + m.failing + ' element(s) still fail.',
          ['Without emulation: ' + baseLine]);
      }
      if (f.failing === 0) {
        return verdict('pass', 'All ' + f.sampled + ' sampled text elements meet 4.5:1.', []);
      }
      return verdict(f.hasRules ? 'partial' : 'fail', baseLine,
        ['Emulating more contrast did not change the failing count.']);
    }
    if (f.failing === 0) {
      return verdict('pass', 'All ' + f.sampled + ' sampled text elements meet 4.5:1.',
        ['Run the deep test to see whether a higher-contrast mode is offered.']);
    }
    return verdict(f.hasRules ? 'partial' : 'fail', baseLine,
      [f.hasRules
        ? 'Contrast rules exist; run the deep test to see whether they fix these elements.'
        : 'No prefers-contrast or forced-colors rules found.']);
  }

  function scoreTransparency(base, states) {
    var f = base.features.transparency;
    var surfaces = f.backdropCount + f.translucentCount;
    if (states && states.transparencyReduce) {
      var st = states.transparencyReduce;
      if (!st.matchMedia || !st.matchMedia.transparencyReduce) {
        return verdict('nottestable',
          'This browser would not flip prefers-reduced-transparency under emulation, so the page cannot be deep-tested for this feature yet.',
          ['Instant evidence: ' + surfaces + ' translucent surface(s) found; reduced-transparency rules: ' + (f.hasRules ? 'yes' : 'no') + '.']);
      }
      var rf = st.features.transparency;
      var rSurfaces = rf.backdropCount + rf.translucentCount;
      if (surfaces === 0) {
        return verdict('pass', 'No translucent surfaces found; nothing to flatten.',
          ['Verified under emulated reduce as well.']);
      }
      if (rSurfaces < surfaces) {
        return verdict('pass',
          'Translucent surfaces reduce under emulated reduced transparency (' + surfaces + ' down to ' + rSurfaces + ').', []);
      }
      return verdict(f.hasRules ? 'partial' : 'fail',
        surfaces + ' translucent surface(s) are unchanged under emulated reduced transparency.', []);
    }
    if (surfaces === 0) {
      return verdict('pass',
        'No translucent surfaces found (no backdrop filters, no large translucent backgrounds).', []);
    }
    if (f.hasRules) {
      return verdict('unknown',
        surfaces + ' translucent surface(s) and reduced-transparency rules found.',
        ['Run the deep test to verify surfaces flatten under reduce.']);
    }
    return verdict('unknown',
      surfaces + ' translucent surface(s) found, no prefers-reduced-transparency rules.',
      ['Almost no sites have these rules yet; browser support for the query is new.',
       'Run the deep test; some browsers cannot emulate this feature yet.']);
  }

  function scoreData(base, states) {
    var f = base.features.data;
    var size = formatBytes(f.totalBytes);
    var details = [
      f.resourceCount + ' resource(s) loaded, ' + f.imageCount + ' image(s), ' + f.videoCount + ' video(s).'
    ];
    if (f.autoplayCount > 0) {
      details.push(f.autoplayCount + ' autoplaying video(s) found; autoplay is a common data-saver complaint.');
    }
    if (states && states.dataReduce) {
      if (!states.dataReduce.matchMedia || !states.dataReduce.matchMedia.dataReduce) {
        details.push('The browser did not flip prefers-reduced-data under emulation, so this verdict rests on rules and page weight.');
      } else if (states.dataReduce.features.data.resourceCount < f.resourceCount) {
        details.push('Fewer resources were loaded under emulated reduce than in the normal state.');
      }
    }
    if (f.hasRules) {
      if (f.weightClass === 'heavy') {
        return verdict('partial',
          'Declares prefers-reduced-data handling, but the page itself is heavy (' + size + ').', details);
      }
      return verdict('pass',
        'Declares prefers-reduced-data handling; page weight is ' + f.weightClass + ' (' + size + ').', details);
    }
    if (f.weightClass === 'light') {
      return verdict('partial',
        'Light page (' + size + '), but no prefers-reduced-data rules.', details);
    }
    if (f.weightClass === 'moderate') {
      return verdict('partial',
        'Moderate page weight (' + size + ') and no prefers-reduced-data rules.', details);
    }
    return verdict('fail',
      'Heavy page (' + size + ') with no prefers-reduced-data handling.', details);
  }

  var SCORERS = {
    motion: scoreMotion,
    scheme: scoreScheme,
    contrast: scoreContrast,
    transparency: scoreTransparency,
    data: scoreData
  };

  // base: enriched instant evidence. states: map of enriched evidence per
  // emulated state name (motionReduce, schemeDark, schemeLight,
  // contrastMore, transparencyReduce, dataReduce) or null.
  function evaluateAll(base, states) {
    var verdicts = {};
    FEATURES.forEach(function (feature) {
      verdicts[feature.key] = SCORERS[feature.key](base, states);
    });
    return verdicts;
  }

  function summarize(verdicts) {
    var handled = 0;
    FEATURES.forEach(function (feature) {
      if (verdicts[feature.key] && verdicts[feature.key].status === 'pass') handled++;
    });
    return {
      handled: handled,
      total: FEATURES.length,
      text: 'Handles ' + handled + ' of ' + FEATURES.length + ' preferences'
    };
  }

  var api = {
    FEATURES: FEATURES,
    STATUS_LABELS: STATUS_LABELS,
    parseColor: parseColor,
    compositeOver: compositeOver,
    relativeLuminance: relativeLuminance,
    contrastRatio: contrastRatio,
    scanMediaQueries: scanMediaQueries,
    scanCssText: scanCssText,
    classifyWeight: classifyWeight,
    formatBytes: formatBytes,
    enrichEvidence: enrichEvidence,
    evaluateAll: evaluateAll,
    summarize: summarize,
    scorers: SCORERS
  };

  global.PrefersCore = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
