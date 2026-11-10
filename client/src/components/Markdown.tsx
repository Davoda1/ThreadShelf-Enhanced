import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  mountMarkdown,
  configureMarkdownImages,
  type ArchivedImageAsset,
} from '../enhanced-renderer/renderer.js';
import { setRendererLocale } from '../enhanced-renderer/locale.js';
import { useUIStore } from '../store';
import { jsonResponseMarkdown } from '../json-response.js';
import { queryHighlightRegex, splitHighlightedText } from '../utils';
import '../enhanced-renderer/enhanced-markdown.css';

interface MarkdownProps {
  readonly text: string;
  readonly className?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly raw?: unknown;
  readonly assets?: readonly ArchivedImageAsset[];
  readonly role?: 'user' | 'thinking' | 'ai';
  readonly collapsed?: boolean;
  readonly collection?: string;
  /** Search targets and live responses may render immediately. */
  readonly eager?: boolean;
  /** Keep search-hit emphasis when a raw JSON match is displayed as code. */
  readonly codeHighlightQuery?: string;
}

function highlightCodeMatches(root: HTMLElement, query: string) {
  const regex = queryHighlightRegex(query);
  if (!regex) return;
  for (const code of root.querySelectorAll('pre code')) {
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    for (const node of nodes) {
      if (!regex.test(node.data)) continue;
      const fragment = document.createDocumentFragment();
      for (const part of splitHighlightedText(node.data, query)) {
        if (regex.test(part)) {
          const mark = document.createElement('mark');
          mark.textContent = part;
          fragment.append(mark);
        } else fragment.append(document.createTextNode(part));
      }
      node.replaceWith(fragment);
    }
  }
}

/** A jump to later content must stay put when an earlier preview grows. */
function preserveFollowingContent(root: HTMLElement): (() => void) | undefined {
  let scroller = root.parentElement;
  while (scroller) {
    if (
      /(auto|scroll)/.test(getComputedStyle(scroller).overflowY) &&
      scroller.scrollHeight > scroller.clientHeight
    )
      break;
    scroller = scroller.parentElement;
  }
  if (!scroller) return;
  const viewport = scroller.getBoundingClientRect();
  const before = root.getBoundingClientRect();
  if (before.top >= viewport.top) return;
  let branch: Element = root;
  while (!branch.nextElementSibling && branch.parentElement && branch.parentElement !== scroller)
    branch = branch.parentElement;
  let anchor = branch.nextElementSibling;
  // Continuation groups use display:contents; anchor an actual rendered child.
  while (anchor && !anchor.getClientRects().length) {
    anchor =
      Array.from(anchor.querySelectorAll('*')).find((element) => element.getClientRects().length) ||
      anchor.nextElementSibling;
  }
  if (!anchor) return;
  const top = anchor.getBoundingClientRect().top;
  // Preserve already-visible following content, not an unseen part farther down
  // the conversation when the user is reading inside the current message.
  if (top >= viewport.bottom && before.bottom > viewport.top) return;
  const scrollParent = scroller;
  return () => {
    if (anchor.isConnected) scrollParent.scrollTop += anchor.getBoundingClientRect().top - top;
  };
}

/** A transient display adapter: archived source remains untouched for copy/export. */
export function Markdown({
  text,
  className,
  metadata,
  raw,
  assets,
  role: messageRole,
  collapsed = false,
  eager = false,
  collection,
  codeHighlightQuery,
}: MarkdownProps) {
  const role = messageRole ?? 'ai';
  const root = useRef<HTMLDivElement>(null);
  const restoreScroll = useRef<(() => void) | undefined>(undefined);
  const locale = useUIStore((state) => state.locale);
  const rich = useUIStore((state) => state.richRendering[role]);
  const imageLoadMode = useUIStore((state) => state.imageLoadMode);
  const display = useUIStore((state) => state.conversationDisplay);
  const [nearViewport, setNearViewport] = useState(false);
  const ready = eager || nearViewport || typeof IntersectionObserver === 'undefined';
  // Rendering a clipped 100,000-character reply still used to build its entire
  // math/diagram DOM. A bounded Markdown preview avoids that hidden work.
  const preview = text.length > 1800 ? `${text.slice(0, 1800)}…` : text;
  const source = collapsed ? preview : text;
  // Only conversation messages opt in. Note editors and other Markdown users
  // keep their existing interpretation; the original message is never changed.
  const displayed = useMemo(
    () =>
      ready && messageRole && display.jsonAsCode
        ? (jsonResponseMarkdown(source, role) ?? source)
        : source,
    [ready, messageRole, display.jsonAsCode, source, role],
  );

  useEffect(() => {
    if (ready || !root.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          if (root.current) restoreScroll.current = preserveFollowingContent(root.current);
          setNearViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin: '320px 0px' },
    );
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [ready]);

  useLayoutEffect(() => {
    if (!root.current || !ready) return;
    setRendererLocale(locale);
    const unmount = mountMarkdown(root.current, displayed, {
      metadata,
      raw,
      assets: collapsed ? undefined : assets,
      rich: rich && !collapsed,
      collection,
      codeDownloads: display.codeDownloads && !collapsed,
      codeWrap: display.codeWrap,
      codeLineNumbers: display.codeLineNumbers,
    });
    if (codeHighlightQuery) highlightCodeMatches(root.current, codeHighlightQuery);
    restoreScroll.current?.();
    restoreScroll.current = undefined;
    return unmount;
  }, [
    displayed,
    metadata,
    raw,
    assets,
    rich,
    locale,
    collapsed,
    ready,
    collection,
    display.codeDownloads,
    display.codeWrap,
    display.codeLineNumbers,
    codeHighlightQuery,
  ]);
  useLayoutEffect(() => {
    if (root.current && ready)
      configureMarkdownImages(root.current, {
        mode: collapsed ? 'click' : imageLoadMode,
        collection,
      });
  }, [displayed, metadata, assets, rich, locale, collapsed, ready, collection, imageLoadMode]);
  return (
    <div
      ref={root}
      className={`md-body message-content enhanced-markdown${className ? ` ${className}` : ''}`}
      data-render-mode={rich && !collapsed ? 'rich' : 'basic'}
      data-render-state={ready ? 'mounted' : 'deferred'}
      data-render-preview={collapsed || undefined}
    >
      {!ready ? <span className="markdown-deferred-preview">{preview}</span> : null}
    </div>
  );
}
