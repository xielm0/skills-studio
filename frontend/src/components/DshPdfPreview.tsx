import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import css from './DshPdfPreview.module.css';

GlobalWorkerOptions.workerSrc = workerUrl;

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function PdfPage({ document, number, zoom }: { document: PDFDocumentProxy; number: number; zoom: number }) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(number === 1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element || visible) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    }, { rootMargin: '100% 0px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    const element = host.current;
    const target = canvas.current;
    if (!element || !target || !visible) return;
    let cancelled = false;
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | null = null;
    const render = async () => {
      try {
        const page = await document.getPage(number);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const scale = Math.max(0.1, (element.clientWidth / base.width) * zoom);
        const viewport = page.getViewport({ scale });
        const pixelRatio = window.devicePixelRatio || 1;
        target.width = Math.ceil(viewport.width * pixelRatio);
        target.height = Math.ceil(viewport.height * pixelRatio);
        target.style.width = `${viewport.width}px`;
        target.style.height = `${viewport.height}px`;
        const context = target.getContext('2d');
        if (!context) return;
        renderTask = page.render({ canvas: target, canvasContext: context, viewport, transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] });
        await renderTask.promise;
      } catch (cause) {
        if (!cancelled && !(cause instanceof Error && cause.name === 'RenderingCancelledException')) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    };
    void render();
    return () => { cancelled = true; renderTask?.cancel(); };
  }, [document, number, visible, zoom]);

  return <div className={css.page} ref={host}>
    {error ? <p className={css.status}>第 {number} 页无法显示：{error}</p> : null}
    <canvas className={css.canvas} ref={canvas} aria-label={`第 ${number} 页`} />
  </div>;
}

export function DshPdfPreview({ base64 }: { base64: string }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    let cancelled = false;
    const task = getDocument({ data: decodeBase64(base64) });
    void task.promise.then((loaded) => {
      if (cancelled) return;
      setDocument(loaded);
      setError(null);
    }, (cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; void task.destroy(); };
  }, [base64]);

  if (error) return <p className={css.status}>PDF 预览失败：{error}</p>;
  if (!document) return <p className={css.status}>正在读取 PDF…</p>;
  return <div className={css.root} data-pdf-preview>
    <div className={css.toolbar}>
      <span>{document.numPages} 页</span>
      <span className={css.spacer} />
      <button type="button" onClick={() => setZoom((value) => Math.max(0.5, +(value - 0.25).toFixed(2)))} aria-label="缩小">−</button>
      <button type="button" onClick={() => setZoom(1)} aria-label="适合宽度">{Math.round(zoom * 100)}%</button>
      <button type="button" onClick={() => setZoom((value) => Math.min(3, +(value + 0.25).toFixed(2)))} aria-label="放大">+</button>
    </div>
    <div className={css.scroll}>
      {Array.from({ length: document.numPages }, (_, index) => <PdfPage key={index + 1} document={document} number={index + 1} zoom={zoom} />)}
    </div>
  </div>;
}
