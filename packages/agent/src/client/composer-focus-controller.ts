import { focusLikelyOpensSoftwareKeyboard, type WorkspaceClientControllerConstructor } from "@atelier/shared";

/** Keep a tap's target in place until its native click has activated it. */
export function createComposerFocusController(Controller: WorkspaceClientControllerConstructor) {
  return class ComposerFocusController extends Controller {
    preserveInputFocus(event: MouseEvent): void {
      if (!focusLikelyOpensSoftwareKeyboard()) return;
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      const control = event.target.closest("button, a[href]");
      const input = document.activeElement;
      if (!control || !this.element.contains(control) || !(input instanceof HTMLTextAreaElement) || !this.element.contains(input)) return;

      // On iOS, moving focus before click dismisses the keyboard and can move
      // the composer out from under the tap. Cancel only mousedown's focus
      // transfer: native click still submits forms and opens popovers. Do not
      // cancel touch/pointer events (or synthesize clicks), which can suppress
      // WebKit's native activation and interfere with scrolling.
      event.preventDefault();
    }
  };
}
