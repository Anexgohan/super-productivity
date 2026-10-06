import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import glsl from 'highlight.js/lib/languages/glsl';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import lua from 'highlight.js/lib/languages/lua';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import nginx from 'highlight.js/lib/languages/nginx';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/**
 * Syntax highlighting for the code blocks in a rendered note, loaded only when a note has a block that names a language.
 * Only the languages below are bundled, each with highlight.js's own aliases (ts, js, sh, cs, html, yml, py, ...).
 * A block naming no language or an unknown one stays plain text; guessing the language would cost a full scan of every block.
 */
const LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  glsl,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  makefile,
  markdown,
  nginx,
  php,
  plaintext,
  powershell,
  python,
  ruby,
  rust,
  scss,
  shell,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

for (const [name, language] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, language);
}

/** Highlights every block in `container` that names a bundled language and is not highlighted yet. */
export const highlightCodeIn = (container: HTMLElement): void => {
  const blocks = container.querySelectorAll<HTMLElement>(
    '.code-block code[class*="language-"]:not(.hljs)',
  );
  for (const el of Array.from(blocks)) {
    const language = Array.from(el.classList)
      .find((cls) => cls.startsWith('language-'))
      ?.slice('language-'.length);
    if (!language || !hljs.getLanguage(language)) continue;
    try {
      // highlight.js escapes the text it is given, so its markup is safe to insert after the note filter.
      el.innerHTML = hljs.highlight(el.textContent ?? '', {
        language,
        ignoreIllegals: true,
      }).value;
      el.classList.add('hljs');
    } catch {
      // Leave the block as plain text.
    }
  }
};
