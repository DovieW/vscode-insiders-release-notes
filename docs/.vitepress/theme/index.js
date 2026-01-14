import DefaultTheme from 'vitepress/theme';
import { inBrowser } from 'vitepress';

import './custom.css';

function parseBuildFromPath(pathname) {
  const raw = String(pathname || '');

  // Most routes look like: /builds/<slug>
  // But markdown links can be relative on the builds index page, e.g. ./<slug>
  const marker = '/builds/';
  let rest;
  const idx = raw.lastIndexOf(marker);
  if (idx !== -1) {
    rest = raw.slice(idx + marker.length);
  } else {
    // Try to handle relative hrefs like './2026-...' or '../builds/2026-...'
    const idx2 = raw.lastIndexOf('builds/');
    rest = idx2 !== -1 ? raw.slice(idx2 + 'builds/'.length) : raw;
  }

  rest = rest.replace(/^\.\/+/, '');
  rest = rest.replace(/^\.\.\/+/, '');
  rest = rest.replace(/^\//, '');
  rest = rest.split('#')[0].split('?')[0];
  rest = rest.replace(/\/$/, '');

  // VitePress routes don't include file extensions.
  if (!rest || rest === 'index') return null;

  try {
    rest = decodeURIComponent(rest);
  } catch {
    // ignore
  }

  // YYYY-MM-DD_HH-mmZ_...
  const m = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})Z_/.exec(rest);
  if (!m) return null;

  const date = m[1];
  const hh = m[2];
  const mm = m[3];
  const utcIso = `${date}T${hh}:${mm}:00Z`;

  return { utcIso };
}

function parseBuildFromHref(href) {
  if (!href) return null;
  // Never treat in-page anchors as build links.
  if (String(href).startsWith('#')) return null;
  try {
    // Important: resolve relative links (e.g. "./2026-...") against the CURRENT PAGE,
    // not just the origin, otherwise they resolve to "/2026-..." and we can't parse them.
    const url = new URL(href, window.location.href);
    return parseBuildFromPath(url.pathname) || parseBuildFromPath(href);
  } catch {
    // Relative href like "./2026-..." or "../builds/2026-..."
    return parseBuildFromPath(String(href));
  }
}

function formatLocalTimeAmPm(utcIso) {
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return '';

  // Force am/pm to exist (and then lower-case it), while still converting to *user local time*.
  // Example: "4:50 PM" -> "4:50 pm"
  const s = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  return s.replace(/\bAM\b/g, 'am').replace(/\bPM\b/g, 'pm');
}

function formatLocalDateYmd(utcIso) {
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return '';
  const y = String(d.getFullYear());
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildLocalLabel({ utcIso }) {
  const localDate = formatLocalDateYmd(utcIso);
  const localTime = formatLocalTimeAmPm(utcIso);
  if (localDate && localTime) return `${localDate} - ${localTime}`;
  return localDate || localTime || '';
}

function setSidebarLinkTextPreservingMarkup(a, text) {
  // VitePress sidebar links typically contain spans that are styled for sizing and active states.
  // If we replace `a.textContent`, we remove that markup and can break styling.
  const el = a.querySelector('.text') || a.querySelector('span');
  if (el) el.textContent = text;
  else a.textContent = text;
}

function updateDocLinkLabels() {
  // Update links inside the main page content (e.g. /builds/ index list, and home page latest build link).
  const docLinks = document.querySelectorAll('.VPDoc a:not(.header-anchor)');
  for (const a of docLinks) {
    // VitePress uses this for heading hover links. Never rewrite it.
    if (a.classList.contains('header-anchor')) continue;
    const info = parseBuildFromHref(a.getAttribute('href'));
    if (!info) continue;
    a.textContent = buildLocalLabel(info) || a.textContent;
  }
}

function updateBuildTitles() {
  if (!inBrowser) return;

  // Update page H1 for build pages.
  const current = parseBuildFromPath(window.location.pathname);
  if (current) {
    const h1 = document.querySelector('.VPDoc h1');
    if (h1) {
      h1.textContent = buildLocalLabel(current) || h1.textContent;
    }
  }

  // Update sidebar link labels.
  const sidebarLinks = document.querySelectorAll('.VPSidebar a');
  for (const a of sidebarLinks) {
    const info = parseBuildFromHref(a.getAttribute('href'));
    if (!info) continue;
    setSidebarLinkTextPreservingMarkup(a, buildLocalLabel(info));
  }

  updateDocLinkLabels();
}

export default {
  extends: DefaultTheme,
  enhanceApp({ router }) {
    if (!inBrowser) return;

    const run = () => {
      // Let VitePress update the DOM first.
      requestAnimationFrame(() => updateBuildTitles());
    };

    run();
    router.onAfterRouteChange = run;
  },
};
