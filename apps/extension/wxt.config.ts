import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    build: {
      // Escape all non-ASCII characters in the bundle. Chrome's content-script
      // loader rejects files containing certain Unicode codepoints (notably
      // U+FFFF used by Dexie as a range sentinel) with a misleading
      // "not encoded in UTF-8" error. Forcing ASCII output sidesteps that.
      target: 'es2020',
    },
    esbuild: {
      charset: 'ascii',
    },
  }),
  manifest: {
    name: 'Mesh - Your AI memory',
    description: 'Capture, recall and inject personal context into every AI agent. EU-first.',
    version: '0.3.0',
    permissions: ['storage', 'activeTab', 'scripting', 'alarms', 'contextMenus', 'notifications'],
    host_permissions: [
      // Mesh web app itself — needed by the auth-bridge content script.
      'https://dotmesh.vercel.app/*',
      'http://localhost:5173/*',
      // Anthropic / OpenAI / Google / Perplexity (original four).
      'https://*.claude.ai/*',
      'https://chatgpt.com/*',
      'https://chat.openai.com/*',
      'https://gemini.google.com/*',
      'https://www.perplexity.ai/*',
      // Mistral, xAI, Microsoft, DeepSeek, Phind, You, Poe, Hugging Face,
      // Cohere, Inflection, Character.AI, v0, Lovable, Bolt.
      'https://chat.mistral.ai/*',
      'https://grok.com/*',
      'https://x.com/*',
      'https://copilot.microsoft.com/*',
      'https://m365.cloud.microsoft/*',
      'https://chat.deepseek.com/*',
      'https://www.phind.com/*',
      'https://you.com/*',
      'https://poe.com/*',
      'https://huggingface.co/*',
      'https://coral.cohere.com/*',
      'https://pi.ai/*',
      'https://character.ai/*',
      'https://v0.dev/*',
      'https://lovable.dev/*',
      'https://bolt.new/*',
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
