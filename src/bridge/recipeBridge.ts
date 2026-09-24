/**
 * Client for a "recipe source" provider app (Phase 45 self-describing apps),
 * wrapped in a typed surface with a dev-mode mock. Lets Conjure Health read
 * the user's saved recipes and log a cooked one as a meal.
 *
 * Provider resolution, in order:
 *
 *   1. **Discovery (Phase 45).** The platform matches the `recipeSource` need
 *      declared in our package.json against installed apps' `actions` and
 *      `actions.discover("recipeSource")` returns `ProviderMatch[]`. No app
 *      paths or action names are hardcoded; invokes pass
 *      `{ normalize: "recipeSource" }` so results come back in the need's
 *      canonical shape even from an ai-mapped provider. An EMPTY result is a
 *      normal state — no provider installed, or the user disabled cross-app
 *      connections — and degrades to "no recipes" ([] / null) quietly. It is
 *      re-checked on the next call so installing a provider mid-session works.
 *   2. **Legacy hosts** (no `discover`): the pre-45 `actions.list()` scan for
 *      an app exposing `getRecipe`, invoking literal action names.
 *   3. **No bridge at all** (plain `npm run dev` outside ConjureOS): bundled
 *      mock recipes.
 *
 * Reads are side-effect-free (`actions.read`, no grant prompt); `markCooked`
 * is `actions.write`, triggers ConjureOS's one-time per-caller grant, and is
 * an optional nicety — in discovered mode it only fires when the matched
 * provider actually exposes a `markCooked` action.
 */

/** One provider matched to a declared need by the platform. */
export interface ProviderMatch {
  appPath: string;
  displayName: string;
  /** The provider action to invoke to get data in the need's shape. */
  action: string;
  /** "exact" = structural schema match; "ai-mapped" = platform-translated. */
  binding: "exact" | "ai-mapped";
  confidence?: number;
}

declare global {
  interface ConjureosBridge {
    actions?: {
      register?: (
        handlers: Record<string, (params?: unknown) => Promise<unknown>>,
      ) => Promise<void>;
      invoke?: (
        appPath: string,
        actionName: string,
        params?: unknown,
        opts?: { timeoutMs?: number; normalize?: string },
      ) => Promise<unknown>;
      list?: () => Promise<
        Array<{
          appPath: string;
          displayName: string;
          actions: Array<{ name: string; permission: string; description?: string }>;
        }>
      >;
      /** Phase 45; undefined on older hosts — always feature-detect. */
      discover?: (needId: string) => Promise<ProviderMatch[]>;
    };
  }
}

/** Nutrition strip in the `recipeSource` need's canonical shape (per serving, estimated). */
export interface RecipeNutrition {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
}

/** A saved recipe as returned by the provider app, with per-serving
 *  nutrition when it has any (`null` when the provider couldn't estimate). */
export interface ListedRecipe {
  slug: string;
  title: string;
  servings: number;
  ingredients: string[];
  savedAt: string;
  madeCount: number;
  nutrition: RecipeNutrition | null;
}

/** The need id declared in package.json's `conjureos.needs`. */
const NEED_ID = "recipeSource";
const LEGACY_DEFAULT_PATH = "/apps/recipes";

/**
 * Thrown by the read helpers when a cross-app call fails specifically because
 * the provider app isn't open (`TARGET_NOT_RUNNING`) — as opposed to a genuine
 * "no such recipe" miss (which still returns null). Lets `logRecipeMeal` raise
 * the orchestrator's `NEEDS_APP_OPEN:<path>` marker so the shell opens the
 * provider and retries, instead of misreporting a missing recipe.
 */
export class RecipesAppClosedError extends Error {
  readonly appPath: string;
  constructor(appPath: string) {
    super(`Recipe provider app not running: ${appPath}`);
    this.name = "RecipesAppClosedError";
    this.appPath = appPath;
  }
}

/** True when a rejected invoke carries the kernel's TARGET_NOT_RUNNING code. */
function isTargetClosed(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { code?: unknown }).code === "TARGET_NOT_RUNNING"
  );
}

function actions() {
  return window.__conjureos?.actions;
}

/** Whether cross-app invocation exists at all. False outside ConjureOS —
 *  the read helpers then serve mock recipes so the flow stays walkable. */
export function isRecipeBridgeAvailable(): boolean {
  return typeof actions()?.invoke === "function";
}

