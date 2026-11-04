import { CAL_METHODS } from '../core/fieldcal';
import { bodyName } from '../export/context';
import { MM3_TO_L, fmtLen, fmtVol, plain } from '../core/units';
import { sensorConversion } from './calPanel';
import { h, icon } from './dom';
import type { PanelCtx } from './tankPanel';

export interface GuideActions {
  /** Opens a setup section (shape, dims, wall, install, sensors) and scrolls to it. */
  goTo(section: string): void;
  openExport(): void;
  save(): void;
  fileName(): string | null;
  dirty(): boolean;
}

type Check = { kind: 'ok' | 'warn' | 'todo'; text: string };

interface Step {
  title: string;
  text: string[];
  checks: () => Check[];
  action?: { label: string; run: () => void };
}

/** Step-by-step help with live checks on the current tank. */
export class GuideDialog {
  private dlg: HTMLDialogElement;
  private body = h('div', { class: 'guide-body' });

  constructor(
    private ctx: PanelCtx,
    private actions: GuideActions,
  ) {
    const close = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', on: { click: () => this.dlg.close() } }, icon('close', 18));
    this.dlg = h(
      'dialog',
      { class: 'export-dialog guide-dialog', 'aria-labelledby': 'guide-title' },
      h(
        'div',
        { class: 'export-shell' },
        h(
          'header',
          { class: 'export-head' },
          h(
            'div',
            null,
            h('h2', { id: 'guide-title' }, 'Guide: from tank drawing to calibrated script'),
            h('p', null, 'Follow the steps in order. The checks under each step look at your tank right now.'),
          ),
          close,
        ),
        this.body,
      ),
    );
    this.dlg.addEventListener('click', (e) => {
      if (e.target === this.dlg) this.dlg.close();
    });
    document.body.appendChild(this.dlg);
  }

  open() {
    this.render();
    if (!this.dlg.open) this.dlg.showModal();
  }

  refresh() {
    if (this.dlg.open) this.render();
  }

  private go(section: string) {
    this.dlg.close();
    this.actions.goTo(section);
  }

