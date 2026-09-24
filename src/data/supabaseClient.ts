/**
 * Minimal PostgREST client for the shared ConjureOS Supabase project,
 * scoped to the `fitness` schema.
 *
 * Identity is single-sign-on: the bearer token is the *host* user's session
 * token (provided by ConjureOS via the auth bridge), so the same person who's
 * signed into the OS is the person these rows belong to — no second login.
 * The token is fetched fresh per request via `tokenProvider` so the host owns
 * refresh; we never cache a token that might expire mid-session.
 *
 * Non-public schema access uses PostgREST's profile headers
 * (`Accept-Profile` / `Content-Profile` = "fitness"); the schema must be
 * listed in the project's exposed schemas (see the backend repo's runbook).
 */

const SCHEMA = "fitness";

/** Supplies the bearer token for each request; re-invoked per call so a
 *  refreshed session is picked up without rebuilding the client. */
export type TokenProvider = () => Promise<string | null>;

/**
 * Minimal PostgREST client — just the verbs this app needs, so the full
 * supabase-js dependency stays out of the bundle. Auth is a bearer token from
 * the injected {@link TokenProvider}; RLS does the authorization server-side.
 */
export class SupabaseRestClient {
  constructor(
    private readonly url: string,
    private readonly anonKey: string,
    private readonly tokenProvider: TokenProvider,
  ) {}

  private async headers(write: boolean): Promise<Record<string, string>> {
    const token = (await this.tokenProvider()) ?? this.anonKey;
    const h: Record<string, string> = {
      apikey: this.anonKey,
      Authorization: `Bearer ${token}`,
      "Accept-Profile": SCHEMA,
    };
    if (write) {
      h["Content-Type"] = "application/json";
      h["Content-Profile"] = SCHEMA;
    }
    return h;
  }

  private endpoint(table: string, query?: string): string {
    const base = `${this.url.replace(/\/$/, "")}/rest/v1/${table}`;
    return query ? `${base}?${query}` : base;
  }

  async select<T>(table: string, query: string, signal?: AbortSignal): Promise<T[]> {
    const resp = await fetch(this.endpoint(table, query), {
      headers: await this.headers(false),
      signal,
    });
    if (!resp.ok) throw new Error(`select ${table} failed: ${resp.status}`);
    return (await resp.json()) as T[];
  }

  /** Upsert (insert with on-conflict merge). Returns the representation. */
  async upsert<T>(table: string, row: unknown, onConflict?: string): Promise<T[]> {
    const query = onConflict ? `on_conflict=${onConflict}` : undefined;
    const headers = await this.headers(true);
    headers["Prefer"] = "return=representation,resolution=merge-duplicates";
    const resp = await fetch(this.endpoint(table, query), {
      method: "POST",
      headers,
      body: JSON.stringify(row),
    });
    if (!resp.ok) throw new Error(`upsert ${table} failed: ${resp.status}`);
    return (await resp.json()) as T[];
  }

  async insert<T>(table: string, row: unknown): Promise<T[]> {
    const headers = await this.headers(true);
    headers["Prefer"] = "return=representation";
    const resp = await fetch(this.endpoint(table), {
      method: "POST",
      headers,
      body: JSON.stringify(row),
    });
    if (!resp.ok) throw new Error(`insert ${table} failed: ${resp.status}`);
    return (await resp.json()) as T[];
  }

  async patch(table: string, filter: string, patch: unknown): Promise<void> {
    const resp = await fetch(this.endpoint(table, filter), {
      method: "PATCH",
      headers: await this.headers(true),
      body: JSON.stringify(patch),
    });
    if (!resp.ok) throw new Error(`patch ${table} failed: ${resp.status}`);
  }

  async remove(table: string, filter: string): Promise<void> {
    const resp = await fetch(this.endpoint(table, filter), {
      method: "DELETE",
      // DELETE is a write verb: PostgREST needs Content-Profile (not just
      // Accept-Profile) to route it at the non-public `fitness` schema, same
      // as insert/upsert/patch below. headers(false) would silently target
      // `public` instead, so this must pass true like every other write call.
      headers: await this.headers(true),
    });
    if (!resp.ok) throw new Error(`delete ${table} failed: ${resp.status}`);
  }
}
