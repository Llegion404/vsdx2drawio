// vsdx2drawio web app: client-side .vsdx/.vssx -> editable draw.io conversion.
// No network calls: files are read with the File API and converted in-page.

import './style.css';
import { CONFIG } from './config';
import { OpcPackage } from './vsdx/opc';
import { buildScene, buildMasterScenes } from './vsdx/model';
import { emitDrawio, type DrawioStats } from './drawio/emitter';
import { emitSvg } from './svg/emitter';

const dropzone = document.getElementById('dropzone') as HTMLElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const statusEl = document.getElementById('status') as HTMLElement;
const statusText = document.getElementById('status-text') as HTMLElement;
const resultsEl = document.getElementById('results') as HTMLElement;
const fileTitle = document.getElementById('file-title') as HTMLElement;
const pageTabs = document.getElementById('page-tabs') as HTMLElement;
const preview = document.getElementById('preview') as HTMLElement;
const statsLine = document.getElementById('stats-line') as HTMLElement;
const ctaEl = document.getElementById('cta') as HTMLElement;
const downloadDrawio = document.getElementById('download-drawio') as HTMLButtonElement;
const downloadSvg = document.getElementById('download-svg') as HTMLButtonElement;

// Funnel event hook: no-op unless Cloudflare beacon analytics is deployed.
declare global {
  interface Window {
    // cloudflare beacon auto-tracks pageviews; funnel events go through a stub
    vsdx2drawioEvent?: (name: string, detail?: unknown) => void;
  }
}
// Funnel wiring: CTA visible only with a configured waitlist URL; Cloudflare
// beacon injected when a token is set; ?exp=N selects the price wording variant.
{
  if (CONFIG.waitlistUrl && !CONFIG.waitlistUrl.startsWith('PLACEHOLDER')) {
    (document.getElementById('waitlist-link') as HTMLAnchorElement).href = CONFIG.waitlistUrl;
  } else {
    (document.querySelector('.cta-btn') as HTMLElement).style.display = 'none';
  }
  const exp = new URLSearchParams(location.search).get('exp');
  if (exp !== null && CONFIG.priceVariants[Number(exp)]) {
    const priceEl = document.getElementById('price-wording');
    if (priceEl) priceEl.textContent = CONFIG.priceVariants[Number(exp)];
  }
  // Open-source footer links (AGPL-3.0 · source · donations)
  const ossLine = document.getElementById('oss-line');
  if (ossLine && !CONFIG.repoUrl.startsWith('PLACEHOLDER')) {
    ossLine.hidden = false;
    (document.getElementById('repo-link') as HTMLAnchorElement).href = CONFIG.repoUrl;
    const donate = document.getElementById('donate-link') as HTMLAnchorElement;
    if (CONFIG.donateUrl && !CONFIG.donateUrl.startsWith('PLACEHOLDER')) donate.href = CONFIG.donateUrl;
    else (donate.parentElement as HTMLElement).lastChild?.remove();
  }
  if (CONFIG.cfBeaconToken) {
    const s = document.createElement('script');
    s.defer = true;
    s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
    s.setAttribute('data-cf-beacon', JSON.stringify({ token: CONFIG.cfBeaconToken }));
    document.head.appendChild(s);
  }
}

const track = (name: string, detail?: unknown) => window.vsdx2drawioEvent?.(name, detail);

interface Converted {
  fileName: string;
  drawioXml: string;
  pages: { name: string; svg: string }[];
  stats: DrawioStats[];
  warnings: string[];
}

let current: Converted | null = null;
let currentPage = 0;

// ---------- conversion ----------

function convert(fileName: string, data: ArrayBuffer): Converted {
  const pkg = OpcPackage.read(new Uint8Array(data));
  let scene;
  try {
    scene = buildScene(pkg);
  } catch (e) {
    if (String((e as Error).message).includes('No pages part')) {
      scene = buildMasterScenes(pkg);
    } else throw e;
  }
  if (scene.pages.reduce((a, p) => a + p.shapes.length, 0) === 0) {
    scene = buildMasterScenes(pkg);
  }
  const { xml, stats } = emitDrawio(scene);
  return {
    fileName,
    drawioXml: xml,
    pages: scene.pages.map((p) => ({ name: p.name, svg: emitSvg(p) })),
    stats,
    warnings: scene.warnings,
  };
}

