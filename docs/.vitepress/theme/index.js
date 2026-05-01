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

    function injectSidebarSearch() {
      // Only inject once
      if (document.querySelector('.vp-sidebar-search')) return;
      // Find nav container (VitePress default class)
      const nav = document.querySelector('.VPSidebar nav');
      if (!nav) return;
      // Find the first .group inside nav
      const firstGroup = nav.querySelector('.group');
      if (!firstGroup) return;
      // Create the search filter div
      const searchDiv = document.createElement('div');
      searchDiv.className = 'vp-sidebar-search';
      searchDiv.innerHTML = `<input type="text" placeholder="Filter builds..." aria-label="Filter builds" />`;
      nav.insertBefore(searchDiv, firstGroup);

      const input = searchDiv.querySelector('input');
      input.addEventListener('input', function () {
        filterSidebarBuilds(this.value);
      });
    }

    // Prefetch and cache build file contents for filtering
    const buildContentCache = {};
    async function fetchBuildContent(href) {
      if (buildContentCache[href]) return buildContentCache[href];
      try {
        let url = href;
        // Convert .html or extensionless to .md for raw markdown fetch
        url = url.replace(/\.html$/, '');
        // Remove trailing slash if present
        url = url.replace(/\/$/, '');
        if (!url.endsWith('.md')) url += '.md';
        // Ensure leading slash
        if (!url.startsWith('/')) url = '/' + url;
        const res = await fetch(url);
        if (!res.ok) {
          return '';
        }
        const text = await res.text();
        buildContentCache[href] = text;
        return text;
      } catch (e) {
        console.error('[fetchBuildContent] Error fetching', href, e);
        return '';
      }
    }

    async function filterSidebarBuilds(query) {
      const sidebar = document.querySelector('.VPSidebar');
      if (!sidebar) return;
      const links = sidebar.querySelectorAll('a');
      const q = String(query || '').toLowerCase();
      const promises = [];
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        if (!href.includes('/builds/')) continue;
        if (href.endsWith('/builds/')) {
          a.style.display = '';
          continue;
        }
        // Prefetch and filter by content
        promises.push((async () => {
          if (!q) {
            a.style.display = '';
            return;
          }
          const content = await fetchBuildContent(href);
          const match = content.toLowerCase().includes(q);
          if (match) {
            a.style.display = '';
          } else {
            a.style.display = 'none';
          }
        })());
      }
      await Promise.all(promises);


      // Use correct selector for sidebar groups/items
      const groups = sidebar.querySelectorAll('div.group > section.VPSidebarItem.level-0');
      if (groups.length === 0) {
        // Keep silent if no groups found
        return;
      }
      // Helper: check if a group (item) has a visible link in its direct .items
      function groupHasVisibleLinks(group) {
        const items = group.querySelector('.items');
        if (!items) return false;
        const visibleLinks = items.querySelectorAll('a:not([style*="display: none"])');
        return visibleLinks.length > 0;
      }

      if (q) {
        // Filter is active: expand all groups (items) whose .items has a visible link, hide/collapse all others
        for (const group of groups) {
          // The toggle is the .item div inside the group
          const toggle = group.querySelector('.item');
          const hasVisible = groupHasVisibleLinks(group);
          group.style.display = hasVisible ? '' : 'none';
          if (hasVisible) {
            group.classList.remove('collapsed');
            group.classList.add('open');
            if (toggle) toggle.setAttribute('aria-expanded', 'true');
          } else {
            group.classList.remove('open');
            group.classList.add('collapsed');
            if (toggle) toggle.setAttribute('aria-expanded', 'false');
          }
        }
      } else {
        // Filter is empty: expand only the first version group (index 1), collapse all others
        for (let i = 0; i < groups.length; i++) {
          const group = groups[i];
          const toggle = group.querySelector('.item');
          group.style.display = '';
          if (i === 1) {
            group.classList.remove('collapsed');
            group.classList.add('open');
            if (toggle) toggle.setAttribute('aria-expanded', 'true');
          } else {
            group.classList.remove('open');
            group.classList.add('collapsed');
            if (toggle) toggle.setAttribute('aria-expanded', 'false');
          }
        }
      }
    }

    const run = () => {
      // Let VitePress update the DOM first.
      requestAnimationFrame(() => {
        updateBuildTitles();
        injectSidebarSearch();
      });
    };

    run();
    router.onAfterRouteChange = run;
  },
};
