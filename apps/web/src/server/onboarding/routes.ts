import { finishOnboarding, onboardingCompleted } from "./state.ts";
import { actionLinkHtml } from "@atelier/design-system/action-link";
import { buttonHtml } from "@atelier/design-system/button";
import { dialogHtml } from "@atelier/design-system/dialog";
import { Icons } from "@atelier/design-system/icons";
import { turboStreamResponse } from "@atelier/shared";
import { hasWorkspaceGitHubToken } from "@atelier/proxy-egress";
import { hasAvailableConfiguredModel, renderModelSetupDialog } from "@atelier/llm/server";
import { renderGitHubConnectButton, renderGitHubSetup } from "../settings/github.ts";
import { turboUpdateStream as update } from "../http-responses.ts";

export async function renderOnboardingDialog(options: { includeCompleted?: boolean; resumeAfter?: "github" } = {}): Promise<string> {
  if (!options.includeCompleted && !options.resumeAfter && await onboardingCompleted()) return "";
  const githubConnected = hasWorkspaceGitHubToken();
  const modelsReady = await hasAvailableConfiguredModel();
  if (options.resumeAfter) return renderModelSetupDialog("onboarding");
  if (!options.includeCompleted && githubConnected) return modelsReady ? "" : renderModelSetupDialog("onboarding");

  const needsModelsStep = options.includeCompleted || !modelsReady;
  const caption = githubConnected ? "Continue" : "Continue without GitHub";
  const continueAction = needsModelsStep
    ? actionLinkHtml({ href: "/onboarding/models", variant: "secondary", content: { kind: "caption", caption }, attributesHtml: 'data-turbo-stream="true"' })
    : `<form method="post" action="/onboarding/finish" data-turbo="true">${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption } })}</form>`;
  return dialogHtml({
    element: { id: "onboarding_dialog", attributesHtml: "data-dialog-auto-show" },
    iconHtml: Icons.Atelier,
    titleCaption: "Set up Atelier",
    bodyHtml: `<div class="onboarding-progress" aria-label="Onboarding progress"><span class="onboarding-progress-item" aria-current="step"></span>${needsModelsStep ? '<span class="onboarding-progress-item"></span>' : ""}</div>
      <div class="onboarding-body form-stack"><h2 class="title">Connect GitHub</h2>${renderGitHubSetup("onboarding")}</div>`,
    bodyLayout: "full-bleed",
    footerHtml: `${continueAction}${githubConnected ? "" : renderGitHubConnectButton("onboarding")}`,
    omitCancelButton: true,
  });
}

export async function handleOnboardingRequest(request: Request, url: URL): Promise<Response | undefined> {
  if (url.pathname === "/onboarding/models" && request.method === "GET") return turboStreamResponse(update("onboarding_modal_host", await renderModelSetupDialog("onboarding")));
  if (url.pathname === "/onboarding/finish" && request.method === "POST") return finishOnboarding();
  if (url.pathname === "/onboarding" && request.method === "GET") {
    const html = await renderOnboardingDialog({ includeCompleted: true });
    const acceptsStream = request.headers.get("accept")?.includes("text/vnd.turbo-stream.html") ?? false;
    if (acceptsStream) return turboStreamResponse(update("onboarding_modal_host", html));
    // Onboarding is a modal flow, not a standalone page.
    return Response.redirect(new URL("/", url).toString(), 303);
  }
  return undefined;
}
