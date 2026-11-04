import { h } from './dom';

let host: HTMLElement | null = null;
let timer = 0;

/** Short status message at the bottom of the screen, with an optional action. */
export function toast(message: string, action?: { label: string; run: () => void }, ms = 3600): void {
  if (!host) {
    host = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(host);
  }
  clearTimeout(timer);
  const btn = action
    ? h(
        'button',
        {
          type: 'button',
          class: 'toast-action',
          on: {
            click: () => {
              action.run();
              host?.replaceChildren();
            },
          },
        },
        action.label,
      )
    : null;
  host.replaceChildren(h('div', { class: 'toast' }, h('span', null, message), btn));
  timer = window.setTimeout(() => host?.replaceChildren(), action ? ms + 2400 : ms);
}
