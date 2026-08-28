import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'DGW Docs',
  tagline: 'Build genome tracks without changing the source VCF',
  favicon: 'img/dgw-mark.svg',
  url: 'https://mrueda.github.io',
  baseUrl: '/digital-genome-workstation/',
  organizationName: 'mrueda',
  projectName: 'digital-genome-workstation',
  onBrokenLinks: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },
  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          routeBasePath: 'docs',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],
  themes: [
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        language: ['en'],
        indexDocs: true,
        indexBlog: false,
        docsRouteBasePath: '/docs',
      },
    ],
  ],
  themeConfig: {
    image: 'img/dgw-state-flow.svg',
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'DGW',
      logo: {
        alt: 'Digital Genome Workstation',
        src: 'img/dgw-mark.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          to: '/docs/usage/quickstart',
          label: 'Quick Start',
          position: 'left',
        },
        {
          to: '/docs/usage/edit-and-compare',
          label: 'Tracks & Devices',
          position: 'left',
        },
        {
          href: 'https://github.com/mrueda/digital-genome-workstation',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {label: 'Overview', to: '/docs/overview'},
            {label: 'Quick Start', to: '/docs/usage/quickstart'},
            {label: 'Input VCF', to: '/docs/usage/input-vcf'},
            {label: 'Evidence Stack', to: '/docs/usage/evaluate-alleles'},
            {label: 'Troubleshooting', to: '/docs/reference/troubleshooting'},
          ],
        },
        {
          title: 'Project',
          items: [
            {label: 'Repository', href: 'https://github.com/mrueda/digital-genome-workstation'},
            {label: 'Roadmap', to: '/docs/about/roadmap'},
            {label: 'Citation', to: '/docs/about/citation'},
            {label: 'License', to: '/docs/about/license'},
          ],
        },
      ],
      copyright: 'Copyright (C) 2026 Manuel Rueda.',
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
