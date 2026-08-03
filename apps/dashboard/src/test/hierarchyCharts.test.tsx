// Hierarchy charts (sunburst + treemap) over the URL-prefix tree: the layout maths, the shared drill
// state, keyboard operation, the text equivalent, and the contrast of every label painted on a slice.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PathTreeNode, PathTreeResponse } from '@facet/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PathTreeExplorer } from '../components/boxes/PathTreeBox.js';
import { partitionArcs } from '../components/charts/Sunburst.js';
import { squarify, treemapLayout } from '../components/charts/Treemap.js';
import { MAX_TINT } from '../components/charts/hierarchy.js';
import { childrenTotal, flattenTree, normalizeTree } from '../hooks/pathTree.js';

/** Wire-shaped node builder — mirrors what the server sends, including `self` and `other`. */
function node(
	path: string,
	segment: string,
	depth: number,
	pageviews: number,
	self: number,
	children: PathTreeNode[] = [],
	other = false,
): PathTreeNode {
	return other
		? { path, segment, depth, pageviews, self, children, other: true }
		: { path, segment, depth, pageviews, self, children };
}

// /            600  (self 120)
//   /blog      300  (self 40)
//     /blog/a  150  (self 150)
//     /blog/b   90  (self  90)
//     other     20
//   /docs      100  (self 100)
//   /pricing    40  (self  40)
//   other       40
// As on the wire, every node's children sum to `pageviews - self`; the fold preserves the totals.
const TREE: PathTreeResponse = {
	max_depth: 4,
	min_count: 3,
	paths: 9,
	truncated: false,
	root: node('/', '', 0, 600, 120, [
		node('/blog', 'blog', 1, 300, 40, [
			node('/blog/a', 'a', 2, 150, 150),
			node('/blog/b', 'b', 2, 90, 90),
			node('/blog/other', 'other', 2, 20, 20, [], true),
		]),
		node('/docs', 'docs', 1, 100, 100),
		node('/pricing', 'pricing', 1, 40, 40),
		node('/other', 'other', 1, 40, 40, [], true),
	]),
};

const root = normalizeTree(TREE.root);
const blog = root.children.find((c) => c.path === '/blog');

describe('normalizeTree', () => {
	it('keeps children summing to their parent, including the self slice', () => {
		expect(childrenTotal(root)).toBe(root.value);
		expect(blog).toBeDefined();
		expect(childrenTotal(blog as NonNullable<typeof blog>)).toBe(300);
		for (const { item } of flattenTree(root)) {
			if (item.children.length === 0) continue;
			expect(childrenTotal(item)).toBe(item.value);
		}
	});

	it('gives a node with its own traffic an explicit self slice, ordered last', () => {
		const last = root.children[root.children.length - 1];
		expect(last?.kind).toBe('self');
		expect(last?.value).toBe(120);
		expect(last?.drillable).toBe(false);
	});

	it('folds an aggregate into a leaf that can never be drilled into', () => {
		const other = root.children.find((c) => c.kind === 'other');
		expect(other?.value).toBe(40);
		expect(other?.children).toHaveLength(0);
		expect(other?.drillable).toBe(false);
	});

	it('sorts real siblings by pageviews and puts the aggregate after them', () => {
		expect(root.children.map((c) => c.label)).toEqual([
			'blog',
			'docs',
			'pricing',
			'Other',
			'This page',
		]);
	});

	it('does not offer a drill into a leaf, and gives it no self slice to drill into', () => {
		// A childless node keeps no `self` slice: the whole node already IS its own traffic, and a
		// single full-circle slice labelled "This page" would be a drill target that says nothing.
		const leaf = normalizeTree(node('/x', 'x', 0, 10, 10));
		expect(leaf.children).toHaveLength(0);
		expect(leaf.drillable).toBe(false);
	});
});

