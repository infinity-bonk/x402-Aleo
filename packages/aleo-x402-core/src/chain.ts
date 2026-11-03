import { API } from "./config.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The public API rate-limits hard (Cloudflare 429), so back off when refused.
export async function request(path: string, attempt = 0): Promise<Response> {
  const res = await fetch(`${API}${path}`);
  if (res.status === 429 && attempt < 8) {
    const delay = Math.min(60_000, 5_000 * 2 ** attempt);
    console.error(`rate limited, retrying in ${delay / 1000}s`);
    await wait(delay);
    return request(path, attempt + 1);
  }
  return res;
}

export async function get(path: string) {
  const res = await request(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

// A record is spent once its serial number appears as an input to some transition.
export async function isSpent(serialNumber: string): Promise<boolean> {
  return (await request(`/find/transitionID/${serialNumber}`)).ok;
}

export async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await work();
  console.log(`${label}: ${((performance.now() - start) / 1000).toFixed(1)}s`);
  return result;
}
