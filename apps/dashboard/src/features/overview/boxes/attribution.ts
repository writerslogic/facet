import { attributionBox } from '../../../components/boxes/AttributionBox.js';
import { revenueBox } from '../../../components/boxes/RevenueBox.js';
import type { TileDef } from '../../../components/boxes/types.js';

export const ATTRIBUTION_TILES: Readonly<Record<string, TileDef>> = {
	revenue: revenueBox,
	attribution: attributionBox,
};
