export interface Rect {
	x: number
	y: number
	w: number
	h: number
}

// tldraw label text: 's' size is 18px with a 1.35 line height and 16px padding on every side.
// The server has no text measurer, so this is an estimate that errs on the side of too tall.
const LINE_HEIGHT = 1.35
const PADDING = 16

export interface TextMetrics {
	fontPx: number
	charPx: number
}
// Measured from the rendered result: sans 's' is ~8px per character, handwritten 'm' (notes) ~12px.
export const SANS_S: TextMetrics = { fontPx: 18, charPx: 8.5 }
export const DRAW_M: TextMetrics = { fontPx: 22, charPx: 12.5 }

export function textBlockHeight(text: string, width: number, m: TextMetrics = SANS_S): number {
	const maxChars = Math.max(8, Math.floor((width - PADDING * 2) / m.charPx))
	let lines = 0
	for (const paragraph of text.split('\n')) {
		let used = 0
		let paragraphLines = 1
		for (const word of paragraph.split(/\s+/).filter(Boolean)) {
			// Words longer than a line are broken across lines.
			const len = word.length
			if (used > 0 && used + 1 + len > maxChars) {
				paragraphLines++
				used = 0
			}
			used += (used > 0 ? 1 : 0) + len
			while (used > maxChars) {
				paragraphLines++
				used -= maxChars
			}
		}
		lines += paragraphLines
	}
	return Math.ceil(lines * m.fontPx * LINE_HEIGHT + PADDING * 2)
}

export const GAP = 32

export const overlaps = (a: Rect, b: Rect, gap = 0) =>
	a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y

const STEP = 40
const RADIUS_STEPS = 60
const ROW_SCAN_WIDTH = 2400
const ROW_SCAN_ROWS = 120

export interface Point {
	x: number
	y: number
}

// Candidate top-left corners for a w x h block next to `anchor`, in reading order of preference:
// right, below, left, above. All aligned to the anchor's edge.
export function sidesOf(anchor: Rect, w: number, h: number, gap = GAP): Point[] {
	return [
		{ x: anchor.x + anchor.w + gap, y: anchor.y },
		{ x: anchor.x, y: anchor.y + anchor.h + gap },
		{ x: anchor.x - w - gap, y: anchor.y },
		{ x: anchor.x, y: anchor.y - h - gap },
	]
}

// Shapes joined by arrows need room for the arrow (and its label) to be visible between them.
export const DIAGRAM_GAP = 112

// Does the straight segment a -> b pass through the rectangle? (Liang-Barsky clipping.)
export function segmentHitsRect(a: Point, b: Point, r: Rect): boolean {
	let t0 = 0
	let t1 = 1
	const dx = b.x - a.x
	const dy = b.y - a.y
	for (const [p, q] of [
		[-dx, a.x - r.x],
		[dx, r.x + r.w - a.x],
		[-dy, a.y - r.y],
		[dy, r.y + r.h - a.y],
	] as const) {
		if (p === 0) {
			if (q < 0) return false
		} else {
			const t = q / p
			if (p < 0) t0 = Math.max(t0, t)
			else t1 = Math.min(t1, t)
			if (t0 > t1) return false
		}
	}
	return true
}

// A line the layout must keep clear: the straight run of an arrow between two shapes.
export type Segment = [Point, Point]

// Free = clear of every shape (plus `gap`) and of every arrow line (also within `gap`, so curved arrows stay clear).
export function isFree(obstacles: Rect[], segments: Segment[], r: Rect, gap = GAP): boolean {
	if (obstacles.some((o) => overlaps(r, o, gap))) return false
	const padded = { x: r.x - gap, y: r.y - gap, w: r.w + 2 * gap, h: r.h + 2 * gap }
	return !segments.some(([a, b]) => segmentHitsRect(a, b, padded))
}

export interface Placement {
	/** Tried first, in order. The first one that is free wins. */
	prefer: Point[]
	/** When none of `prefer` is free, search outward from here for the nearest free spot. */
	fallback: Point
	/** Clear space to keep around other shapes. Defaults to GAP. */
	gap?: number
	/** Arrow lines to keep clear as well. */
	segments?: Segment[]
}

// Finds a free w x h rectangle. Never returns a spot that overlaps an obstacle (plus GAP), so agent-made
// blocks cannot land on top of anything already on the canvas.
export function findFreeRect(obstacles: Rect[], w: number, h: number, where: Placement): Rect {
	const gap = where.gap ?? GAP
	const segments = where.segments ?? []
	const free = (x: number, y: number) => isFree(obstacles, segments, { x, y, w, h }, gap)
	for (const p of where.prefer) if (free(p.x, p.y)) return { ...p, w, h }
	const origin = where.prefer[0] ?? where.fallback

	if (where.prefer.length === 0) {
		// No anchor: fill the canvas like text, left to right then top to bottom from the origin, so new
		// content forms a tidy block instead of scattering in every direction.
		if (free(origin.x, origin.y)) return { ...origin, w, h }
		for (let row = 0; row < ROW_SCAN_ROWS; row++) {
			const y = origin.y + row * STEP
			for (let x = origin.x; x <= origin.x + ROW_SCAN_WIDTH; x += STEP) if (free(x, y)) return { x, y, w, h }
		}
	}

	const cx = Math.round(origin.x / STEP) * STEP
	const cy = Math.round(origin.y / STEP) * STEP
	// Search square rings of growing radius; inside a ring, prefer the candidate nearest the origin.
	for (let r = 1; r <= RADIUS_STEPS; r++) {
		let best: { x: number; y: number; d: number } | null = null
		for (let i = -r; i <= r; i++) {
			for (const [dx, dy] of [
				[i, -r],
				[i, r],
				[-r, i],
				[r, i],
			] as const) {
				const x = cx + dx * STEP
				const y = cy + dy * STEP
				const d = Math.hypot(x - origin.x, y - origin.y)
				if ((!best || d < best.d) && free(x, y)) best = { x, y, d }
			}
		}
		if (best) return { x: best.x, y: best.y, w, h }
	}
	// Nothing nearby: put it below everything.
	const bottom = obstacles.reduce((m, o) => Math.max(m, o.y + o.h), origin.y)
	return { x: origin.x, y: bottom + gap, w, h }
}
