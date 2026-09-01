import { escapeHtml } from "@atelier/shared";
import { attributesHtml, classNames, htmlContent, type HtmlContent } from "../html.ts";

interface PerimeterButtonOptions<State extends string> {
  component: "activity-button" | "progress-button";
  state: State;
  states: ReadonlyArray<{ name: State; content: HtmlContent }>;
  className?: string;
  attributesHtml?: string;
  ownedAttributesHtml?: string;
  type?: "button" | "submit";
  disabled?: boolean;
  id?: string;
}

/** Internal renderer for buttons whose alternate states share a stable perimeter and width. */
export function perimeterButtonHtml<State extends string>(options: PerimeterButtonOptions<State>): string {
  const stateName = options.component.replace("-button", "");
  const id = options.id ? ` id="${escapeHtml(options.id)}"` : "";
  const className = escapeHtml(classNames("button", options.className, options.component));
  const disabled = options.disabled ? " disabled" : "";
  const perimeterPart = options.component === "activity-button" ? "indicator" : "perimeter";
  const perimeter = `<svg class="${options.component}__${perimeterPart}" aria-hidden="true"><rect pathLength="100"/></svg>`;
  const contents = options.states.map(({ name, content }) => `<span class="${options.component}__content" data-${stateName}-content="${escapeHtml(name)}">${htmlContent(content)}</span>`).join("");

  return `<button${id} class="${className}" type="${options.type ?? "button"}" data-${stateName}-state="${escapeHtml(options.state)}"${disabled}${attributesHtml(options.ownedAttributesHtml)}${attributesHtml(options.attributesHtml)}>${perimeter}${contents}</button>`;
}
