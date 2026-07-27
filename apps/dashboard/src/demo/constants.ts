// Static-demo constants, shared by the state layer (profile seed) and the mock API (fixtures). Kept
// tiny and dependency-free so importing it into the main bundle costs nothing; the heavy dataset + mock
// are dynamically imported only when the demo is active (see main.tsx).

/** True when this build is the public, no-backend static demo (GitHub Pages). Set at build time via
 * `VITE_FACET_STATIC_DEMO=1`. Every normal/self-hosted build leaves it unset → false. */
export const STATIC_DEMO: boolean = import.meta.env.VITE_FACET_STATIC_DEMO === '1';

/** The synthetic demo site id + key. These are fabricated — the mock ignores them and serves fixtures,
 * so no real site or key is ever exposed. */
export const DEMO_SITE_ID = '00000000-0000-4000-8000-0000facede00';
export const DEMO_API_KEY = 'clk_demo';
export const DEMO_LABEL = 'Live demo';
