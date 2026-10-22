# Prefers Checker

A Chrome extension that tests the current page against all five user-preference media queries at once. Open source (MIT) — contributions welcome.

**Landing page:** https://sydbal.github.io/prefers-browser-extension/
**Download:** https://github.com/SydBal/prefers-browser-extension/releases/latest

The rest of this README is the extension's own documentation: what it checks, how to load it unpacked, how the two scan tiers work, and its known limits.

---


A Chrome extension that analyzes the page you are on against all five
user-preference media queries and tells you how well the page handles each
one:

- `prefers-reduced-motion`
- `prefers-color-scheme`
- `prefers-contrast`
- `prefers-reduced-transparency`
- `prefers-reduced-data`

Click the toolbar button on any page and you get a row per preference:
a status (Pass, Partial, Fail, Unknown, or Not testable), a one-line
evidence summary, and expandable details. The header sums it up, for
example "Handles 2 of 5 preferences".

## Load it (unpacked)

1. Open `chrome://extensions` in Chrome.
2. Turn on Developer mode (top right).
3. Click "Load unpacked".
4. Select this `prefers-checker` folder.
5. Pin "Prefers Checker" to the toolbar if you like, then click it on
   any normal web page.

There is no build step and the extension has no dependencies.

## The two tiers

### Instant scan (runs the moment you open the popup)

A probe runs in the current page and gathers evidence in the page's real
state: which preference rules exist in its stylesheets, how many
animations are currently running, live contrast sampling of visible
text, translucent surfaces, and the weight of resources loaded so far.
Verdicts that need emulation are marked Unknown at this tier and say so.

### Deep test (the button)

The extension attaches the Chrome debugger to the tab and uses the
DevTools protocol (`Emulation.setEmulatedMedia`) to flip each media
feature, exactly the way the Rendering panel in DevTools does. After
each flip it re-runs the probe and compares states: do animations stop
under reduced motion, do colors change between dark and light, does
contrast improve, do translucent surfaces flatten, and does the browser
even allow reduced transparency and reduced data to be flipped. When
the test ends, emulation is cleared and the debugger detaches. The page
is left exactly as it was.

Results are kept in session storage, so if you close the popup mid-test
and reopen it, the deep results are still there.

## What each check looks at

- **Reduced motion:** preference rules in stylesheets, plus a live count
  of running animations (Web Animations API). Deep test: the count
  under emulated reduce.
- **Color scheme:** media rules, a `color-scheme` meta tag, or the CSS
  `color-scheme` property. Deep test: computed body and root colors
  compared between dark and light emulation.
- **Contrast:** up to about 60 visible text elements are sampled; each
  gets an effective background (walking up through ancestors, skipping
  images and gradients as unmeasurable) and a WCAG contrast ratio
  against the flat 4.5:1 threshold. Deep test: the failing count under
  emulated `prefers-contrast: more`.
- **Reduced transparency:** counts of backdrop-filter elements and large
  semi-transparent backgrounds, plus any preference rules. Deep test:
  whether surfaces drop under emulated reduce, after verifying the
  browser actually flipped the feature. If it will not flip, the verdict
  says "Not testable in this browser yet" instead of failing the site.
- **Reduced data:** total transfer size of loaded resources (light
  under 1.5 MB, moderate up to 3 MB, heavy above), resource, image and
  video counts, autoplaying videos, and any preference rules.

## Known limits

- **Cross-origin stylesheets are partially invisible.** The scan can
  only read same-origin stylesheets. It counts how many sheets it could
  not read and reports that in the popup, but rules inside them are
  missed.
- **The debugger shows a banner.** While the deep test runs, Chrome
  displays its "started debugging this browser" notice. That is normal
  and it goes away when the test finishes.
- **DevTools conflict.** If DevTools is already open on the tab, the
  debugger cannot attach and the deep test reports that instead of
  running.
- **Contrast sampling is a heuristic.** It samples visible text in the
  current viewport, uses one flat 4.5:1 threshold (no large-text
  allowance), assumes a white canvas behind fully transparent stacks,
  and skips text over images or gradients entirely.
- **Page weight is what has loaded so far.** Lazy-loaded content that
  has not been requested yet is not counted.
- **Internal pages cannot be analyzed.** Chrome blocks extensions on
  `chrome://` pages and the Web Store; the popup says so when it
  happens.

## Files

- `manifest.json`: MV3 manifest. Permissions: `activeTab`, `scripting`,
  `debugger`, `tabs`, and `storage` (storage keeps deep test results
  available when the popup is reopened).
- `analyzer.js`: the probe suite that runs in the page.
- `core.js`: DOM-free logic: contrast math, CSS scanning, scoring.
- `background.js`: service worker that orchestrates the deep test.
- `popup.html`, `popup.css`, `popup.js`: the popup UI.
- `tests/core.test.js`: node tests for the core logic. Run them with
  `node tests/core.test.js`. No dependencies.

## Why an extension and not a website

A web page cannot do this job. Cross-origin iframes cannot be forced
into emulated media states, and CORS stops a site from reading another
site's stylesheets and computed layout properly. The debugger protocol
is the same mechanism DevTools itself uses, so the emulation results
here are the real thing.
