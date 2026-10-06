import DOMPurify from 'dompurify';
import { ALLOWED_EXTERNAL_URL_SCHEMES } from '../../../../electron/shared-with-frontend/is-external-url-allowed';

/**
 * The HTML filter for every rendered note, replacing Angular's fixed allowlist so the fork decides what notes may contain.
 * Notes are not only the user's own text: shared boards show other accounts' notes, and agents write notes through the API.
 * So script, event handlers, frames and forms never pass.
 * `style` is refused too, because it lets a note lay a fake screen (a sign-in box, an invisible click target) over the whole app.
 * Ids pass but are prefixed `user-content-`, so a note can link to its own footnotes without shadowing the page's ids or globals.
 */

/** Its own instance: Mermaid uses the default DOMPurify instance with its own hooks and config, and must not share ours. */
const purify = DOMPurify(window);

const SCHEMES = [...ALLOWED_EXTERNAL_URL_SCHEMES, 'blob:']
  .map((scheme) => scheme.slice(0, -1).replace(/[.+-]/g, '\\$&'))
  .join('|');

/** Allowed schemes, or a URL with no scheme at all (relative paths and `#fragment` links). */
const ALLOWED_URI = new RegExp(
  `^(?:(?:${SCHEMES}):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))`,
  'i',
);

export const sanitizeNoteHtml = (html: string): string =>
  purify.sanitize(html, {
    ADD_ATTR: ['target', 'loading'],
    FORBID_TAGS: [
      'style',
      'form',
      'input',
      'textarea',
      'select',
      'option',
      'iframe',
      'frame',
      'object',
      'embed',
    ],
    FORBID_ATTR: ['style'],
    ALLOWED_URI_REGEXP: ALLOWED_URI,
    SANITIZE_NAMED_PROPS: true,
  });

export const NOTE_ID_PREFIX = 'user-content-';
