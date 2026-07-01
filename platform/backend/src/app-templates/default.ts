import type { AppTemplate } from "@/types";

// The one opinionated starter for owned MCP Apps. Pure UI: the platform injects
// the baseline stylesheet (theme variables, themed element defaults — all
// light/dark aware) at render time, so this document carries no full theme. It
// is an empty state: the Archestra mark, the app's name and a prompt-to-build
// call to action, and three cards naming the platform capabilities an app gets
// out of the box — so the user knows what to ask for. The `{{APP_NAME}}` token
// is replaced (HTML-escaped) with the real app name when the app is created
// (resolveCreateAppHtml). The inline SVGs and click handler keep it
// self-contained — no network, so it renders under the app sandbox CSP. The SDK
// contract a model needs to build the app up lives in the build-app skill.
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{{APP_NAME}}</title>
  <!-- Theme variables, themed element defaults and the color palette come from
       the injected platform stylesheet; this starter adds only its own layout. -->
  <style>
    body {
      min-height: 100dvh;
      margin: 0;
      box-sizing: border-box;
      /* Anchored from the top: the top padding seats the block at the optical
         center, a touch above the geometric middle. */
      padding: 16vh 1.5rem 4rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2.5rem;
      text-align: center;
    }
    .logo { background: none; border: 0; padding: 0; cursor: pointer; line-height: 0; }
    .logo svg {
      display: block; width: 80px; height: 80px; border-radius: 16px;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.16);
    }
    .logo.press svg { animation: logo-press 0.11s ease-out; }
    .logo.spin svg { animation: logo-spin 0.5s ease; }
    /* A mechanical key press: a quick depress, then spring back. */
    @keyframes logo-press {
      0%   { transform: translateY(0)    scale(1); }
      50%  { transform: translateY(4px)  scale(0.9); }
      100% { transform: translateY(0)    scale(1); }
    }
    @keyframes logo-spin {
      0%   { transform: rotate(0deg)   scale(1); }
      35%  { transform: rotate(160deg) scale(1.18); }
      100% { transform: rotate(360deg) scale(1); }
    }
    /* The instruction and the list it introduces are one block, set apart from
       the logo (law of proximity). */
    /* Gap here is wider than name-to-CTA but stays under the logo-to-header
       gap (the 2.5rem body gap), preserving the proximity hierarchy. */
    .content { display: flex; flex-direction: column; align-items: center; gap: 2rem; }
    .intro { display: flex; flex-direction: column; align-items: center; gap: 0.75rem; }
    .intro h1 { margin: 0; font-size: 2.5rem; line-height: 1.1; }
    .intro p {
      margin: 0; max-width: 28rem; font-size: 1.05rem; line-height: 1.5;
      color: var(--color-text-secondary);
    }
    /* Left-align the rows so the icons form one column; the list shrinks to the
       widest row and is centered as a block by .content. */
    .features {
      margin: 0; padding: 0; list-style: none;
      display: flex; flex-direction: column; align-items: flex-start; gap: 0.625rem;
    }
    /* Lighter, chrome-free rows: a muted icon + label matching the subheader. */
    .feature { display: flex; align-items: center; gap: 0.75rem; }
    .feature-icon { flex: none; display: flex; color: var(--color-text-secondary); }
    .feature-icon svg { width: 18px; height: 18px; }
    .feature-text strong {
      font-weight: 500; font-size: 1.05rem; color: var(--color-text-secondary);
    }
  </style>
</head>
<body>
  <button type="button" class="logo" aria-label="Archestra">
    <svg width="80" height="80" viewBox="0 0 994 953" xmlns="http://www.w3.org/2000/svg">
      <rect width="993.958" height="952.543" rx="204.92" fill="black"/>
      <path fill-rule="evenodd" clip-rule="evenodd" d="M390.871 664.818C427.68 664.818 460.629 641.985 473.553 607.519L565.238 363.026C586.887 305.296 544.211 243.715 482.556 243.715C445.747 243.715 412.798 266.548 399.874 301.014L308.189 545.507C286.54 603.237 329.216 664.818 390.871 664.818Z" fill="white"/>
      <ellipse cx="638.487" cy="577.095" rx="87.7298" ry="81.1501" fill="white"/>
    </svg>
  </button>
  <div class="content">
    <div class="intro">
      <h1>{{APP_NAME}}</h1>
      <p>To get started, send a&nbsp;prompt describing what you want to&nbsp;build. Your app can use:</p>
    </div>
    <ul class="features">
    <li class="feature">
      <span class="feature-icon">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M13.85 0a4.16 4.16 0 0 0-2.95 1.217L1.456 10.66a.835.835 0 0 0 0 1.18.835.835 0 0 0 1.18 0l9.442-9.442a2.49 2.49 0 0 1 3.541 0 2.49 2.49 0 0 1 0 3.541L8.59 12.97l-.1.1a.835.835 0 0 0 0 1.18.835.835 0 0 0 1.18 0l.1-.098 7.03-7.034a2.49 2.49 0 0 1 3.542 0l.049.05a2.49 2.49 0 0 1 0 3.54l-8.54 8.54a1.96 1.96 0 0 0 0 2.755l1.753 1.753a.835.835 0 0 0 1.18 0 .835.835 0 0 0 0-1.18l-1.753-1.753a.266.266 0 0 1 0-.394l8.54-8.54a4.185 4.185 0 0 0 0-5.9l-.05-.05a4.16 4.16 0 0 0-2.95-1.218c-.2 0-.401.02-.6.048a4.17 4.17 0 0 0-1.17-3.552A4.16 4.16 0 0 0 13.85 0m0 3.333a.84.84 0 0 0-.59.245L6.275 10.56a4.186 4.186 0 0 0 0 5.902 4.186 4.186 0 0 0 5.902 0L19.16 9.48a.835.835 0 0 0 0-1.18.835.835 0 0 0-1.18 0l-6.985 6.984a2.49 2.49 0 0 1-3.54 0 2.49 2.49 0 0 1 0-3.54l6.983-6.985a.835.835 0 0 0 0-1.18.84.84 0 0 0-.59-.245" />
        </svg>
      </span>
      <span class="feature-text">
        <strong>Your connected MCP tools &amp; servers</strong>
      </span>
    </li>
    <li class="feature">
      <span class="feature-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M3 5V19A9 3 0 0 0 21 19V5" />
          <path d="M3 12A9 3 0 0 0 21 12" />
        </svg>
      </span>
      <span class="feature-text">
        <strong>A private + shared data store</strong>
      </span>
    </li>
    <li class="feature">
      <span class="feature-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      </span>
      <span class="feature-text">
        <strong>Built-in AI to summarize &amp; generate</strong>
      </span>
    </li>
    </ul>
  </div>
  <!-- Easter egg: logo presses on click, spins every fifth one. This is starter
       decoration only — remove this script (and the .logo press/spin styles) on
       the first real edit. -->
  <script>
    const logo=document.querySelector(".logo");let clicks=0,spinning=false;logo.addEventListener("click",()=>{if(spinning)return;const move=++clicks%5===0?"spin":"press";if(move==="spin")spinning=true;logo.classList.remove("press","spin");void logo.offsetWidth;logo.classList.add(move)});logo.addEventListener("animationend",e=>{logo.classList.remove("press","spin");if(e.animationName==="logo-spin")spinning=false});
  </script>
</body>
</html>`;

export const defaultTemplate: AppTemplate = {
  id: "default",
  name: "Starter",
  description:
    "A centered empty state showing the app's name and what it can build on.",
  html,
};
