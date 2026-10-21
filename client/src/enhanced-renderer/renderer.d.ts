export interface ArchivedImageAsset { readonly url: string; readonly label?: string; readonly source?: string; }
export interface RenderOptions {
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly assets?: readonly ArchivedImageAsset[];
}
/** Mount safe display content; returns cleanup for observers and asynchronous renders. */
export function mountMarkdown(container: HTMLElement, text: string, options?: RenderOptions): () => void;
