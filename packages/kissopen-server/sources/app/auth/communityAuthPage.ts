import { createHash } from 'node:crypto';

// Official outlined wordmark, vendored from brand/lockup/svg/
// kissopen-lockup-horizontal-inverse.svg. No fonts or network requests required.
const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 174.9938 20.7813" width="174.9938" height="20.7813" role="img" aria-label="KISSOPEN">
  <title>KISSOPEN</title>
  <!-- KISSOPEN 横排锁定 · inverse · 标志与字标均按墨迹外缘计量 · 字标已转曲（Chakra Petch 600） -->
  <g fill="#9184D9" stroke="#9184D9" stroke-width="5" stroke-linejoin="round" stroke-linecap="round" transform="translate(-8.0156 -8.6094) scale(0.5938)">
    <path d="M16 17 L26 29 L26 35 L16 47 Z"/>
    <path d="M48 17 L38 29 L38 35 L48 47 Z"/>
  </g>
  <g transform="translate(34.2188 19.1406) scale(1 -1)" fill="#1B1D29">
    <path d="M1.75 17.5L4.65 17.5L4.65 9.975L7.775 9.975L12.1 17.5L15.325 17.5L10.25 8.775L15.75 0L12.45 0L7.775 7.475L4.65 7.475L4.65 0L1.75 0ZM21.375 17.5L24.275 17.5L24.275 0L21.375 0ZM31.025 2.575L31.025 4.775L33.875 4.775L33.875 3.45L34.825 2.5L40.275 2.5L41.275 3.5L41.275 6.725L40.3 7.7L33.65 7.7L31.075 10.25L31.075 14.925L33.65 17.5L41.35 17.5L43.925 14.925L43.925 12.7L41.075 12.7L41.075 14.05L40.1 15L34.9 15L33.925 14.05L33.925 11.15L34.9 10.2L41.55 10.2L44.125 7.625L44.125 2.625L41.5 0L33.6 0ZM50.25 2.575L50.25 4.775L53.1 4.775L53.1 3.45L54.05 2.5L59.5 2.5L60.5 3.5L60.5 6.725L59.525 7.7L52.875 7.7L50.3 10.25L50.3 14.925L52.875 17.5L60.575 17.5L63.15 14.925L63.15 12.7L60.3 12.7L60.3 14.05L59.325 15L54.125 15L53.15 14.05L53.15 11.15L54.125 10.2L60.775 10.2L63.35 7.625L63.35 2.625L60.725 0L52.825 0Z"/>
  </g>
  <g transform="translate(100.8188 19.1406) scale(1 -1)" fill="#9184D9">
    <path d="M1.5 2.825L1.5 14.675L4.325 17.5L12.975 17.5L15.8 14.675L15.8 2.825L12.975 0L4.325 0ZM11.475 2.5L12.9 3.9L12.9 13.6L11.475 15L5.825 15L4.4 13.6L4.4 3.9L5.825 2.5ZM22.55 17.5L33.2 17.5L35.75 14.925L35.75 8.975L33.175 6.375L25.45 6.375L25.45 0L22.55 0ZM31.9 8.825L32.9 9.825L32.9 14.05L31.9 15.05L25.45 15.05L25.45 8.825ZM42 17.5L54.2 17.5L54.2 15.025L44.9 15.025L44.9 10.025L53.475 10.025L53.475 7.575L44.9 7.575L44.9 2.475L54.2 2.475L54.2 0L42 0ZM60.45 17.5L63.1 17.5L71.35 4.775L71.4 4.775L71.4 17.5L74.175 17.5L74.175 0L71.525 0L63.275 12.7L63.225 12.7L63.225 0L60.45 0Z"/>
  </g>
