/// <reference lib="dom" />

const softwareKeyboardInputMediaQuery = "(hover: none) and (pointer: coarse)";

export function focusLikelyOpensSoftwareKeyboard(): boolean {
  return window.matchMedia(softwareKeyboardInputMediaQuery).matches;
}

export function softwareKeyboardVisible(
  baselineHeight: number,
  viewportHeight: number,
  textEntryFocused: boolean,
  focusOpensSoftwareKeyboard: boolean,
): boolean {
  const minimumOcclusion = Math.min(120, baselineHeight * 0.2);
  return focusOpensSoftwareKeyboard && textEntryFocused && baselineHeight - viewportHeight >= minimumOcclusion;
}

function isTextEntry(element: Element | null): boolean {
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(element.type);
  return element instanceof HTMLElement && element.isContentEditable;
}

let installed = false;

export function installSoftwareKeyboardTracking(): void {
  if (installed) return;
  installed = true;

  const viewport = window.visualViewport;
  const viewportHeight = (): number => viewport?.height ?? window.innerHeight;
  let baselineHeight = viewportHeight();

  const sync = (): void => {
    const currentViewportHeight = viewportHeight();
    const textEntryFocused = isTextEntry(document.activeElement);
    if (!textEntryFocused) baselineHeight = Math.max(baselineHeight, currentViewportHeight);
    const nextVisible = softwareKeyboardVisible(
      baselineHeight,
      currentViewportHeight,
      textEntryFocused,
      focusLikelyOpensSoftwareKeyboard(),
    );
    const root = document.documentElement;
    root.classList.toggle("software-keyboard-visible", nextVisible);
    if (nextVisible) root.style.setProperty("--software-keyboard-viewport-height", `${currentViewportHeight}px`);
    else root.style.removeProperty("--software-keyboard-viewport-height");
  };

  const resetBaseline = (): void => {
    baselineHeight = viewportHeight();
    sync();
  };

  document.addEventListener("focusin", sync);
  document.addEventListener("focusout", sync);
  (viewport ?? window).addEventListener("resize", sync);
  window.addEventListener("orientationchange", resetBaseline);
  sync();
}
