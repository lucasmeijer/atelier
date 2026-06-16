// Portions adapted from @earendil-works/gondolin, Apache-2.0.
// Source: https://github.com/earendil-works/gondolin

export const ON_REQUEST_EARLY_POLICY_SAFE = Symbol.for("atelier.http.onRequestEarlyPolicySafe");

export type HttpOnRequestHook = ((
  request: Request,
) => Promise<Request | Response | void> | Request | Response | void) & {
  [ON_REQUEST_EARLY_POLICY_SAFE]?: boolean;
};

export type HttpIpAllowInfo = {
  hostname: string;
  ip: string;
  family: 4 | 6;
  port: number;
  protocol: "http" | "https";
};

export type HttpHooks = {
  isRequestAllowed?: (request: Request) => Promise<boolean> | boolean;
  isIpAllowed?: (info: HttpIpAllowInfo) => Promise<boolean> | boolean;
  onRequest?: HttpOnRequestHook;
  onResponse?: (response: Response, request: Request) => Promise<Response | void> | Response | void;
};
