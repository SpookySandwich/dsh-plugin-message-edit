import fs from 'node:fs';

const body = fs.readFileSync(new URL('./plugin.client.js', import.meta.url), 'utf8');
const out = [
  "window.__ModuleLoader__.load({",
  "  id: 'dsh-plugin-message-edit',",
  "  factory: (require) => {",
  "    const React = require('react');",
  "    const styles = {",
  "      insert(css) {",
  "        if (typeof document === 'undefined') return function () {};",
  "        const prev = document.querySelector('style[data-plugin=\"dsh-plugin-message-edit\"]');",
  "        if (prev) {",
  "          prev.textContent = css;",
  "          return function () { prev.remove(); };",
  "        }",
  "        const tag = document.createElement('style');",
  "        tag.dataset.plugin = 'dsh-plugin-message-edit';",
  "        tag.textContent = css;",
  "        document.head.appendChild(tag);",
  "        return function () { tag.remove(); };",
  "      }",
  "    };",
  "    return (function () {",
  body,
  "    })();",
  "  }",
  "});",
  "",
].join('\n');
fs.writeFileSync(new URL('./lib/client.js', import.meta.url), out);
console.log('wrote lib/client.js', out.length);
