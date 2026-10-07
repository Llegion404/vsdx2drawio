// XML helpers shared by browser (native DOMParser) and Node (via xmldom shim in test setup).

export function parseXml(text: string): Document {
  const DP = (globalThis as { DOMParser?: new () => DOMParser }).DOMParser;
  if (!DP) throw new Error('No DOMParser available (Node needs the @xmldom/xmldom shim)');
  const doc = new DP().parseFromString(text, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error('XML parse error: ' + (err.textContent ?? '').slice(0, 200));
  return doc;
}

export function children(el: Element): Element[] {
  if (el.children) return Array.from(el.children);
  return Array.from(el.childNodes).filter(
    (n) => n.nodeType === 1,
  ) as unknown as Element[];
}

export function child(el: Element | null, tag: string): Element | null {
  if (!el) return null;
  for (const c of children(el)) if (c.tagName === tag) return c;
  return null;
}

export function childrenOf(el: Element | null, tag: string): Element[] {
  if (!el) return [];
  return children(el).filter((c) => c.tagName === tag);
}

export function descendants(el: Element | null, tag: string): Element[] {
  if (!el) return [];
  return Array.from(el.getElementsByTagName(tag));
}

export function attr(el: Element, name: string): string | undefined {
  const v = el.getAttribute(name);
  return v === null ? undefined : v;
}

export function numAttr(el: Element, name: string, dflt = 0): number {
  const v = attr(el, name);
  if (v === undefined) return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
