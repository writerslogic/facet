// Compatibility type barrel only. Catalog ordering and metadata live in the JSX-free Overview
// catalog; implementations are imported through explicit core/advanced/attribution runtime groups.
// Keeping value exports out of this file prevents an innocent barrel import from eagerly loading all
// optional charts again.

export type { TileDef } from './types.js';
