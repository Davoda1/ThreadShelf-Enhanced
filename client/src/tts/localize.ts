import { t } from '../i18n';
const originals = new WeakMap<Node, { source: string; rendered: string }>();
const attributes = new WeakMap<Element, Map<string, { source: string; rendered: string }>>();
/** Only application-owned chrome is localized. Voices, models, source identities,
 * entered passages and provider/user content are excluded explicitly. */
const excluded = (element: Element | null): boolean =>
  !!element?.closest(
    'textarea,input,option,.native-select-value,.tts-pill-label,.tts-test-selection,.tts-cache-entry label',
  );
export function localizeSpeechChrome(root: HTMLElement | null): void {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (excluded(node.parentElement)) continue;
    const value = node.textContent ?? '',
      previous = originals.get(node),
      source = previous?.rendered === value ? previous.source : value;
    const rendered = t(source);
    originals.set(node, { source, rendered });
    if (value !== rendered) node.textContent = rendered;
  }
  for (const option of root.querySelectorAll<HTMLOptionElement>('option[data-tts-ui-label]'))
    option.textContent = t(option.dataset.ttsUiLabel ?? '');
  for (const element of root.querySelectorAll<HTMLElement>('[aria-label],[title],[placeholder]')) {
    if (element.closest('.tts-pill-label,.tts-cache-entry label')) continue;
    let remembered = attributes.get(element);
    if (!remembered) {
      remembered = new Map();
      attributes.set(element, remembered);
    }
    for (const name of ['aria-label', 'title', 'placeholder']) {
      const value = element.getAttribute(name);
      if (value === null) continue;
      const previous = remembered.get(name),
        source = previous?.rendered === value ? previous.source : value,
        rendered = t(source);
      remembered.set(name, { source, rendered });
      if (rendered !== value) element.setAttribute(name, rendered);
    }
  }
}