  private steps(): Step[] {
    const ctx = this.ctx;
    const p = ctx.store.project;
    const d = ctx.derived();
    const lu = p.units.length;
    const vu = p.units.volume;
    const vert = p.tank.orientation === 'vertical';
    const level = d.geoms.filter((g) => g.sensor.enabled && g.mount !== 'point');
    return [
      {
        title: 'Describe the tank shape',
        text: [
          'Start from the Tank library if a tank there looks like yours. Then choose standing (vertical) or lying (horizontal), the body shape, and the shape of each end.',
          vert ? 'For a standing tank the ends are the bottom (footer) and the top (head).' : 'For a lying tank the ends are the left and right ends.',
        ],
        checks: () => [
          { kind: 'ok', text: `Now: ${bodyName(p, d.model).toLowerCase()}, ends: ${d.model.start.meta.label.toLowerCase()} and ${d.model.end.meta.label.toLowerCase()}.` },
        ],
        action: { label: 'Open Tank shape', run: () => this.go('shape') },
      },
      {
        title: 'Type the sizes and check the capacity',
        text: [
          'Choose Outside or Inside, the same as your drawing or tape measure. The straight shell is only the straight part, without the dome or cone.',
          'Compare the capacity with the nameplate or the data sheet. More than 1–2 % difference usually means a size or an end type is wrong.',
        ],
        checks: () => {
          const out: Check[] = [{ kind: 'ok', text: `Capacity ${fmtVol(d.totalL, vu)}, full liquid depth ${fmtLen(d.depth, lu)}.` }];
          for (const pr of d.problems) out.push({ kind: 'warn', text: pr });
          return out;
        },
        action: { label: 'Open Dimensions', run: () => this.go('dims') },
      },
      {
        title: 'Set the walls, tilt and liquid',
        text: [
          'Wall thickness makes the inside smaller and decides where a top sensor sits. Tilt matters for long horizontal tanks. Density matters for pressure sensors.',
        ],
        checks: () => [
          { kind: 'ok', text: `Shell wall ${fmtLen(d.model.t.shell, lu)}, tilt ${plain(d.tilt, 2)}°, density ${plain(p.liquid.density, 1)} kg/m³.` },
        ],
        action: { label: 'Open Wall thickness', run: () => this.go('wall') },
      },
      {
        title: 'Place the sensors',
        text: [
          'Add a Top sensor (ultrasonic, radar, laser) or a Bottom sensor (pressure). Drag it in the top view to the real nozzle position, and set the nozzle height, dead band and range from its data sheet. If the sensor sits on the manhole (hole door) cover, add a Manhole, set its neck height, and choose "On a manhole" for the sensor face height.',
          'Set the output the same as your wiring: digital value, 4–20 mA or voltage, and the ADC if your board digitises it.',
        ],
        checks: () => {
          const out: Check[] = [];
          if (!level.length) out.push({ kind: 'todo', text: 'No level sensor yet. Add one in the Sensors section.' });
          for (const g of d.geoms.filter((x) => x.sensor.enabled)) {
            if (!g.ok) out.push({ kind: 'warn', text: `${g.sensor.tag}: ${g.error}` });
            else if (g.mount === 'point') out.push({ kind: 'ok', text: `${g.sensor.tag}: switch at ${fmtLen(g.faceLevel, lu)}.` });
            else {
              const v0 = d.engine.volume(g.validMin) * MM3_TO_L;
              const v1 = d.engine.volume(g.validMax) * MM3_TO_L;
              const pct = (v: number) => `${plain((100 * v) / d.totalL, 1)} %`;
              out.push({
                kind: g.warnings.length ? 'warn' : 'ok',
                text: `${g.sensor.tag} measures ${fmtLen(g.validMin, lu, false)}–${fmtLen(g.validMax, lu)} = ${pct(v0)}–${pct(v1)} of the volume.${g.warnings.length ? ` ${g.warnings[0]}` : ''}`,
              });
            }
          }
          return out;
        },
        action: { label: 'Open Sensors', run: () => this.go('sensors') },
      },
      {
        title: 'Test in the simulator',
        text: [
          'Drag the sight glass on the right of the 3D view, or press Fill / Drain. Watch each sensor reading and its status: dead band, beam on the floor, out of range.',
          'Turn on Noise to see how much the reading jumps, and use it to choose a filter in your script.',
        ],
        checks: () => [{ kind: 'ok', text: `Simulated level now ${fmtLen(ctx.store.state.sim.level, lu)} = ${fmtVol(d.engine.litres(ctx.store.state.sim.level), vu)}.` }],
      },
      {
        title: 'Calibrate on site (optional, recommended)',
        text: [
          'The drawing is never perfect. Open a sensor card and choose a calibration type: 1-point fixes the zero, 2-point fixes zero and span, multi-point uses a best-fit line through many points.',
          'For each point, write down the true level (dipstick, tape) or the true volume (flow meter, known fill) and the raw value your script reads at the same moment.',
        ],
        checks: () => {
          if (!level.length) return [{ kind: 'todo', text: 'Add a level sensor first.' }];
          return level.map((g) => {
            const s = g.sensor;
            if (s.cal.method === 'theory') return { kind: 'todo', text: `${s.tag}: from the drawing (no field points).` } as Check;
            const c = sensorConversion(ctx, s.id);
            const m = CAL_METHODS.find((x) => x.value === s.cal.method)!;
            if (c?.cal?.active) {
              return { kind: 'ok', text: `${s.tag}: ${m.label}, ${c.cal.residuals.filter((r) => r.used).length} point(s), largest error ${fmtLen(c.cal.maxError, lu)}.` } as Check;
            }
            return { kind: 'warn', text: `${s.tag}: ${m.label} — ${c?.cal?.error ?? 'not applied yet.'}` } as Check;
          });
        },
        action: { label: 'Open Sensors', run: () => this.go('sensors') },
      },
      {
        title: 'Configuration and payload scripts',
        text: [
          'Scripts & table gives the two scripts of the site: Configuration (DEVICE_TANKS: each DevEUI and its sensor number, and the endpoints Distance, level, fill and volume) and Payload (TANKS: each sensor with its tank sizes and height above the inside floor; it decodes each uplink, then level, fill % and volume). The Table tab is the level-to-volume table of the tank you are editing.',
          'Add every tank of the site with + above the 3D view. In Scripts & table, check the number of each sensor, paste the DevEUIs with their sensor number and copy both scripts into the device model. Any ultrasonic or radar sensor works: the payload script finds the model from each uplink. It computes the level as sensorHeight − distance and the volume from the tank sizes, so it gives the same level and volume as the 3D tank.',
        ],
        checks: () => [],
        action: {
          label: 'Open Scripts & table',
          run: () => {
            this.dlg.close();
            this.actions.openExport();
          },
        },
      },
      {
        title: 'Save the project file',
        text: [
          'Save keeps everything in one .tank.json file: shape, sizes, walls, tilt, liquid, levels, sensors, outputs, calibration points, units, the 3D view and the simulated level. Open it later with File → Open, or drop it on the page.',
          'The app also remembers your last tank in this browser, but a file is the safe copy: keep it with the site documents or send it to a colleague.',
        ],
        checks: () => {
          const f = this.actions.fileName();
          if (!f) return [{ kind: 'todo', text: 'Not saved to a file yet.' }];
          return [{ kind: this.actions.dirty() ? 'warn' : 'ok', text: this.actions.dirty() ? `${f}: there are unsaved changes.` : `Saved in ${f}.` }];
        },
        action: {
          label: 'Save now',
          run: () => {
            this.actions.save();
            setTimeout(() => this.refresh(), 300);
          },
        },
      },
    ];
  }

  private render() {
    const steps = this.steps();
    this.body.replaceChildren(
      h(
        'ol',
        { class: 'guide-steps' },
        steps.map((st, i) =>
          h(
            'li',
            { class: 'guide-step' },
            h('span', { class: 'guide-num', 'aria-hidden': 'true' }, String(i + 1)),
            h(
              'div',
              { class: 'guide-content' },
              h('h3', null, st.title),
              st.text.map((t) => h('p', null, t)),
              (() => {
                const checks = st.checks();
                return checks.length
                  ? h(
                      'ul',
                      { class: 'guide-checks' },
                      checks.map((c) => h('li', { class: `check-${c.kind}` }, icon(c.kind === 'ok' ? 'check' : c.kind === 'warn' ? 'warn' : 'plus', 15), h('span', null, c.text))),
                    )
                  : null;
              })(),
              st.action ? h('button', { type: 'button', class: 'btn btn-sm', on: { click: st.action.run } }, st.action.label) : null,
            ),
          ),
        ),
      ),
    );
  }
}
