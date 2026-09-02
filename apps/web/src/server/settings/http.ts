import { turboStream, turboStreamResponse } from "@atelier/shared";
import { response, turboReplaceStream, turboUpdateStream, wantsTurboStream } from "../http-responses.ts";

export { response };
export const stream = turboStreamResponse;
export const replace = turboReplaceStream;
export const update = turboUpdateStream;
export const updateTargets = (selector: string, html: string): string => turboStream("update", selector, html, { targets: true });
export const replaceTargets = (selector: string, html: string): string => turboStream("replace", selector, html, { targets: true });
export const remove = (target: string): string => turboStream("remove", target);
export const append = (target: string, html: string): string => turboStream("append", target, html);
export const wantsStream = wantsTurboStream;
