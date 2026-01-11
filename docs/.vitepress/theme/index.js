import DefaultTheme from 'vitepress/theme';
import { inBrowser } from 'vitepress';

function parseBuildFromPath(pathname) {
  const marker = '/builds/';
  const idx = String(pathname || '').lastIndexOf(marker);
  if (idx === -1) return null;

  let rest = String(pathname || '').slice(idx + marker.length);
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

  return { date, utcIso };
}

function parseBuildFromHref(href) {
  if (!href) return null;
  try {
    const url = new URL(href, window.location.origin);
    return parseBuildFromPath(url.pathname);
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

function buildLocalLabel({ date, utcIso }) {
  const localTime = formatLocalTimeAmPm(utcIso);
  if (!localTime) return date;
  return `${date} (${localTime})`;
}

function updateBuildTitles() {
  if (!inBrowser) return;

  // Update page H1 for build pages.
  const current = parseBuildFromPath(window.location.pathname);
  if (current) {
    const h1 = document.querySelector('.VPDoc h1');
    if (h1) {
      h1.textContent = buildLocalLabel(current);
    }
  }

  // Update sidebar link labels.
  const sidebarLinks = document.querySelectorAll('.VPSidebar a');
  for (const a of sidebarLinks) {
    const info = parseBuildFromHref(a.getAttribute('href'));
    if (!info) continue;
    a.textContent = buildLocalLabel(info);
  }
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
