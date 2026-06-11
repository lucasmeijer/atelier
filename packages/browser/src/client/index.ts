/// <reference lib="dom" />

type StimulusControllerConstructor = new (...args: unknown[]) => { element: Element };

export function createBrowserPaneController(Controller: StimulusControllerConstructor): unknown {
  return class BrowserPaneController extends Controller {
    declare readonly element: HTMLElement;
  };
}

export function createBrowserAddressController(Controller: StimulusControllerConstructor): unknown {
  return class BrowserAddressController extends Controller {
    declare readonly element: HTMLFormElement;

    submit(): void {
      const input = this.element.querySelector<HTMLInputElement>(".browser-address-input");
      if (!input) return;
      input.value = normalizeBrowserInput(input.value);
    }
  };
}

function normalizeBrowserInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "http://localhost:3000";
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `http://${trimmed}`;
}