// ── Provider resolution ──────────────────────────────────────────────────

type ResolvedProvider =
  /** Phase 45 discovery hit: invoke `match.action` with `{ normalize: NEED_ID }`. */
  | { kind: "discovered"; match: ProviderMatch }
  /** Older host without `discover`: literal pre-45 action names. */
  | { kind: "legacy"; appPath: string }
  /** Bridge present but no provider (none installed, or cross-app disabled). */
  | { kind: "none" }
  /** No actions bridge at all — non-ConjureOS dev; use mock recipes. */
  | { kind: "mock" };

let resolving: Promise<ResolvedProvider> | null = null;
let lastMatches: ProviderMatch[] = [];

/**
 * Full match list from the most recent discovery (empty until discovery has
 * run, or when nothing matched). Exposed so the UI could offer a provider
 * picker later; `resolveProvider` itself uses the first exact match.
 */
export function getRecipeProviderMatches(): ProviderMatch[] {
  return lastMatches;
}

/**
 * Display name of the provider `listRecipes`/`getRecipe` currently resolve to —
 * the exact match if any, else the top-ranked one — for a "source app" pill.
 * Null until a discovery has run (call after `listRecipes`) or in mock mode.
 */
export function getResolvedRecipeProviderName(): string | null {
  if (lastMatches.length === 0) return null;
  const match = lastMatches.find((m) => m.binding === "exact") ?? lastMatches[0]!;
  return match.displayName || null;
}

/** Test seam: forget any cached provider resolution. */
export function resetRecipeProviderCache(): void {
  resolving = null;
  lastMatches = [];
  hasActionCache.clear();
}

async function resolveProvider(): Promise<ResolvedProvider> {
  if (!resolving) resolving = doResolve();
  const out = await resolving;
  // "none" is retried on the next call: the user may install a provider or
  // re-enable cross-app connections mid-session. Successful resolutions stick.
  if (out.kind === "none") resolving = null;
  return out;
}

async function doResolve(): Promise<ResolvedProvider> {
  const a = actions();
  if (!a?.invoke) return { kind: "mock" };

  if (typeof a.discover === "function") {
    let matches: ProviderMatch[] = [];
    try {
      matches = (await a.discover(NEED_ID)) ?? [];
    } catch {
      matches = []; // discovery failure degrades like "no provider"
    }
    lastMatches = matches;
    if (matches.length === 0) return { kind: "none" };
    // Prefer the first exact structural match; otherwise take the platform's
    // top-ranked ai-mapped provider. The full list stays available via
    // getRecipeProviderMatches() for a future picker UI.
    const match = matches.find((m) => m.binding === "exact") ?? matches[0]!;
    return { kind: "discovered", match };
  }

  // Legacy host: resolve the installed Recipes app path by scanning for
  // `getRecipe`, falling back to the historical default path.
  if (a.list) {
    try {
      const apps = await a.list();
      const match = apps.find((app) => app.actions.some((x) => x.name === "getRecipe"));
      if (match) return { kind: "legacy", appPath: match.appPath };
    } catch {
      /* fall through to default */
    }
  }
  return { kind: "legacy", appPath: LEGACY_DEFAULT_PATH };
}

/** Cached "does app X expose action Y" lookups (discovered mode only). */
const hasActionCache = new Map<string, boolean>();

async function providerHasAction(appPath: string, name: string): Promise<boolean> {
  const key = `${appPath}::${name}`;
  const cached = hasActionCache.get(key);
  if (cached !== undefined) return cached;
  const a = actions();
  let has = false;
  if (a?.list) {
    try {
      const apps = await a.list();
      has = !!apps
        .find((app) => app.appPath === appPath)
        ?.actions.some((x) => x.name === name);
    } catch {
      has = false;
    }
  }
  hasActionCache.set(key, has);
  return has;
}

// ── Reads ────────────────────────────────────────────────────────────────

/**
 * Every saved recipe from the provider app, optionally filtered by title.
 * Returns [] when no provider is reachable — outside ConjureOS this serves
 * mock recipes so the log-a-recipe flow stays walkable.
 */
