import { lazy, Suspense, useMemo } from 'react';
import { MarkdownText } from '../vendor/dsh-primitives/markdown/MarkdownText';
import { CodeBlock } from '../vendor/dsh-primitives/markdown/CodeBlock';
import { FrontmatterFields } from '../vendor/dsh-viewer/frontmatter-fields';
import { splitFrontmatter } from '../vendor/dsh-viewer/frontmatter';
import { languageForPath } from '../vendor/dsh-viewer/code-language';
import '../vendor/dsh-theme/base.css';
import '../vendor/dsh-theme/design-platform.css';
import '../vendor/dsh-theme/gradient-shadow-text.css';
import '../vendor/dsh-theme/shiki.css';
import css from './DshDocumentViewer.module.css';
import markdownCss from '../vendor/dsh-viewer/MarkdownBody.module.css';
import codeCss from '../vendor/dsh-viewer/CodeBody.module.css';

export interface PreviewDocument {
  relPath: string;
  content: string | null;
  base64: string | null;
  mediaType: string | null;
}

const labels = {
  code: {
    copyLabel: '复制',
    copiedLabel: '已复制',
    toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '不换行' },
  },
  footnotes: '脚注',
};

const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif']);
const DshPdfPreview = lazy(() => import('./DshPdfPreview').then((module) => ({ default: module.DshPdfPreview })));

function extension(path: string): string {
  return path.split('/').pop()?.split('.').pop()?.toLowerCase() ?? '';
}

export function DshDocumentViewer({ document, mode = 'rendered', wrap = false }: {
  document: PreviewDocument;
  mode?: 'rendered' | 'code' | 'plain';
  wrap?: boolean;
}) {
  const ext = extension(document.relPath);
  const sourceUrl = useMemo(() => document.base64 && document.mediaType
    ? `data:${document.mediaType};base64,${document.base64}`
    : null, [document.base64, document.mediaType]);

  if (imageExtensions.has(ext) && sourceUrl) {
    return <div className={css.media}><img className={css.image} src={sourceUrl} alt={document.relPath} /></div>;
  }
  if (ext === 'pdf' && sourceUrl) {
    return <Suspense fallback={<p className={css.unavailable}>正在读取 PDF…</p>}><DshPdfPreview base64={document.base64!} /></Suspense>;
  }
  if (document.content === null) return <p className={css.unavailable}>该文件暂无可用预览。</p>;

  if (mode === 'plain') return <pre className={css.plain} data-wrap={wrap}>{document.content}</pre>;

  if ((ext === 'md' || ext === 'markdown') && mode === 'rendered') {
    const split = splitFrontmatter(document.content);
    return <div className={`${css.scroll} ${markdownCss.document}`} data-document-markdown>
      {split ? <div className={markdownCss.frontmatter}>
        <FrontmatterFields source={split.source} fallback={<pre className={markdownCss.frontmatterSource}>{split.source}</pre>} />
      </div> : null}
      <MarkdownText text={split?.body ?? document.content} labels={labels} />
    </div>;
  }
  if ((ext === 'html' || ext === 'htm' || ext === 'xhtml') && mode === 'rendered') {
    return <iframe className={css.html} srcDoc={document.content} sandbox="" title={document.relPath} />;
  }
  return <div className={codeCss.renderer} data-code-preview data-wrap={wrap}>
    <CodeBlock
      className={codeCss.code}
      code={document.content}
      lang={languageForPath(document.relPath)}
      lineNumbers
      wrap={wrap}
      copyLabel="复制"
      copiedLabel="已复制"
      toolbarLabels={{ codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '不换行' }}
    />
  </div>;
}
