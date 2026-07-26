/**
 * Login / first-run setup page.
 *
 * Served by the bridge rather than built into the Angular app on purpose: the
 * app would have to be forked to add a login screen, and this page must be
 * reachable *before* the app (and its sync token) is served at all. Styled to
 * match Super Productivity - same font stack, same #6495ED accent, same
 * light/dark surfaces - so it reads as part of the product.
 */

const SP_FONT_STACK = `-apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', Roboto, 'Inter', 'Open Sans', 'Helvetica Neue', Arial, 'Noto Sans', sans-serif`;

export interface LoginPageOptions {
  /** First run: no account exists yet, so ask the admin to create one. */
  isSetup: boolean;
  /** Where to send the browser after success. */
  redirectTo: string;
}

export const renderLoginPage = ({ isSetup, redirectTo }: LoginPageOptions): string => {
  const title = isSetup ? 'Create your account' : 'Sign in';
  const subtitle = isSetup
    ? 'This is the first account for this server - it will be the admin.'
    : 'Super Productivity';
  const action = isSetup ? '/api/auth/setup' : '/api/auth/login';
  const button = isSetup ? 'Create account' : 'Sign in';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · Super Productivity</title>
<style>
  :root {
    --accent: #6495ED;
    --bg: #f8f8f7;
    --surface: #ffffff;
    --text: #131314;
    --muted: #6b6b70;
    --border: #e2e2e0;
    --danger: #f44336;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #131314;
      --surface: #1e1e20;
      --text: #f2f2f0;
      --muted: #9a9aa0;
      --border: #313134;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
    font-family: ${SP_FONT_STACK};
    background: var(--bg); color: var(--text);
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 100%; max-width: 380px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 32px 28px;
    box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.06);
  }
  .mark {
    width: 40px; height: 40px; border-radius: 10px;
    background: var(--accent);
    display: flex; align-items: center; justify-content: center;
    margin-bottom: 20px;
  }
  .mark svg { width: 22px; height: 22px; fill: #fff; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.01em; }
  p.sub { margin: 0 0 24px; color: var(--muted); font-size: 13.5px; line-height: 1.45; }
  label { display: block; font-size: 12.5px; font-weight: 600; margin-bottom: 6px; }
  input {
    width: 100%; padding: 10px 12px; margin-bottom: 16px;
    font: inherit; font-size: 14px;
    color: var(--text); background: var(--bg);
    border: 1px solid var(--border); border-radius: 8px;
    transition: border-color .15s, box-shadow .15s;
  }
  input:focus {
    outline: none; border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
  }
  button {
    width: 100%; padding: 11px 16px;
    font: inherit; font-size: 14px; font-weight: 600;
    color: #fff; background: var(--accent);
    border: 0; border-radius: 8px; cursor: pointer;
    transition: filter .15s;
  }
  button:hover:not(:disabled) { filter: brightness(1.07); }
  button:disabled { opacity: .6; cursor: default; }
  .err {
    display: none; margin: 0 0 16px;
    padding: 10px 12px; border-radius: 8px; font-size: 13px;
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
  }
  .err.show { display: block; }
  .hint { margin: 18px 0 0; font-size: 12px; color: var(--muted); text-align: center; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
  <main class="card">
    <div class="mark" aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
    </div>
    <h1>${title}</h1>
    <p class="sub">${subtitle}</p>

    <div class="err" id="err" role="alert"></div>

    <form id="f" autocomplete="on">
      <label for="u">Username</label>
      <input id="u" name="username" autocomplete="username" required
             autocapitalize="none" spellcheck="false" autofocus>

      <label for="p">Password</label>
      <input id="p" name="password" type="password" required
             autocomplete="${isSetup ? 'new-password' : 'current-password'}">

      <button type="submit" id="b">${button}</button>
    </form>
    ${isSetup ? '<p class="hint">Choose a password of at least 8 characters.</p>' : ''}
  </main>

<script>
  const form = document.getElementById('f');
  const err = document.getElementById('err');
  const btn = document.getElementById('b');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.classList.remove('show');
    btn.disabled = true;
    try {
      const res = await fetch(${JSON.stringify(action)}, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          username: document.getElementById('u').value,
          password: document.getElementById('p').value,
        }),
      });
      if (res.ok) {
        window.location.href = ${JSON.stringify(redirectTo)};
        return;
      }
      const body = await res.json().catch(() => ({}));
      err.textContent = body.error || 'Something went wrong. Try again.';
      err.classList.add('show');
    } catch {
      err.textContent = 'Could not reach the server.';
      err.classList.add('show');
    }
    btn.disabled = false;
  });
</script>
</body>
</html>`;
};
