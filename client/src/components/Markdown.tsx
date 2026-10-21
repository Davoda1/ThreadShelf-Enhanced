import { useLayoutEffect, useRef } from 'react';
import { mountMarkdown, type ArchivedImageAsset } from '../enhanced-renderer/renderer.js';
import '../enhanced-renderer/enhanced-markdown.css';

interface MarkdownProps {
  readonly text: string;
  readonly className?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly assets?: readonly ArchivedImageAsset[];
}

/** A transient display adapter: archived source remains untouched for copy/export. */
export function Markdown({ text, className, metadata, assets }: MarkdownProps) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!root.current) return;
    return mountMarkdown(root.current, text, { metadata, assets });
  }, [text, metadata, assets]);
  return (
    <div
      ref={root}
      className={`md-body message-content enhanced-markdown${className ? ` ${className}` : ''}`}
    />
  );
}
