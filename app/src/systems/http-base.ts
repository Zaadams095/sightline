import { useLinks } from '@/net/connection';
import { httpMessage, withQuery, type Query } from '@/systems/http-kit';
import type { SystemConfig } from '@/systems/types';
import { fetchWithTimeout } from '@/util/fetch';

/**
 * Shared plumbing for adapters that speak HTTP through the loopback gateway. Brand-neutral:
 * each adapter passes its own display label for error messages.
 *
 * The base URL is read from the live connection state on every request, because an adapter
 * can be created before its route is up (and the route's port can change after an edit).
 */
export abstract class HttpSystem {
  protected abstract readonly label: string;

  constructor(
    readonly config: SystemConfig,
    private initialBaseUrl: string,
  ) {}

  protected get baseUrl(): string {
    return (useLinks.getState().links[this.config.id]?.baseUrl || this.initialBaseUrl).replace(/\/$/, '');
  }

  protected requireBase(): string {
    const b = this.baseUrl;
    if (!b) throw new Error(`Still connecting to ${this.label}. Try again in a moment.`);
    return b;
  }

  protected url(path: string, q?: Query): string {
    return withQuery(`${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`, q);
  }

  /** Sends a request; network failures become plain-language errors, HTTP errors don't throw. */
  protected async send(path: string, init: RequestInit = {}, q?: Query, timeoutMs = 10000): Promise<Response> {
    this.requireBase();
    try {
      return await fetchWithTimeout(this.url(path, q), { credentials: 'omit', ...init }, timeoutMs);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith('No response')) throw new Error(`${this.label} didn’t answer in time. Check that it’s on and reachable.`);
      throw new Error(`Couldn’t reach ${this.label}. Check the address and that your phone is on the same network.`);
    }
  }

  protected async request(path: string, init: RequestInit = {}, q?: Query, timeoutMs = 10000): Promise<Response> {
    const res = await this.send(path, init, q, timeoutMs);
    if (!res.ok) throw new Error(httpMessage(res.status, this.label));
    return res;
  }

  protected async json<T>(path: string, init: RequestInit = {}, q?: Query, timeoutMs?: number): Promise<T> {
    const res = await this.request(path, { ...init, headers: { Accept: 'application/json', ...(init.headers ?? {}) } }, q, timeoutMs);
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${this.label} sent an unexpected reply. Check that the address points to ${this.label}.`);
    }
  }
}
