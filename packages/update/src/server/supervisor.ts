import type { HttpFetcher } from "./http.ts";

const supervisorOrigin = "http://127.0.0.1:3001";

/** The supervisor acknowledges only after routing the app origin to its progress page. */
export async function requestSupervisorUpdate(image: string, fetcher: HttpFetcher = fetch): Promise<void> {
  const response = await fetcher(`${supervisorOrigin}/update`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image }),
  });
  if (response.status !== 202) throw new Error((await response.text()).trim() || `Supervisor refused update: ${response.status}`);
}