export async function listRecipes(filter?: string): Promise<ListedRecipe[]> {
  const provider = await resolveProvider();
  if (provider.kind === "mock") return mockRecipes(filter);
  if (provider.kind === "none") return [];
  const a = actions();
  if (!a?.invoke) return [];
  try {
    if (provider.kind === "discovered") {
      const res = (await a.invoke(
        provider.match.appPath,
        provider.match.action,
        { filter, limit: 100 },
        { normalize: NEED_ID },
      )) as { recipes?: ListedRecipe[] };
      return res?.recipes ?? [];
    }
    const res = (await a.invoke(provider.appPath, "listRecipes", { filter, limit: 100 })) as {
      recipes?: ListedRecipe[];
    };
    return res?.recipes ?? [];
  } catch {
    return [];
  }
}

/**
 * Fetch one saved recipe by slug, or null when the provider has no such
 * recipe (or no provider is reachable).
 *
 * Throws {@link RecipesAppClosedError} when a provider IS configured but its
 * app isn't running — the caller turns that into the shell's open-and-retry
 * marker rather than reporting a missing recipe.
 */
export async function getRecipe(slug: string): Promise<ListedRecipe | null> {
  const provider = await resolveProvider();
  if (provider.kind === "mock") return mockRecipes().find((r) => r.slug === slug) ?? null;
  if (provider.kind === "none") return null;
  const a = actions();
  if (!a?.invoke) return null;

  if (provider.kind === "discovered") {
    // The matched action returns the need's canonical { recipes } shape; pick
    // the slug out client-side rather than assuming the provider has a
    // one-recipe action.
    try {
      const res = (await a.invoke(
        provider.match.appPath,
        provider.match.action,
        { limit: 500 },
        { normalize: NEED_ID },
      )) as { recipes?: ListedRecipe[] };
      return res?.recipes?.find((r) => r.slug === slug) ?? null;
    } catch (err) {
      // The provider being closed is recoverable, not a real miss: surface it
      // so the caller (and ultimately the orchestrator) can open the app and
      // retry, rather than reporting "recipe not found". Anything else → null.
      if (isTargetClosed(err)) throw new RecipesAppClosedError(provider.match.appPath);
      return null;
    }
  }

  try {
    const res = (await a.invoke(provider.appPath, "getRecipe", { slug })) as {
      recipe?: ListedRecipe | null;
    };
    return res?.recipe ?? null;
  } catch (err) {
    if (isTargetClosed(err)) throw new RecipesAppClosedError(provider.appPath);
    return null;
  }
}

// ── Writes ───────────────────────────────────────────────────────────────

/**
 * Mark a recipe cooked. Best-effort: a denied grant shouldn't break logging,
 * and a discovered provider that doesn't expose `markCooked` silently no-ops
 * (it's an optional nicety, not part of the `recipeSource` need).
 */
export async function markCooked(slug: string): Promise<void> {
  const provider = await resolveProvider();
  if (provider.kind === "mock" || provider.kind === "none") return;
  const a = actions();
  if (!a?.invoke) return;
  const appPath = provider.kind === "discovered" ? provider.match.appPath : provider.appPath;
  if (provider.kind === "discovered") {
    const has = await providerHasAction(appPath, "markCooked");
    if (!has) return;
  }
  try {
    await a.invoke(appPath, "markCooked", { slug });
  } catch {
    /* grant denied or app closed — non-fatal */
  }
}

// ── Dev-mode mock (non-ConjureOS `npm run dev`) ──────────────────────────

function mockRecipes(filter?: string): ListedRecipe[] {
  const all: ListedRecipe[] = [
    {
      slug: "spinach-feta-scramble",
      title: "Spinach & Feta Scramble",
      servings: 2,
      ingredients: ["3 eggs", "1 cup spinach", "30g feta", "1 tsp olive oil"],
      savedAt: "2026-05-20T08:00:00.000Z",
      madeCount: 3,
      nutrition: { calories: 320, protein: 22, fat: 24, carbs: 4 },
    },
    {
      slug: "roasted-pepper-frittata",
      title: "Roasted Pepper Frittata",
      servings: 4,
      ingredients: ["6 eggs", "1 red bell pepper", "50g feta", "1/4 cup milk"],
      savedAt: "2026-05-18T18:30:00.000Z",
      madeCount: 1,
      nutrition: { calories: 245, protein: 17, fat: 18, carbs: 5 },
    },
  ];
  if (!filter) return all;
  const f = filter.toLowerCase();
  return all.filter(
    (r) => r.title.toLowerCase().includes(f) || r.ingredients.some((i) => i.toLowerCase().includes(f)),
  );
}
