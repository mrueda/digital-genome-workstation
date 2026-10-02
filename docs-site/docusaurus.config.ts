import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';

const config: Config = {
  title: 'Digital Genome Workstation',
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
          remarkPlugins: [remarkMath],
          rehypePlugins: [rehypeKatex],
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
          label: 'User guide',
        },
        {
          type: 'docSidebar',
          sidebarId: 'developerSidebar',
          label: 'Developers',
          position: 'left',
        },
        {
          type: 'docSidebar',
          sidebarId: 'projectSidebar',
          label: 'About',
          position: 'left',
        },
        {
          href: 'https://www.youtube.com/playlist?list=PLERpT5T_KiqY',
          label: 'Videos',
          position: 'right',
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
            {label: 'Understand results', to: '/docs/usage/evaluate-alleles'},
            {label: 'Developers', to: '/docs/technical-details/'},
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
