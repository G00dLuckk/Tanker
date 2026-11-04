import type { Store } from '../app/store';
import { h, icon } from './dom';

export interface TankBarActions {
  select(index: number): void;
  /** Adds a tank: a copy of the one being edited, or a blank one. */
  add(copy: boolean): void;
  remove(index: number): void;
  /** Fits the 3D view to every tank on the site. */
  showAll(): void;
}

/** The tanks of the site: pick the one to edit, add, copy and remove tanks. */
export class TankBar {
  readonly el: HTMLElement;
  private list = h('div', { class: 'tank-chips', role: 'group', 'aria-label': 'Tanks on this site' });

  constructor(
    private store: Store,
    private actions: TankBarActions,
  ) {
    const add = h('button', { type: 'button', class: 'tool-btn', title: 'Add a blank tank', 'aria-label': 'Add a blank tank', on: { click: () => actions.add(false) } }, icon('plus', 17));
    const copy = h('button', { type: 'button', class: 'tool-btn', title: 'Add a copy of this tank', 'aria-label': 'Add a copy of this tank', on: { click: () => actions.add(true) } }, icon('duplicate', 17));
    const all = h('button', { type: 'button', class: 'tool-btn', title: 'Show every tank', 'aria-label': 'Show every tank', on: { click: () => actions.showAll() } }, icon('iso', 17));
    this.el = h('div', { class: 'tank-bar' }, this.list, h('div', { class: 'tool-group' }, add, copy, all));
    this.render();
  }

  render() {
    const st = this.store.state;
    const many = st.tanks.length > 1;
    this.list.replaceChildren(
      ...st.tanks.map((p, i) => {
        const active = i === st.active;
        const chip = h(
          'button',
          {
            type: 'button',
            class: 'tank-chip',
            'aria-pressed': String(active),
            title: active ? `${p.name}: the tank you are editing` : `Edit ${p.name}`,
            on: { click: () => this.actions.select(i) },
          },
          h('span', { class: 'tank-chip-no' }, String(i + 1)),
          h('span', { class: 'tank-chip-name' }, p.name),
        );
        if (!active || !many) return chip;
        const remove = h('button', { type: 'button', class: 'tank-chip-remove', title: `Remove ${p.name} from the site`, 'aria-label': `Remove ${p.name}`, on: { click: () => this.actions.remove(i) } }, icon('close', 13));
        return h('span', { class: 'tank-chip-wrap' }, chip, remove);
      }),
    );
    // On narrow screens the list scrolls: keep the tank being edited in view.
    requestAnimationFrame(() => {
      const on = this.list.querySelector<HTMLElement>('.tank-chip[aria-pressed="true"]');
      if (!on || this.list.scrollWidth <= this.list.clientWidth) return;
      const box = (on.parentElement?.classList.contains('tank-chip-wrap') ? on.parentElement : on) as HTMLElement;
      const left = box.offsetLeft - this.list.offsetLeft;
      if (left < this.list.scrollLeft || left + box.offsetWidth > this.list.scrollLeft + this.list.clientWidth) this.list.scrollLeft = Math.max(0, left - 4);
    });
  }
}
