/** Search by id. Each entry co-locates WHEN, contract, imports and executable examples.
 * page.ts renders these functions AND displays their source: no parallel demo markup.
 * Native CSS primitives intentionally do not have pass-through renderers. */
import { buttonHtml } from "../src/button/button-html.ts";
import { actionLinkHtml } from "../src/action-link/action-link-html.ts";
import { buttonGroupHtml } from "../src/button-group/button-group-html.ts";
import { actionItemHtml } from "../src/action-item/action-item-html.ts";
import { activityButtonHtml } from "../src/activity-button/activity-button-html.ts";
import { progressButtonHtml } from "../src/progress-button/progress-button-html.ts";
import { copyButtonHtml } from "../src/copy-button/copy-button-html.ts";
import { destructiveConfirmationHtml } from "../src/destructive-confirmation/destructive-confirmation-html.ts";
import { dialogHtml } from "../src/dialog/dialog-html.ts";
import { panelHtml } from "../src/panel/panel-html.ts";
import { popupHtml } from "../src/popup/popup-html.ts";
import { toggleHtml } from "../src/toggle/toggle-html.ts";
import { autocompleteHtml } from "../src/autocomplete/autocomplete-html.ts";
import { transientFeedbackHtml } from "../src/transient-feedback/transient-feedback-html.ts";
import { warningBannerHtml } from "../src/warning-banner/warning-banner-html.ts";
import { Icons } from "../src/icons/icons-html.ts";

