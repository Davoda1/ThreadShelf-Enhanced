export interface ArchivedImageAsset {
  readonly url: string;
  readonly label?: string;
  readonly source?: string;
}
export interface RenderOptions {
  /** Basic mode retains Markdown but leaves math, diagrams and rich widgets as source. */
  readonly rich?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly assets?: readonly ArchivedImageAsset[];
  readonly collection?: string;
}
/** Mount safe display content; returns cleanup for observers and asynchronous renders. */
export function mountMarkdown(
  container: HTMLElement,
  text: string,
  options?: RenderOptions,
): () => void;
export function configureMarkdownImages(
  container: HTMLElement,
  options: { readonly mode: 'click' | 'auto'; readonly collection?: string },
): void;