describe('partitionArcs', () => {
	it('fills the turn exactly at the first ring, in proportion to pageviews', () => {
		const arcs = partitionArcs(root, 3);
		const ring1 = arcs.filter((a) => a.ring === 1);
		expect(ring1).toHaveLength(5);
		expect(ring1.reduce((s, a) => s + (a.x1 - a.x0), 0)).toBeCloseTo(1, 10);
		const blogArc = ring1.find((a) => a.item.path === '/blog');
		expect(blogArc && blogArc.x1 - blogArc.x0).toBeCloseTo(300 / 600, 10);
		// Siblings abut: each starts where the previous ended.
		for (let i = 1; i < ring1.length; i++) {
			expect(ring1[i]?.x0).toBeCloseTo(ring1[i - 1]?.x1 as number, 10);
		}
	});

	it('nests a child strictly inside its parent and scales angle by subtree share', () => {
		const arcs = partitionArcs(root, 3);
		const blogArc = arcs.find((a) => a.item.path === '/blog' && a.ring === 1);
		const postA = arcs.find((a) => a.item.path === '/blog/a');
		expect(blogArc).toBeDefined();
		expect(postA).toBeDefined();
		expect(postA?.ring).toBe(2);
		expect(postA?.x0).toBeGreaterThanOrEqual(blogArc?.x0 as number);
		expect(postA?.x1).toBeLessThanOrEqual((blogArc?.x1 as number) + 1e-12);
		// 150 of the root's 600 → a quarter of the turn, wherever it sits.
		expect((postA?.x1 as number) - (postA?.x0 as number)).toBeCloseTo(150 / 600, 10);
	});

	it('inherits one hue per top-level branch', () => {
		const arcs = partitionArcs(root, 3);
		const blogHue = arcs.find((a) => a.item.path === '/blog')?.hue;
		expect(arcs.find((a) => a.item.path === '/blog/a')?.hue).toBe(blogHue);
		expect(arcs.find((a) => a.item.path === '/docs')?.hue).not.toBe(blogHue);
	});

	it('stops at the requested number of rings', () => {
		expect(partitionArcs(root, 1).every((a) => a.ring === 1)).toBe(true);
		expect(partitionArcs(root, 1)).toHaveLength(5);
	});

	it('re-scales to a full turn when a child becomes the focus', () => {
		const arcs = partitionArcs(blog as NonNullable<typeof blog>, 2);
		const ring1 = arcs.filter((a) => a.ring === 1);
		expect(ring1.reduce((s, a) => s + (a.x1 - a.x0), 0)).toBeCloseTo(1, 10);
		const postA = ring1.find((a) => a.item.path === '/blog/a');
		expect((postA?.x1 as number) - (postA?.x0 as number)).toBeCloseTo(150 / 300, 10);
	});
});

describe('squarify', () => {
	const RECT = { x: 0, y: 0, w: 400, h: 300 };

	it('gives every rectangle an area proportional to its value', () => {
		const placed = squarify(root.children, RECT);
		const total = childrenTotal(root);
		expect(placed).toHaveLength(root.children.length);
		for (const { item, rect } of placed) {
			expect(rect.w * rect.h).toBeCloseTo((item.value / total) * RECT.w * RECT.h, 4);
		}
	});

	it('fills the rectangle without escaping it', () => {
		const placed = squarify(root.children, RECT);
		const area = placed.reduce((s, p) => s + p.rect.w * p.rect.h, 0);
		expect(area).toBeCloseTo(RECT.w * RECT.h, 3);
		for (const { rect } of placed) {
			expect(rect.x).toBeGreaterThanOrEqual(-1e-9);
			expect(rect.y).toBeGreaterThanOrEqual(-1e-9);
			expect(rect.x + rect.w).toBeLessThanOrEqual(RECT.w + 1e-9);
			expect(rect.y + rect.h).toBeLessThanOrEqual(RECT.h + 1e-9);
		}
	});

	it('never overlaps two siblings', () => {
		const placed = squarify(root.children, RECT).map((p) => p.rect);
		for (let i = 0; i < placed.length; i++) {
			for (let j = i + 1; j < placed.length; j++) {
				const a = placed[i] as (typeof placed)[number];
				const b = placed[j] as (typeof placed)[number];
				const disjoint =
					a.x + a.w <= b.x + 1e-9 ||
					b.x + b.w <= a.x + 1e-9 ||
					a.y + a.h <= b.y + 1e-9 ||
					b.y + b.h <= a.y + 1e-9;
				expect(disjoint).toBe(true);
			}
		}
	});

	it('keeps rectangles closer to square than slice-and-dice would', () => {
		// The point of squarifying: no sliver worse than ~8:1 on this data, where a single-axis split
		// of five values into 400×300 would produce a 60:1 strip for the smallest.
		const placed = squarify(root.children, RECT);
		for (const { rect } of placed) {
			expect(Math.max(rect.w / rect.h, rect.h / rect.w)).toBeLessThan(8);
		}
	});

	it('degenerates safely on empty input and zero-area frames', () => {
		expect(squarify([], RECT)).toEqual([]);
		expect(squarify(root.children, { x: 0, y: 0, w: 0, h: 200 })).toEqual([]);
	});
});