</svg>`;

const styles = `
:root {
    color-scheme: light dark;
    --ground: #F3F5FE;
    --surface: #FFFFFF;
    --ink: #1B1D29;
    --muted: #606477;
    --line: #E5E6F0;
    --accent: #9184D9;
    --tint: #F1EEFB;
    --button: #262A60;
    --button-ink: #F3F5FE;
}
* { box-sizing: border-box; }
body {
    margin: 0;
    min-height: 100vh;
    min-height: 100svh;
    display: grid;
    place-items: center;
    padding: 32px 20px;
    background: var(--ground);
    color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
}
main { width: 100%; max-width: 460px; text-align: center; }
.card {
    padding: 44px 36px 32px;
    border: 1px solid var(--line);
    border-radius: 24px;
    background: var(--surface);
    box-shadow: 0 12px 40px rgb(38 42 96 / 5%);
}
.brand { display: flex; justify-content: center; margin-bottom: 36px; }
.brand > svg { width: 184px; height: auto; }
.brand > svg > g:nth-of-type(2) { fill: var(--ink); }
.status {
    width: 64px;
    height: 64px;
    display: grid;
    place-items: center;
    margin: 0 auto 24px;
    border-radius: 50%;
    background: var(--tint);
    color: var(--button);
}
.status > svg { width: 28px; height: 28px; }
h1 { margin: 0; font-size: 28px; font-weight: 650; line-height: 1.35; letter-spacing: -.5px; }
.subtitle { margin: 8px 0 24px; font-size: 14px; color: var(--muted); }
.description { margin: 0; font-size: 15px; line-height: 1.8; }
.translation { margin: 12px 0 28px; font-size: 13px; line-height: 1.7; color: var(--muted); }
.button {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 10px;
    min-height: 48px;
    padding: 12px 20px;
    border-radius: 12px;
    background: var(--button);
    color: var(--button-ink);
    text-decoration: none;
    font-size: 15px;
    font-weight: 600;
    transition: transform .16s ease, opacity .16s ease;
}
.button > svg { width: 18px; height: 18px; }
.button:hover { opacity: .9; }
.button:active { transform: translateY(1px); }
.button:focus-visible { outline: 3px solid var(--accent); outline-offset: 4px; }
.hint { margin: 16px 0 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
footer { margin-top: 24px; color: var(--muted); font-size: 12px; letter-spacing: .3px; }
@media (max-width: 480px) {
    body { padding: 24px 16px; }
    .card { padding: 36px 24px 28px; border-radius: 20px; }
    h1 { font-size: 25px; }
}
@media (prefers-color-scheme: dark) {
    :root {
        --ground: #161826;
        --surface: #202231;
        --ink: #E9E9ED;
        --muted: #ABAEC1;
        --line: #343648;
        --tint: #30304A;
        --button: #C2B8F0;
        --button-ink: #1B1D29;
    }
    .status { color: var(--accent); }
    .card { box-shadow: none; }
}
@media (prefers-reduced-motion: reduce) {
    .button { transition: none; }
}
`;

// Permit this exact stylesheet only; keep scripts, external resources and framing blocked.
export const communityAuthPageCsp = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(styles).digest('base64')}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

type CompletionStatus = 'success' | 'failed' | 'expired';
const messages: Record<CompletionStatus, { title: string; subtitle: string; description: string; translation: string; hint: string }> = {
    success: {
        title: '授权完成',
        subtitle: 'Authorization complete',
        description: '请回到刚才的 KissOpen 窗口继续登录。<br>现在可以关闭此页面。',
        translation: 'Return to your KissOpen window to finish signing in.<br>You can close this page.',
        hint: '桌面端用户请切回应用 · Desktop users: return to the app',
    },
    failed: {
        title: '登录未完成',
        subtitle: 'Sign-in not completed',
        description: '授权已取消或暂时无法完成。<br>请返回 KissOpen，重新发起登录。',
        translation: 'Authorization was cancelled or could not be completed.<br>Return to KissOpen and try signing in again.',
        hint: '可以重试，也可以选择其他登录方式',
    },
    expired: {
        title: '登录链接已失效',
        subtitle: 'Sign-in link expired',
        description: '此登录链接已过期或不再有效。<br>请返回 KissOpen，重新发起登录。',
        translation: 'This sign-in link has expired or is no longer valid.<br>Return to KissOpen to start a new sign-in.',
        hint: '请使用新发起的登录页面，不要刷新旧链接',
    },
};

const icon = (path: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;

/** Static copy only: never reflect codes, provider errors, tokens or redirect URLs. */
export function communityAuthCompletionPage(status: CompletionStatus): string {
    const message = messages[status];
    const statusIcon = status === 'success' ? 'm5 12 4 4L19 6' :
        status === 'expired' ? 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18' : 'm7 7 10 10M17 7 7 17';
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${message.title} · KissOpen</title>
<style>${styles}</style>
</head>
<body>
<main>
    <section class="card" aria-labelledby="result-title">
        <div class="brand">${logo}</div>
        <div class="status">${icon(statusIcon)}</div>
        <h1 id="result-title">${message.title}</h1>
        <p class="subtitle" lang="en">${message.subtitle}</p>
        <p class="description">${message.description}</p>
        <p class="translation" lang="en">${message.translation}</p>
        <a class="button" href="/" rel="noreferrer">返回 KissOpen ${icon('M5 12h14m-6-6 6 6-6 6')}</a>
        <p class="hint">${message.hint}</p>
    </section>
    <footer>安全授权 · <span lang="en">Secure sign-in</span></footer>
</main>
</body>
</html>`;
}

