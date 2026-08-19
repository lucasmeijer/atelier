export type HttpFetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
