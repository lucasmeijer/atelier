// Portions adapted from @earendil-works/gondolin, Apache-2.0.
// Source: https://github.com/earendil-works/gondolin

export class HttpRequestBlockedError extends Error {
  status: number;
  statusText: string;

  constructor(message = "request blocked", status = 403, statusText = "Forbidden") {
    super(message);
    this.name = "HttpRequestBlockedError";
    this.status = status;
    this.statusText = statusText;
  }
}
