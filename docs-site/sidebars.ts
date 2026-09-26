import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {type: 'doc', id: 'overview', label: 'Overview'},
    {
      type: 'category',
      label: 'Use',
      items: [
        {type: 'doc', id: 'usage/installation', label: 'Install DGW'},
        {type: 'doc', id: 'usage/quickstart', label: 'Quick Start'},
        {type: 'doc', id: 'usage/input-vcf', label: 'Choose a VCF & Sample'},
        {type: 'doc', id: 'usage/focused-workspace', label: 'Focused Track Workspace'},
        {type: 'doc', id: 'usage/edit-and-compare', label: 'Tracks, Devices & Edits'},
        {type: 'doc', id: 'usage/device-guide', label: 'Device Guide'},
        {type: 'doc', id: 'usage/evaluate-alleles', label: 'Evaluate Alleles'},
        {type: 'doc', id: 'usage/render-state', label: 'Consolidate & Export'},
      ],
    },
    {
      type: 'category',
      label: 'Technical Details',
      link: {type: 'doc', id: 'technical-details/index'},
      items: [
        {
          type: 'category',
          label: 'Core Model',
          collapsed: false,
          items: [
            {type: 'doc', id: 'technical-details/architecture', label: 'Architecture'},
            {type: 'doc', id: 'technical-details/device-api', label: 'Device API & Resource Packs'},
            {type: 'doc', id: 'technical-details/state-model', label: 'Track, State & Edit Model'},
            {type: 'doc', id: 'technical-details/evaluation-engine', label: 'Evaluation Engine'},
            {type: 'doc', id: 'technical-details/scoring-methods', label: 'Scoring & Evidence Methods'},
          ],
        },
        {
          type: 'category',
          label: 'Data Contracts',
          items: [
            {type: 'doc', id: 'technical-details/vcf-contract', label: 'VCF Contract'},
            {type: 'doc', id: 'technical-details/resource-bundle', label: 'Resource Bundle'},
            {type: 'doc', id: 'technical-details/project-format', label: 'Project Format'},
            {type: 'doc', id: 'technical-details/mcp-server', label: 'Agent Access (MCP)'},
          ],
        },
        {
          type: 'category',
          label: 'Development',
          items: [
            {type: 'doc', id: 'technical-details/developer-guide', label: 'Developer Guide'},
            {type: 'doc', id: 'usage/test-installation', label: 'Installer Validation'},
            {type: 'doc', id: 'technical-details/testing', label: 'Testing'},
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      items: [
        {type: 'doc', id: 'reference/faq', label: 'FAQ'},
        {type: 'doc', id: 'reference/evidence-statuses', label: 'Evidence Statuses'},
        {type: 'doc', id: 'reference/performance', label: 'Performance'},
        {type: 'doc', id: 'reference/troubleshooting', label: 'Troubleshooting'},
      ],
    },
    {
      type: 'category',
      label: 'About',
      items: [
        {type: 'doc', id: 'about/origin-and-development', label: 'Origin & Development'},
        {type: 'doc', id: 'about/roadmap', label: 'Roadmap'},
        {type: 'doc', id: 'about/citation', label: 'Citation'},
        {type: 'doc', id: 'about/disclaimer', label: 'Disclaimer'},
        {type: 'doc', id: 'about/license', label: 'License'},
      ],
    },
  ],
};

export default sidebars;
