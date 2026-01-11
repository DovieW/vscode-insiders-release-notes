import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitepress';

function groupBuildPages() {
  const buildsDir = join(process.cwd(), 'docs', 'builds');
  if (!existsSync(buildsDir)) return [];

  const files = readdirSync(buildsDir)
    .filter((f) => f.endsWith('.md') && f !== 'index.md')
    .filter((f) => f.includes('-insider'))
    // newest-first if filenames start with YYYY-MM-DD
    .sort((a, b) => b.localeCompare(a));

  const groups = new Map();
  for (const f of files) {
    const slug = f.replace(/\.md$/, '');
    const parts = slug.split('_');
    const versionPart = parts.find((p) => /\d+\.\d+\.\d+-insider/.test(p)) || 'Other';
    const minor = versionPart === 'Other' ? 'Other' : versionPart.split('.').slice(0, 2).join('.');

    if (!groups.has(minor)) groups.set(minor, []);
    groups.get(minor).push({
      text: slug,
      link: `/builds/${slug}`,
    });
  }

  const order = Array.from(groups.keys()).sort((a, b) => (a === 'Other' ? 1 : b === 'Other' ? -1 : b.localeCompare(a)));
  return order.map((minor) => ({
    text: minor,
    collapsed: minor !== order[0],
    items: groups.get(minor),
  }));
}

export default defineConfig({
  // Repo Pages: https://username.github.io/repo/
  base: '/vscode-insiders-release-notes/',
  // Keep legacy one-off pages from being built/deployed.
  srcExclude: [
    'builds/2026-01-09_f8edfb1-1c97a46.md',
  ],
  lang: 'en-US',
  title: 'Insiders Changelog',
  description: 'Per-build changelog pages for VS Code Insiders',

  themeConfig: {
    siteTitle: 'Insiders Changelog',
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Builds', link: '/builds/' },
      { text: 'GitHub', link: 'https://github.com/DovieW/vscode-insiders-release-notes' },
    ],

    sidebar: {
      '/builds/': [
        { text: 'Builds', items: [{ text: 'Index', link: '/builds/' }] },
        ...groupBuildPages(),
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/DovieW/vscode-insiders-release-notes' },
    ],
  },
});
