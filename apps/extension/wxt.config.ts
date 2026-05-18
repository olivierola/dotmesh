import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Mesh — Your AI memory',
    description: 'Capture, recall and inject personal context into every AI agent. EU-first.',
    version: '0.2.0',
    permissions: ['storage', 'activeTab', 'scripting', 'alarms', 'contextMenus', 'notifications'],
    host_permissions: [
      'https://*.claude.ai/*',
      'https://chatgpt.com/*',
      'https://gemini.google.com/*',
      'https://www.perplexity.ai/*',
    ],
    optional_host_permissions: ['<all_urls>'],
    action: {
      default_title: 'Mesh',
      default_popup: 'popup.html',
    },
    commands: {
      'quick-capture': {
        suggested_key: {
          default: 'Ctrl+Shift+M',
          mac: 'Command+Shift+M',
        },
        description: 'Capture the selected text or current page into Mesh',
      },
      'ask-mesh': {
        suggested_key: {
          default: 'Ctrl+Shift+K',
          mac: 'Command+Shift+K',
        },
        description: 'Open Mesh assistant in a new tab',
      },
    },
  },
});