export interface CatalogueEntry {
  id: string;
  title: string;
  when: string;
  contract: string;
  imports?: Record<string, string>;
  sources?: string[];
  /** Compare the same specimen with and without the popular group marker. */
  compareButtonSizes?: boolean;
  examples: { title: string; render: (idSuffix?: string) => string }[];
}
export const entries: CatalogueEntry[] = [
  {
    id: "warning-banner", title: "Warning banner",
    when: "Persistent, non-blocking problems or configuration notices that need user attention.",
    contract: "Title and message are escaped text. Optional actionsHtml composes server-rendered actions. Supplying dismiss adds an × and destructive confirmation; the feature owns the POST action and opaque state token, persistence, and Turbo replacement. Dismissal does not resolve the condition.",
    imports: { "warning-banner": "warningBannerHtml" },
    sources: ["warning-banner/warning-banner-html.ts", "warning-banner/warning-banner.css"],
    examples: [{ title: "Missing configuration", render: () => `<div data-action="submit->catalogue#submit">${warningBannerHtml({ title: "Required secrets need values", message: "Your workspace can run, but features needing these secrets may not work.", dismiss: { action: "/catalogue/warnings/dismiss", state: "example" } })}<output aria-live="polite"></output></div>` }],
  },
  {
    id: "markdown",
    title: "Markdown",
    when: "Rendered Markdown in user and assistant messages, file previews, or other rich-text surfaces.",
    contract: "Apply markdown to the rendered-content container. It styles semantic HTML without rendering or sanitizing it. Set --markdown-block-spacing to customize paragraph, list and blockquote spacing; the default is 12px. Enhanced code blocks, media and table-scroll wrappers remain owned by their feature.",
    sources: ["markdown/markdown.css"],
    examples: [{
      title: "Shared typography · lists and nested content",
      render: () => '<div class="markdown"><h3>Review checklist</h3><p>Run <code>bun run check</code> before continuing.</p><ol><li>Review the changes.<ul><li>Check list indentation.</li><li>Check wrapping on narrow screens.</li></ul></li><li>Report the result.</li></ol><blockquote><p>Shared formatting, regardless of author.</p></blockquote><pre><code>bun run check</code></pre><p><a href="#markdown">Markdown reference</a></p></div>',
    }],
  },
  {
    id: "foundations",
    title: "Foundations & composition",
    when: "Role tokens and shared layout primitives, not a second set of component sizes.",
    contract:
      "Use --bg, --panel, --elev, --text, --text-bright, --text-muted, --accent, --success, --warning and --danger by semantic role. Theme is data-theme on the root. Typography uses --font-sans / --font-mono, --text-body / --text-title / --text-code. title supplies visual heading style, not heading semantics. form-stack, form-section, form-actions, action-list, work-view-toolbar and empty-state own composition spacing. viewport-overlay bounds browser-owned overlays.",
    sources: ["design-system.css"],
    examples: [
      {
        title: "Semantic colors · title · form spacing",
        render: () =>
          '<div class="form-stack"><h3 class="title">A consistent visual title</h3><div class="catalogue-swatches">' +
          [
            "accent",
            "success",
            "warning",
            "danger",
            "text-bright",
            "text",
            "text-muted",
          ]
            .map(
              (role) =>
                `<span style="color:var(--${role})"><span class="status-dot" style="color:inherit" aria-hidden="true"></span> ${role}</span>`,
            )
            .join("") +
          '</div><div class="form-section"><span>Fields in a form section</span><span>Share a smaller gap than sections.</span></div></div>',
      },
    ],
  },
  {
    id: "button",
    compareButtonSizes: true,
    title: "Button",
    when: "An action, not navigation. Primary for the main action, secondary for supporting actions, danger for destructive actions.",
    contract:
      "Choose caption OR icon-only with a mandatory accessible label. On narrow screens (≤700px) or coarse pointers, regular icon-only controls are 42.5px with 17.85px icons. Add data-popular-button to a button (via attributesHtml) or containing group for 62.5px controls and 26.25px icons. Popular caption buttons also have a 62.5px minimum height; ordinary caption buttons are unchanged. Desktop popular sizes are fixed: 38.24px icon controls with 20.59px icons, and 36.93px minimum-height caption controls with 18.38px icons. Native type and disabled are explicit. Do not add classes or override component anatomy via attributesHtml.",
    imports: { button: "buttonHtml", icons: "Icons" },
    sources: ["button/button-content.ts"],
    examples: [
      {
        title: "Icon-only · grouped icon and caption",
        render: () =>
          buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Plus, label: "Add item" } }) +
          buttonGroupHtml({
            semantics: "group", label: "Quick actions", orientation: "horizontal",
            itemsHtml: buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Plus, label: "Add grouped item" } }) +
              buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "/quick-launch" } }),
          }),
      },
      {
        title: "Variants · disabled · icon-only · long caption",
        render: () =>
          buttonHtml({
            type: "button",
            variant: "primary",
            content: { kind: "caption", caption: "Primary" },
          }) +
          buttonHtml({
            type: "button",
            variant: "secondary",
            content: { kind: "caption", caption: "Secondary" },
          }) +
          buttonHtml({
            type: "button",
            variant: "danger",
            content: { kind: "caption", caption: "Danger" },
          }) +
          buttonHtml({
            type: "button",
            variant: "secondary",
            disabled: true,
            content: { kind: "caption", caption: "Unavailable" },
          }) +
          buttonHtml({
            type: "button",
            variant: "secondary",
            content: {
              kind: "icon-only",
              iconHtml: Icons.Plus,
              label: "Add item",
            },
          }) +
          buttonHtml({
            type: "button",
            variant: "secondary",
            content: {
              kind: "caption",
              caption: "A deliberately long translated action caption",
            },
          }),
      },
    ],
  },
  {
    id: "action-link",
    compareButtonSizes: true,
    title: "Action link",
    when: "Navigation that deserves button emphasis. Use normal links for prose.",
    contract:
      "A native anchor: href is navigation, never a click handler masquerading as navigation. No disabled links. Same content and variants as Button. Icon-only links may use perimeterComparison: referencePercent and valuePercent (0–100) share one ring clockwise from twelve. Their overlap is neutral; reference beyond value is green, value beyond reference is red. A dim full-circle track preserves the button outline, including at zero. Include both values and their meaning in the accessible label; focus has a separate outline.",
    imports: { "action-link": "actionLinkHtml" },
    examples: [
      {
        title: "Navigate to popup examples",
        render: () =>
          actionLinkHtml({
            href: "#popup",
            variant: "secondary",
            content: { kind: "caption", caption: "Explore Popup" },
          }),
      },
      {
        title: "Comparison ring · behind, ahead, equal, zero, full and unavailable",
        render: () => buttonGroupHtml({ orientation: "horizontal", semantics: "group", label: "Comparison ring states", itemsHtml: [
          { referencePercent: 75, valuePercent: 40 },
          { referencePercent: 40, valuePercent: 75 },
          { referencePercent: 50, valuePercent: 50 },
          { referencePercent: 0, valuePercent: 0 },
          { referencePercent: 100, valuePercent: 100 },
          undefined,
        ].map((comparison) => actionLinkHtml({ href: "#action-link", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Usage, label: comparison ? `Time ${comparison.referencePercent}%, Usage ${comparison.valuePercent}%` : "Usage unavailable" }, perimeterComparison: comparison })).join("") }),
      },
    ],
  },
  {
    id: "button-group",
    compareButtonSizes: true,
    title: "Button group",
    when: "Related actions sharing horizontal or vertical spacing. For mutually exclusive values, use Toggle.",
    contract:
      "Use semantics: group with a label for a meaningful group; layout for spacing only. Wrapping forms are allowed in itemsHtml.",
    imports: { "button-group": "buttonGroupHtml", button: "buttonHtml" },
    examples: [
      {
        title: "Vertical group · caption · icon-only · wrapped form",
        render: () => buttonGroupHtml({
          orientation: "vertical",
          semantics: "group",
          label: "Workspace actions",
          itemsHtml:
            buttonHtml({ type: "button", variant: "primary", content: { kind: "caption", caption: "Open workspace" } }) +
            activityButtonHtml({
              variant: "secondary", iconOnly: true, state: "active",
              initialLabel: "Start", activeLabel: "Stop",
              initialContent: { kind: "html", html: Icons.Agent },
              activeContent: { kind: "html", html: Icons.Close },
              attributesHtml: 'data-action="catalogue#activity"',
            }) +
            '<form data-action="submit->catalogue#submit">' +
            buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Save workspace" } }) +
            '<output aria-live="polite"></output></form>',
        }),
      },
      {
        title: "Horizontal action group",
        render: () =>
          buttonGroupHtml({
            orientation: "horizontal",
            semantics: "group",
            label: "Editing actions",
            itemsHtml:
              buttonHtml({
                type: "button",
                variant: "primary",
                content: { kind: "caption", caption: "Save" },
              }) +
              buttonHtml({
                type: "button",
                variant: "secondary",
                content: { kind: "caption", caption: "Cancel" },
              }),
          }),
      },
    ],
  },
  {
    id: "action-item",
    compareButtonSizes: true,
    title: "Action item",
    when: "Rows in menus, navigation, trees and action lists. Use compound when a row has separately actionable trailing controls.",
    contract:
      "Choose native buttons or anchors for actions. Caller owns roles, href/type, selection and integration attributes. Never nest buttons. Single rows retain their content spacing with primary: false, without gaining primary-action styling. Labels and descriptions are plain text. leadingHtml and trailingHtml fill bounded icon/status and metadata slots; neither can replace the label anatomy. tone: danger is the semantic destructive treatment. Long labels reveal on engagement.",
    imports: {
      "action-item": "actionItemHtml",
      "copy-button": "copyButtonHtml",
    },
    examples: [
      {
        title: "Single · semantic · disabled · compound long label",
        render: () =>
          '<div class="action-list">' +
          actionItemHtml({
            kind: "single",
            element: { tag: "button", attributesHtml: 'type="button"' },
            label: { kind: "text", text: "Open workspace" },
          }) +
          actionItemHtml({
            kind: "single",
            primary: false,
            element: { tag: "div" },
            leadingHtml: '<span class="status-dot running" aria-label="In progress"></span>',
            label: { kind: "text", text: "Reading workspace files" },
            description: "Non-interactive single row with the same content spacing.",
            trailingHtml: "In progress",
          }) +
          actionItemHtml({
            kind: "single",
            element: {
              tag: "button",
              attributesHtml: 'type="button" disabled',
            },
            label: { kind: "text", text: "Unavailable action" },
          }) +
          actionItemHtml({
            kind: "compound",
            primary: { tag: "a", attributesHtml: 'href="#action-item"' },
            label: {
              kind: "text",
              text: "A very long record name that needs to remain readable inside a narrow container",
            },
            engagedActionsHtml: copyButtonHtml({
              label: "Copy record name",
              copyText: "Long record name",
            }),
          }) +
          "</div>",
      },
    ],
  },
  {
    id: "activity-button",
    compareButtonSizes: true,
    title: "Activity button",
    when: "A running operation that can still be stopped. For uninterruptible operations use Progress button.",
    contract:
      "Both captions participate in sizing. Active is busy but NOT disabled. Render state on the server or use activity-button/client for browser-owned operations.",
    imports: { "activity-button": "activityButtonHtml" },
    sources: ["activity-button/activity-button-client.ts"],
    examples: [
      {
        title: "Long caption · stable width across states",
        render: () => activityButtonHtml({
          variant: "secondary",
          state: "active",
          initialContent: { kind: "text", text: "Start preparing the development workspace" },
          activeContent: { kind: "text", text: "Stop preparing the development workspace" },
          attributesHtml: 'data-action="catalogue#activity"',
        }),
      },
      {
        title: "Grouped activity and progress perimeters",
        render: () =>
          buttonGroupHtml({
            semantics: "group",
            label: "Running actions",
            orientation: "horizontal",
            itemsHtml:
              activityButtonHtml({
                variant: "primary",
                iconOnly: true,
                state: "active",
                initialLabel: "Start agent",
                activeLabel: "Stop agent",
                initialContent: { kind: "html", html: Icons.Agent },
                activeContent: { kind: "html", html: Icons.Close },
                attributesHtml: 'data-action="catalogue#activity"',
              }) +
              progressButtonHtml({
                variant: "secondary",
                iconOnly: true,
                state: "in-progress",
                initialLabel: "Start processing",
                progressLabel: "Processing",
                initialContent: { kind: "html", html: Icons.Refresh },
                progressContent: { kind: "html", html: Icons.Refresh },
              }),
          }),
      },
      {
        title: "Initial and active",
        render: () =>
          activityButtonHtml({
            variant: "primary",
            state: "initial",
            initialContent: { kind: "text", text: "Start" },
            activeContent: { kind: "text", text: "Stop operation" },
            attributesHtml: 'data-action="catalogue#activity"',
          }) +
          activityButtonHtml({
            variant: "primary",
            state: "active",
            initialContent: { kind: "text", text: "Start" },
            activeContent: { kind: "text", text: "Stop operation" },
            attributesHtml: 'data-action="catalogue#activity"',
          }),
      },
    ],
  },
  {
    id: "progress-button",
    compareButtonSizes: true,
    title: "Progress button",
    when: "An operation whose action must not be invoked again while running.",
    contract:
      "In-progress always disables the control. Omit progress for indeterminate; otherwise use a finite number from 0 to 100. Server-render new states with Turbo.",
    imports: { "progress-button": "progressButtonHtml" },
    examples: [
      {
        title: "Icon-only · initial · indeterminate · 0% · 50% · 100%",
        render: () =>
          (["initial", undefined, 0, 50, 100] as const).map((progress) =>
            progressButtonHtml({
              variant: "primary",
              iconOnly: true,
              state: progress === "initial" ? "initial" : "in-progress",
              progress: progress === "initial" ? undefined : progress,
              initialLabel: "Install",
              progressLabel: progress === "initial" || progress === undefined ? "Installing" : `Installing ${progress}%`,
              initialContent: { kind: "html", html: Icons.ArrowDown },
              progressContent: { kind: "html", html: Icons.ArrowDown },
            }),
          ).join(""),
      },
      {
        title: "Long caption · stable width across states",
        render: () => progressButtonHtml({
          variant: "secondary",
          state: "in-progress",
          progress: 50,
          initialContent: { kind: "text", text: "Install all dependencies for this workspace" },
          progressContent: { kind: "text", text: "Installing all dependencies for this workspace…" },
        }),
      },
      {
        title: "Indeterminate · 0% · 50% · 100%",
        render: () =>
          [undefined, 0, 50, 100]
            .map((progress) =>
              progressButtonHtml({
                variant: "primary",
                state: "in-progress",
                progress,
                initialContent: { kind: "text", text: "Install" },
                progressContent: {
                  kind: "text",
                  text:
                    progress === undefined
                      ? "Installing…"
                      : `Installing ${progress}%`,
                },
              }),
            )
            .join(""),
      },
    ],
  },
  {
    id: "copy-button",
    compareButtonSizes: true,
    title: "Copy button",
    when: "Copy a known value, with automatic transient success feedback.",
    contract:
      "Provide label and copyText; caption is optional. Clipboard needs a secure context and permission. Errors are not presented as success. Try copying, then paste into Text entry.",
    imports: { "copy-button": "copyButtonHtml" },
    examples: [
      {
        title: "Long caption · initial and copied feedback",
        render: () => copyButtonHtml({
          label: "Copy workspace setup command",
          caption: "Copy the complete workspace setup command",
          copyText: "bun run web",
        }),
      },
      {
        title: "Icon-only and caption",
        render: () =>
          copyButtonHtml({
            label: "Copy example",
            copyText: "Copied from Atelier design system",
          }) +
          copyButtonHtml({
            label: "Copy command",
            caption: "Copy command",
            copyText: "bun run web",
          }),
      },
    ],
  },
  {
    id: "destructive-confirmation",
    compareButtonSizes: true,
    title: "Destructive confirmation",
    when: "An inline two-step destructive form action. Use Dialog for explanations or additional input.",
    contract:
      "Place inside a form. Initial button arms; confirm submits (optionally overriding the action); cancel disarms. This demo intercepts submission and announces the result.",
    imports: { "destructive-confirmation": "destructiveConfirmationHtml" },
    examples: [
      {
        title: "Arm · cancel · confirm (safe demo)",
        render: () =>
          '<form data-action="submit->catalogue#submit">' +
          destructiveConfirmationHtml({
            trigger: {
              type: "button",
              variant: "danger",
              content: { kind: "caption", caption: "Delete record" },
            },
            confirmCaption: "Confirm deletion",
            cancelCaption: "Keep record",
          }) +
          '<output aria-live="polite"></output></form>',
      },
    ],
  },
  {
    id: "toggle",
    title: "Toggle",
    when: "Mutually exclusive values, all visible at once. For many options use a native select with popup enhancement.",
    contract:
      "Unique values; current value must exist. Element mode emits bubbling change with detail {name,value}. Form mode submits through Turbo. Labels are plain text; there are no per-option classes or HTML replacements. Arrow keys skip disabled options.",
    imports: { toggle: "toggleHtml" },
    sources: ["toggle/toggle-controller.ts"],
    examples: [
      {
        title: "Button · disabled option",
        render: () =>
          toggleHtml({
            variant: "button",
            label: "View",
            name: "view",
            value: "list",
            options: [
              { value: "list", label: "List" },
              { value: "grid", label: "Grid" },
              { value: "map", label: "Map", disabled: true },
            ],
          }),
      },
      {
        title: "Text",
        render: () =>
          toggleHtml({
            variant: "text",
            label: "View",
            name: "view",
            value: "list",
            options: [
              { value: "list", label: "List" },
              { value: "grid", label: "Grid" },
            ],
          }),
      },
      {
        title: "Subtle text",
        render: () =>
          toggleHtml({
            variant: "text-subtle",
            label: "View",
            name: "view",
            value: "list",
            options: [
              { value: "list", label: "List" },
              { value: "grid", label: "Grid" },
            ],
          }),
      },
    ],
  },
  {
    id: "popup",
    compareButtonSizes: true,
    title: "Popup",
    when: "Compact choices anchored to a disclosure. Prefer popupHtml: one call owns trigger, anchor, ARIA and native popover behavior.",
    contract:
      "Unique id per instance. Items need menuitem or menuitemradio roles and native actions. Escape closes; arrows move through enabled items. Placement flips at viewport edges. Trigger captions stay on one line and truncate in constrained containers; menus expose the full choices. The package owns trigger linkage and positioning; trigger.attributesHtml and menuAttributesHtml connect application behavior without supplying class or style. Try the REAL viewport corners in the edge laboratory.",
    imports: { popup: "popupHtml", "action-item": "actionItemHtml" },
    examples: [
      {
        title: "Constrained trigger · single-line caption",
        render: (idSuffix = "") => `<div style="width: 180px; max-width: 100%">${popupHtml({
          id: `catalogue-popup-constrained${idSuffix}`,
          label: "Model",
          trigger: { variant: "secondary", content: { kind: "caption", caption: "An unusually long model name" } },
          contentHtml: actionItemHtml({ kind: "single", label: { kind: "text", text: "An unusually long model name" }, element: { tag: "button", attributesHtml: 'type="button" role="menuitemradio" aria-checked="true"' } }),
        })}</div>`,
      },
      {
        title: "Anchored menu · disabled · long option",
        render: (idSuffix = "") =>
          popupHtml({
            id: `catalogue-popup${idSuffix}`,
            label: "Example actions",
            trigger: {
              variant: "secondary",
              content: { kind: "caption", caption: "Open menu" },
            },
            contentHtml: [
              "Open record",
              "An unusually long translated menu item caption",
              "Unavailable",
            ]
              .map((text, index) =>
                actionItemHtml({
                  kind: "single",
                  label: { kind: "text", text },
                  element: {
                    tag: "button",
                    attributesHtml: `type="button" role="menuitem"${index === 2 ? " disabled" : ""}`,
                  },
                }),
              )
              .join(""),
          }),
      },
    ],
  },
  {
    id: "popup-select",
    compareButtonSizes: true,
    title: "Popup select",
    when: "A native form select enhanced into a consistent popover. Prefer Toggle for a few short options.",
    contract:
      "Native interface: select.popup-select, an accessible label, named options, selected and disabled. Wrap each select in its own span. data-popup-placement=above is optional. Native change and form value remain authoritative; never manipulate generated menu DOM.",
    sources: ["popup/popup-controller.ts", "popup/popup-position.ts"],
    examples: [
      {
        title: "Select with disabled option",
        render: () =>
          '<span><select class="popup-select" name="environment" aria-label="Environment"><option>Development</option><option>Staging</option><option disabled>Production (restricted)</option></select></span>',
      },
      {
        title: "Long choices · native form reset · disabled select",
        render: () =>
          '<form class="form-stack" data-action="submit->catalogue#submit"><span><select class="popup-select" name="region" aria-label="Region"><option value="local">Local development</option><option value="remote">A remote development environment with a deliberately long regional name</option></select></span><span><select class="popup-select" aria-label="Unavailable environment" disabled><option>Unavailable environment</option></select></span>' +
          buttonGroupHtml({ orientation: "horizontal", semantics: "layout", itemsHtml:
            buttonHtml({ type: "reset", variant: "secondary", content: { kind: "caption", caption: "Reset selection" } }) +
            buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Submit selection" } })
          }) + '<output aria-live="polite"></output></form>',
      },
    ],
  },
  {
    id: "dialog",
    title: "Dialog",
    when: "A focused task temporarily blocking page interaction. Not for small menus or ordinary navigation.",
    contract:
      "Native dialog plus Panel. Open with showModal() in Stimulus or data-dialog-auto-show on server insertion. Escape and close dismiss; focus returns to opener. Provide titleCaption; the header and title always use regular body-text typography, owned by Dialog rather than callers. Full-bleed is for regions owning layout, not a size variant.",
    imports: { dialog: "dialogHtml", button: "buttonHtml", icons: "Icons" },
    examples: [
      {
        title: "Modal · long body · nested popup",
        render: () =>
          buttonHtml({
            type: "button",
            variant: "secondary",
            content: { kind: "caption", caption: "Open dialog" },
            attributesHtml: 'data-action="catalogue#openDialog"',
          }) +
          dialogHtml({
            element: { id: "catalogue-dialog" },
            iconHtml: Icons.Plus,
            titleCaption: "A focused task",
            bodyHtml:
              '<label>Record name<input class="text-field" autofocus placeholder="Enter a name"></label><p>Resize, tab through controls, and press Escape.</p><span><select class="popup-select" aria-label="Dialog environment"><option>Development</option><option>Staging</option></select></span>' +
              "<p>Long content inside the modal.</p>".repeat(15),
          }),
      },
    ],
  },
  {
    id: "panel",
    title: "Panel",
    when: "A bounded surface with fixed chrome and flexible body. Dialog composes this; workspace panes use it directly.",
    contract:
      "Supply semantic element tag, trusted header/body and optional footer. Use an outer layout container for dimensions. bodyLayout: padded/full-bleed and bodyOverflow: scroll/contained are the supported body behaviors. No root or body classes.",
    imports: { panel: "panelHtml" },
    examples: [
      {
        title: "Header · body · footer",
        render: () =>
          panelHtml({
            element: { tag: "section" },
            headerHtml: '<h3 class="title">Panel title</h3>',
            bodyHtml: "<p>A flexible content region.</p>",
            bodyLayout: "padded",
            footerHtml: "Optional footer",
          }),
      },
    ],
  },
  {
    id: "autocomplete",
    title: "Autocomplete",
    when: "Server-rendered search suggestions or search status. Not a floating action menu.",
    contract:
      "Results provide listbox semantics; caller supplies options, combobox linkage and keyboard selection. Return HTML in a Turbo Frame. Message is a separate variant, optionally role status. No search protocol is hidden here.",
    imports: {
      autocomplete: "autocompleteHtml",
      "action-item": "actionItemHtml",
    },
    examples: [
      {
        title: "Results · empty · loading",
        render: () =>
          autocompleteHtml({
            kind: "results",
            label: "Repositories",
            contentHtml: actionItemHtml({
              kind: "single",
              label: { kind: "text", text: "atelier/design-system" },
              element: {
                tag: "div",
                attributesHtml: 'role="option" aria-selected="false"',
              },
              primary: false,
            }),
          }) +
          autocompleteHtml({
            kind: "message",
            role: "status",
            content: { kind: "text", text: "No matching repositories" },
          }) +
          autocompleteHtml({
            kind: "message",
            role: "status",
            content: { kind: "text", text: "Searching…" },
          }),
      },
    ],
  },
  {
    id: "transient-feedback",
    compareButtonSizes: true,
    title: "Transient feedback",
    when: "Brief acknowledgement of a completed action. Prefer Copy button for clipboard actions.",
    contract:
      "Only current content affects layout. Feedback resets automatically. Use transient-feedback/client helpers for browser operations; server renders initial or feedback. Buttons disable during feedback unless explicitly kept enabled.",
    imports: { "transient-feedback": "transientFeedbackHtml" },
    sources: ["transient-feedback/transient-feedback-controller.ts"],
    examples: [
      {
        title: "Activate feedback",
        render: () =>
          transientFeedbackHtml({
            element: {
              tag: "button",

              attributesHtml: 'type="button" data-action="catalogue#feedback"',
            },
            state: "initial",
            initialContent: { kind: "text", text: "Acknowledge" },
            feedbackContent: { kind: "text", text: "Done!" },
          }),
      },
    ],
  },
  {
    id: "text-entry",
    title: "Text entry",
    when: "Native single-line input or multiline textarea. CSS-first: preserve native form semantics without pass-through renderers.",
    contract:
      "input.text-field or textarea.textarea with associated label. Caller owns native type, name, value, required, disabled and validation. Explain errors with aria-describedby and aria-invalid. Do not fork height, border, radius or background per feature.",
    sources: ["text-entry/text-entry.css"],
    examples: [
      {
        title: "Normal · invalid · disabled · multiline",
        render: () =>
          '<div class="form-stack"><label>Name<input class="text-field" placeholder="Paste copied text"></label><label>Invalid value<input class="text-field" value="Not valid" aria-invalid="true" aria-describedby="catalogue-input-error"></label><span id="catalogue-input-error">Explain how to correct the value.</span><label>Unavailable<input class="text-field" value="Unavailable operation" disabled></label><label>Notes<textarea class="textarea" placeholder="Long multiline content"></textarea></label></div>',
      },
    ],
  },
  {
    id: "managed-list",
    title: "Managed list",
    when: "Non-selectable records with metadata and actions. Use Action item when the row itself is actionable.",
    contract:
      "CSS anatomy: managed-list, __filter, __items, __item, __content, __label / __label-text, __description, __meta, __actions, __empty. Local filter uses data-search-text or row text. Server search sets data-managed-list-server-filter=true and uses Turbo. __label-text truncates.",
    sources: [
      "managed-list/managed-list-controller.ts",
      "managed-list/managed-list.css",
    ],
    examples: [
      {
        title: "Filter · long label · empty result",
        render: () =>
          '<div class="managed-list"><div class="managed-list__filter"><input class="text-field" type="search" aria-label="Filter records" placeholder="Filter records…"></div><div class="managed-list__items"><div class="managed-list__item"><div class="managed-list__content"><div class="managed-list__label"><span class="managed-list__label-text">A deliberately long record label for checking narrow layouts</span></div><div class="managed-list__description">Development environment</div></div><span class="managed-list__meta">Ready</span></div><div class="managed-list__item"><div class="managed-list__content">Staging</div></div></div><div class="managed-list__empty" hidden>No matching records</div></div>',
      },
    ],
  },
  {
    id: "status",
    title: "Status & progress lists",
    when: "Compact status markers and multi-step summaries. Pair color with visible text.",
    contract:
      "status-dot with success, warning, danger or running; decorative dots use aria-hidden. status-list has __item and __marker. aria-busy for running, data-status=failed for failure, aria-checked=true only with checkbox role. Reduced motion disables spinning.",
    sources: ["status/status.css"],
    examples: [
      {
        title: "Success · warning · danger · running",
        render: () =>
          '<div class="form-section">' +
          ["success", "warning", "danger", "running"]
            .map(
              (state) =>
                `<span><span class="status-dot ${state}" aria-hidden="true"></span> ${state}</span>`,
            )
            .join("") +
          '<ul class="status-list"><li class="status-list__item" role="checkbox" aria-checked="true"><span class="status-list__marker">✓</span>Complete</li><li class="status-list__item" aria-busy="true"><span class="status-list__marker"></span>Running</li><li class="status-list__item" data-status="failed"><span class="status-list__marker">!</span>Failed</li></ul></div>',
      },
    ],
  },
  {
    id: "icons",
    title: "Icons",
    when: "Shared decorative vocabulary. Use icon-only Button for standalone icon actions.",
    contract:
      "Icons exports trusted decorative SVG strings. atelierLogoPathsHtml exports the same logo geometry without a nested SVG viewport for animated scenes using 24×24 user units. Put the accessible name on the containing control. Never use an unlabeled icon as an action.",
    imports: { icons: "Icons" },
    examples: [
      {
        title: "Icon vocabulary",
        render: () =>
          Object.entries(Icons)
            .map(
              ([name, svg]) =>
                `<span class="catalogue-icon">${svg}<span>${name}</span></span>`,
            )
            .join(""),
      },
    ],
  },
  {
    id: "linear-navigation",
    title: "Linear navigation",
    when: "Keyboard behavior for a vertical sequence whose semantics and content are caller-owned.",
    contract:
      "data-controller=linear-navigation on the sequence; data-linear-navigation-target=item on focusable children. Up/Down move without wrapping; hidden, disabled and aria-disabled items are skipped. This does not implement selection or a tree protocol.",
    sources: ["linear-navigation/linear-navigation-controller.ts"],
    imports: { "action-item": "actionItemHtml" },
    examples: [
      {
        title: "Focus, then Up / Down",
        render: () =>
          '<div class="action-list" data-controller="linear-navigation">' +
          ["First", "Second", "Last"]
            .map((text) =>
              actionItemHtml({
                kind: "single",
                element: {
                  tag: "button",
                  attributesHtml:
                    'type="button" data-linear-navigation-target="item"',
                },
                label: { kind: "text", text },
              }),
            )
            .join("") +
          "</div>",
      },
    ],
  },
];