function showStatus(text: string, isError = false): void {
  statusEl.hidden = false;
  statusEl.classList.toggle('error', isError);
  statusText.textContent = text;
}

function showResults(r: Converted): void {
  current = r;
  currentPage = 0;
  resultsEl.hidden = false;
  ctaEl.hidden = false;
  fileTitle.textContent = r.fileName;
  const totalForeign = r.stats.reduce((a, s) => a + s.foreign, 0);
  statsLine.textContent =
    `${r.pages.length} page${r.pages.length === 1 ? '' : 's'} · ` +
    r.stats
      .map((s, i) => {
        const shapes = s.vertex + s.group + s.edge;
        const bits = [`${shapes} shapes`];
        if (s.stencil) bits.push(`${s.stencil} vector paths`);
        if (s.foreign) bits.push(`${s.foreign} images`);
        return `page ${i + 1}: ${bits.join(', ')}`;
      })
      .join(' · ');
  if (totalForeign > 0) void totalForeign; // surfaced via per-page stats line

  pageTabs.innerHTML = '';
  // Many-page files (stencil packs): cap visible tabs with a <select> beyond 12.
  if (r.pages.length > 12) {
    const sel = document.createElement('select');
    sel.id = 'page-select';
    r.pages.forEach((p, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = p.name || `Page ${i + 1}`;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      currentPage = Number(sel.value);
      renderPage();
    });
    pageTabs.appendChild(sel);
  } else {
    r.pages.forEach((p, i) => {
      const b = document.createElement('button');
      b.textContent = p.name || `Page ${i + 1}`;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(i === currentPage));
      b.addEventListener('click', () => {
        currentPage = i;
        renderPage();
      });
      pageTabs.appendChild(b);
    });
  }
  renderPage();
}

function renderPage(): void {
  if (!current) return;
  const sel = pageTabs.querySelector('select');
  if (sel instanceof HTMLSelectElement) {
    sel.value = String(currentPage);
  } else {
    [...pageTabs.children].forEach((c, i) => c.setAttribute('aria-selected', String(i === currentPage)));
  }
  preview.innerHTML = current.pages[currentPage].svg;
  preview.scrollTop = 0;
}

function download(content: string | Blob, mime: string, name: string): void {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

downloadDrawio.addEventListener('click', () => {
  if (!current) return;
  const base = current.fileName.replace(/\.(vsdx|vssx|vstx)$/i, '');
  download(current.drawioXml, 'application/xml', `${base}.drawio`);
  track('export_drawio');
});

downloadSvg.addEventListener('click', () => {
  if (!current) return;
  const base = current.fileName.replace(/\.(vsdx|vssx|vstx)$/i, '');
  download(current.pages[currentPage].svg, 'image/svg+xml', `${base}-p${currentPage + 1}.svg`);
  track('export_svg');
});

// ---------- file intake ----------

async function handleFile(file: File): Promise<void> {
  showStatus(`Converting ${file.name}…`);
  resultsEl.hidden = true;
  ctaEl.hidden = true;
  try {
    const data = await file.arrayBuffer();
    const r = convert(file.name, data);
    track('convert_success', { pages: r.pages.length });
    const skipped = r.stats.reduce((a, s) => a + s.skipped, 0);
    showStatus(
      `✅ Converted ${file.name} — ${r.pages.length} page${r.pages.length === 1 ? '' : 's'}.` +
        (skipped ? ` ${skipped} non-image embedded object(s) (OLE/WMF) skipped.` : ' Everything below is editable in draw.io.'),
    );
    showResults(r);
  } catch (e) {
    track('convert_error');
    showStatus(`❌ Could not convert ${file.name}: ${(e as Error).message}`, true);
  }
}

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') fileInput.click();
});
fileInput.addEventListener('change', () => {
  if (fileInput.files?.[0]) handleFile(fileInput.files[0]);
  fileInput.value = '';
});
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  const f = e.dataTransfer?.files?.[0];
  if (f) handleFile(f);
});

// Waitlist CTA click tracking
const waitlist = document.getElementById('waitlist-link') as HTMLAnchorElement;
waitlist.addEventListener('click', () => track('waitlist_click'));