describe('treemapLayout', () => {
	it('nests children inside their parent rectangle', () => {
		const tiles = treemapLayout(root, { x: 0, y: 0, w: 600, h: 400 }, 2);
		const parent = tiles.find((t) => t.item.path === '/blog' && t.level === 1);
		const child = tiles.find((t) => t.item.path === '/blog/a');
		expect(parent).toBeDefined();
		expect(child?.level).toBe(2);
		expect(child?.x).toBeGreaterThanOrEqual(parent?.x as number);
		expect((child?.x as number) + (child?.w as number)).toBeLessThanOrEqual(
			(parent?.x as number) + (parent?.w as number) + 1e-9,
		);
		expect((child?.y as number) + (child?.h as number)).toBeLessThanOrEqual(
			(parent?.y as number) + (parent?.h as number) + 1e-9,
		);
	});

	it('stops nesting at the requested level', () => {
		const tiles = treemapLayout(root, { x: 0, y: 0, w: 600, h: 400 }, 1);
		expect(tiles.every((t) => t.level === 1)).toBe(true);
	});
});

describe('PathTreeExplorer', () => {
	it('drills on click, updates the breadcrumb and jumps back from it', () => {
		render(<PathTreeExplorer tree={TREE} variant="sunburst" levels={3} />);
		const nav = screen.getByRole('navigation', { name: /path tree position/i });
		expect(within(nav).getByText('/')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /open \/blog,/i }));
		expect(within(nav).getByText('/blog')).toBeInTheDocument();
		// A level deeper: the centre now offers the way back up.
		expect(screen.getByRole('button', { name: /back up from \/blog/i })).toBeTruthy();

		fireEvent.click(within(nav).getByRole('button', { name: '/' }));
		expect(within(nav).queryByRole('button', { name: '/' })).toBeNull();
		expect(within(nav).getByText('/')).toBeInTheDocument();
	});

	it('opens a slice from the keyboard with Enter and with Space', () => {
		render(<PathTreeExplorer tree={TREE} variant="sunburst" levels={3} />);
		const nav = screen.getByRole('navigation', { name: /path tree position/i });
		const slice = screen.getByRole('button', { name: /open \/blog,/i });
		expect(slice).toHaveAttribute('tabindex', '0');
		fireEvent.keyDown(slice, { key: 'Enter' });
		expect(within(nav).getByText('/blog')).toBeInTheDocument();

		fireEvent.keyDown(screen.getByRole('button', { name: /back up from \/blog/i }), {
			key: ' ',
		});
		expect(within(nav).queryByText('/blog')).toBeNull();
	});

	it('keeps the drill position when the representation changes', () => {
		const { rerender } = render(<PathTreeExplorer tree={TREE} variant="sunburst" levels={3} />);
		fireEvent.click(screen.getByRole('button', { name: /open \/blog,/i }));
		rerender(<PathTreeExplorer tree={TREE} variant="treemap" levels={3} />);
		const nav = screen.getByRole('navigation', { name: /path tree position/i });
		expect(within(nav).getByText('/blog')).toBeInTheDocument();
		expect(screen.getByRole('group', { name: /treemap, showing inside \/blog/i })).toBeTruthy();
	});

	it('never offers an aggregate or a self slice as something to open', () => {
		render(<PathTreeExplorer tree={TREE} variant="treemap" levels={3} />);
		for (const button of screen.getAllByRole('button')) {
			const label = button.getAttribute('aria-label') ?? button.textContent ?? '';
			expect(label).not.toMatch(/open .*other/i);
			expect(label).not.toMatch(/this page/i);
		}
	});

	it('ships the whole tree as a text equivalent, not just the visible level', () => {
		render(<PathTreeExplorer tree={TREE} variant="sunburst" levels={3} />);
		const table = screen.getByRole('table');
		expect(table).toHaveClass('sr-only');
		expect(table.querySelector('caption')?.textContent).toMatch(
			/600 pageviews across 9 paths.*grouped as "Other"/,
		);
		// One row per node in the normalized tree, including the folded aggregates and self slices.
		expect(table.querySelectorAll('tbody tr')).toHaveLength(flattenTree(root).length);
		expect(within(table).getByRole('rowheader', { name: '/blog/a' })).toBeInTheDocument();
		expect(
			within(table).getByRole('rowheader', { name: '/blog (this page only)' }),
		).toBeInTheDocument();
		expect(
			within(table).getByRole('rowheader', { name: 'Other pages under /' }),
		).toBeInTheDocument();
	});

	it('leaves the breadcrumb path names selectable even though buttons are not', () => {
		render(<PathTreeExplorer tree={TREE} variant="sunburst" levels={3} />);
		fireEvent.click(screen.getByRole('button', { name: /open \/blog,/i }));
		const nav = screen.getByRole('navigation', { name: /path tree position/i });
		expect(nav).toHaveAttribute('data-chrome');
		for (const crumb of ['/', '/blog']) {
			expect(within(nav).getByText(crumb)).toHaveAttribute('data-selectable');
		}
	});
});

