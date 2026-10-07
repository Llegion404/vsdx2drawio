import { unzipSync } from 'fflate';
import { parseXml, children } from './xml';

export interface OpcRel {
  id: string;
  type: string;
  target: string; // resolved absolute part path
  targetMode?: string;
}

export class OpcPackage {
  private parts: Map<string, Uint8Array>;
  private relsCache = new Map<string, OpcRel[]>();

  constructor(parts: Map<string, Uint8Array>) {
    this.parts = parts;
  }

  static read(data: Uint8Array): OpcPackage {
    const files = unzipSync(data);
    const parts = new Map<string, Uint8Array>();
    for (const [name, content] of Object.entries(files)) {
      if (!name.endsWith('/')) parts.set(name, content);
    }
    return new OpcPackage(parts);
  }

  has(part: string): boolean {
    return this.parts.has(norm(part));
  }

  bytes(part: string): Uint8Array {
    const p = this.parts.get(norm(part));
    if (!p) throw new Error(`Missing OPC part: ${part}`);
    return p;
  }

  text(part: string): string {
    return new TextDecoder('utf-8').decode(this.bytes(part));
  }

  partNames(): string[] {
    return [...this.parts.keys()].sort();
  }

  /** Relationship targets declared by `part` (pass '' or '/' for package root). */
  rels(part: string): OpcRel[] {
    const key = norm(part);
    const cached = this.relsCache.get(key);
    if (cached) return cached;

    const baseDir = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '';
    const relsPath =
      key === '' || key === '/' ? '_rels/.rels' : `${baseDir}/_rels/${key.split('/').pop()}.rels`;

    const out: OpcRel[] = [];
    if (this.parts.has(relsPath)) {
      const doc = parseXml(this.text(relsPath));
      for (const r of children(doc.documentElement)) {
        if (r.tagName !== 'Relationship') continue;
        const target = r.getAttribute('Target') ?? '';
        const mode = r.getAttribute('TargetMode') ?? undefined;
        out.push({
          id: r.getAttribute('Id') ?? '',
          type: (r.getAttribute('Type') ?? '').replace(/^.*\//, ''),
          target: mode === 'External' ? target : resolvePath(baseDir, target),
          targetMode: mode,
        });
      }
    }
    this.relsCache.set(key, out);
    return out;
  }

  relTarget(part: string, relId: string): string | undefined {
    return this.rels(part).find((r) => r.id === relId)?.target;
  }
}

function norm(p: string): string {
  return p.replace(/^\//, '');
}

function resolvePath(baseDir: string, target: string): string {
  if (target.startsWith('/')) return norm(target);
  const segs = (baseDir ? baseDir.split('/') : []).concat(target.split('/'));
  const out: string[] = [];
  for (const s of segs) {
    if (s === '' || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return out.join('/');
}
