// Small form pieces for the panels. A field a brick has taken over shows that and can't be edited here: the panel never
// lies about which value is in force.
import React from 'react';
import { useWC } from './store';

export type Field =
  | { k: string; l: string; t: 'n'; min: number; max: number; step?: number; tip?: string }
  | { k: string; l: string; t: 'b'; tip?: string }
  | { k: string; l: string; t: 'c'; tip?: string }
  | { k: string; l: string; t: 's'; o: readonly string[]; labels?: Record<string, string>; tip?: string }
  | { k: string; l: string; t: 'num'; step?: number; tip?: string }
  | { k: string; l: string; t: 'txt'; tip?: string };

export const n = (k: string, l: string, min: number, max: number, step = 0.01, tip?: string): Field => ({ k, l, t: 'n', min, max, step, tip });
export const b = (k: string, l: string, tip?: string): Field => ({ k, l, t: 'b', tip });
export const c = (k: string, l: string, tip?: string): Field => ({ k, l, t: 'c', tip });
export const s = (k: string, l: string, o: readonly string[], labels?: Record<string, string>, tip?: string): Field => ({ k, l, t: 's', o, labels, tip });
export const num = (k: string, l: string, step = 1, tip?: string): Field => ({ k, l, t: 'num', step, tip });

export function Row({ label, tip, children, locked }: { label: string; tip?: string; children: React.ReactNode; locked?: boolean }) {
  return <label className={'wc-row' + (locked ? ' locked' : '')} title={locked ? 'Set by a brick in the logic below. Change it there, or remove the brick.' : tip}><span>{label}</span><div>{children}</div></label>;
}

/** One shared empty value: a new {} on every read would re-render forever. */
export const NO_SOURCES: Record<string, string> = {};

/** Fields of one settings object. `path`: prefix used by bricks ("terrain", "layer:<id>"), for showing what they set. */
export function Fields({ fields, value, set, path }: { fields: Field[]; value: any; set: (k: string, v: any, quiet?: boolean) => void; path?: string }) {
  const sources = useWC((st) => st.run?.sources ?? NO_SOURCES);
  return <>{fields.map((f) => {
    const locked = !!(path && sources[`${path}.${f.k}`]);
    const v = value?.[f.k];
    const dis = locked;
    switch (f.t) {
      case 'n': return <Row key={f.k} label={f.l} tip={f.tip} locked={locked}><span className="wc-slider"><input type="range" disabled={dis} min={f.min} max={f.max} step={f.step} value={Number(v ?? 0)} onChange={(e) => set(f.k, Number(e.target.value), true)} onPointerDown={() => set(f.k, Number(v ?? 0))} /><input type="number" disabled={dis} step={f.step} value={Number(v ?? 0)} onChange={(e) => set(f.k, Number(e.target.value))} /></span></Row>;
      case 'num': return <Row key={f.k} label={f.l} tip={f.tip} locked={locked}><input type="number" disabled={dis} step={f.step} value={Number(v ?? 0)} onChange={(e) => set(f.k, Number(e.target.value))} /></Row>;
      case 'b': return <Row key={f.k} label={f.l} tip={f.tip} locked={locked}><input type="checkbox" disabled={dis} checked={!!v} onChange={(e) => set(f.k, e.target.checked)} /></Row>;
      case 'c': return <Row key={f.k} label={f.l} tip={f.tip} locked={locked}><input type="color" disabled={dis} value={String(v ?? '#ffffff')} onChange={(e) => set(f.k, e.target.value, true)} /></Row>;
      case 's': return <Row key={f.k} label={f.l} tip={f.tip} locked={locked}><select disabled={dis} value={String(v ?? '')} onChange={(e) => set(f.k, e.target.value)}>{f.o.map((o) => <option key={o} value={o}>{f.labels?.[o] ?? o}</option>)}</select></Row>;
      case 'txt': return <Row key={f.k} label={f.l} tip={f.tip} locked={locked}><input type="text" disabled={dis} value={String(v ?? '')} onChange={(e) => set(f.k, e.target.value)} /></Row>;
    }
  })}</>;
}

export function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return <section className="wc-sec"><header><b>{title}</b>{right}</header>{children}</section>;
}
export const Hint = ({ children }: { children: React.ReactNode }) => <p className="wc-hint">{children}</p>;
