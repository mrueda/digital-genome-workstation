import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {type: 'doc', id: 'overview', label: 'Start here'},
    {type: 'category', label: 'Get started', collapsed: false, items: [
      'usage/installation', 'usage/quickstart', 'usage/input-vcf', 'usage/resources',
    ]},
    {type: 'category', label: 'Work with variants', collapsed: false, items: [
      {type: 'doc', id: 'usage/focused-workspace', label: 'Navigate and select'},
      {type: 'doc', id: 'usage/edit-and-compare', label: 'Edit and compare'},
      'usage/device-guide',
      {type: 'doc', id: 'usage/evaluate-alleles', label: 'Understand results'},
      {type: 'doc', id: 'usage/render-state', label: 'Save and export'},
    ]},
    {type: 'category', label: 'Advanced use', items: ['usage/paper-examples']},
    {type: 'category', label: 'Help', items: [
      'reference/troubleshooting', 'reference/faq', 'reference/evidence-statuses',
    ]},
  ],
  developerSidebar: [
    {type: 'doc', id: 'technical-details/index', label: 'Developers and advanced use'},
    'technical-details/developer-guide', 'technical-details/mcp-server',
    {type: 'category', label: 'How DGW works', items: [
      'technical-details/architecture', 'technical-details/state-model',
      'technical-details/device-api', 'technical-details/evaluation-engine',
      'technical-details/scoring-methods',
    ]},
    {type: 'category', label: 'Data and resources', items: [
      'technical-details/vcf-contract', 'technical-details/project-format',
      'technical-details/resource-bundle',
    ]},
    {type: 'category', label: 'Validation', items: [
      'technical-details/testing', 'usage/test-installation', 'reference/performance',
    ]},
  ],
  projectSidebar: [
    'about/origin-and-development', 'about/roadmap', 'about/citation',
    'about/license', 'about/disclaimer',
  ],
};
export default sidebars;