// --- Contrast -------------------------------------------------------------------------------------
// Every label these charts paint sits ON a slice, and a slice fill is `color-mix(in srgb, <hue> N%,
// var(--panel))`. This reads the real token values out of index.css and checks the worst case — the
// strongest tint this code can produce, MAX_TINT — against --ink, for all five palettes in both modes.

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.css'), 'utf8');

/** Every `--token: value;` declaration inside the first block whose selector matches. */
function block(selector: string): Record<string, string> {
	const start = CSS.indexOf(selector);
	if (start < 0) throw new Error(`missing CSS block: ${selector}`);
	const open = CSS.indexOf('{', start);
	const close = CSS.indexOf('}', open);
	const out: Record<string, string> = {};
	for (const line of CSS.slice(open + 1, close).split('\n')) {
		const match = /^\s*(--[\w-]+)\s*:\s*([^;]+);/.exec(line);
		if (match?.[1] && match[2]) out[match[1]] = match[2].trim();
	}
	return out;
}

const hex = (value: string): [number, number, number] => {
	const m = /^#([0-9a-f]{6})$/i.exec(value.trim());
	if (!m?.[1]) throw new Error(`not a hex colour: ${value}`);
	const n = Number.parseInt(m[1], 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** `color-mix(in srgb, a p%, b)` is a straight per-channel blend in sRGB space. */
const mix = (
	a: [number, number, number],
	b: [number, number, number],
	p: number,
): [number, number, number] => [
	a[0] * p + b[0] * (1 - p),
	a[1] * p + b[1] * (1 - p),
	a[2] * p + b[2] * (1 - p),
];

function luminance([r, g, b]: [number, number, number]): number {
	const lin = (c: number): number => {
		const s = c / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
}

const PALETTES = ['prism', 'bio', 'aurora', 'fintech', 'cloudflare'] as const;

describe('slice label contrast', () => {
	const light = block("[data-mode='light']");

	it.each(PALETTES)('clears 4.5:1 on every hue of %s, dark and light', (palette) => {
		const dark = block(`[data-palette='${palette}']`);
		const modes = [
			{ name: 'dark', panel: dark['--panel'] as string, ink: dark['--ink'] as string },
			{ name: 'light', panel: light['--panel'] as string, ink: light['--ink'] as string },
		];
		for (const mode of modes) {
			for (let i = 1; i <= 6; i++) {
				const hue = dark[`--c${i}`];
				expect(hue, `${palette} --c${i}`).toBeDefined();
				const fill = mix(hex(hue as string), hex(mode.panel), MAX_TINT / 100);
				const ratio = contrast(fill, hex(mode.ink));
				expect(
					ratio,
					`${palette}/${mode.name} --c${i} at ${MAX_TINT}% → ${ratio.toFixed(2)}:1`,
				).toBeGreaterThanOrEqual(4.5);
			}
			// The neutral fill an `other` aggregate gets, at its own worst case.
			const neutral = mix(
				hex(
					mode.name === 'light'
						? (light['--muted'] as string)
						: (dark['--muted'] as string),
				),
				hex(mode.panel),
				(MAX_TINT * 0.7) / 100,
			);
			expect(contrast(neutral, hex(mode.ink))).toBeGreaterThanOrEqual(4.5);
		}
	});
});
