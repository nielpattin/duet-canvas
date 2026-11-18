import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TLSyncStorageTransaction } from '@tldraw/sync-core'
import {
	createBindingId,
	createShapeId,
	toRichText,
	type TLArrowBinding,
	type TLAsset,
	type TLBinding,
	type TLPage,
	type TLRecord,
	type TLRichText,
	type TLShape,
	b64Vecs,
} from '@tldraw/tlschema'
import { getIndexAbove, getIndexBelow, type IndexKey } from '@tldraw/utils'
import { z } from 'zod'
import { safeId, UPLOADS } from './config.ts'
import { CAPTION_H, MEDIA_CARD, schema } from './mediaCard.ts'
import { sniffMedia } from './media.ts'
import { DIAGRAM_GAP, DRAW_M, findFreeRect, freeRectNear, GAP, isFree, overlaps, segmentHitsRect, sidesOf, textBlockHeight, type Point, type Rect, type Segment } from './layout.ts'
import { room } from './room.ts'
import { getUiContext } from './uiContext.ts'

// ---- Simplified schema the agent works with -------------------------------------------------

const COLORS = [
	'black',
	'grey',
	'light-violet',
	'violet',
	'blue',
	'light-blue',
	'yellow',
	'orange',
	'green',
	'light-green',
	'light-red',
	'red',
	'white',
] as const
const FILLS = ['none', 'semi', 'solid', 'pattern'] as const
const GEOS = ['rectangle', 'ellipse', 'diamond', 'triangle', 'hexagon', 'star', 'cloud'] as const

export const ShapeInput = z.object({
	id: z
		.string()
		.optional()
		.describe('Optional stable id (e.g. "login-box"). Use it to reference the shape from arrows.'),
	type: z.enum([...GEOS, 'text', 'note', 'arrow']),
	x: z.number().optional().describe('Page x of top-left. Omit x and y to let the server pick a free spot.'),
	y: z.number().optional().describe('Page y of top-left. Omit x and y to let the server pick a free spot.'),
	near: z.string().optional().describe('When x/y are omitted: place next to this shape id.'),
	w: z.number().optional().describe('Width (geo shapes and text)'),
	h: z.number().optional().describe('Height (geo shapes)'),
	text: z.string().optional().describe('Label / content'),
	color: z.enum(COLORS).optional(),
	fill: z.enum(FILLS).optional(),
	from: z.string().optional().describe('Arrow only: id of the shape the arrow starts at'),
	to: z.string().optional().describe('Arrow only: id of the shape the arrow ends at'),
	x2: z.number().optional().describe('Arrow only: end point x when `to` is not given'),
	y2: z.number().optional().describe('Arrow only: end point y when `to` is not given'),
	route: z
		.enum(['straight', 'curve', 'elbow'])
		.optional()
		.describe(
			'Arrow only: "straight" (default, tidy flows), "curve" (gentle arc, good for maps and trees that fan out) or "elbow" (right angles, good for loops)'
		),
})
export type ShapeInput = z.infer<typeof ShapeInput>

export const ShapePatch = z.object({
	id: z.string(),
	x: z.number().optional(),
	y: z.number().optional(),
	w: z.number().optional(),
	h: z.number().optional(),
	text: z.string().optional(),
	color: z.enum(COLORS).optional(),
	fill: z.enum(FILLS).optional(),
})
export type ShapePatch = z.infer<typeof ShapePatch>

// ---- Conventions stored in shape.meta ---------------------------------------------------------
//
// author   'agent' on everything the agent made. Shapes without it belong to the user.
// kind     'mark'   a user note aimed at the canvas or at specific shapes (targetIds)
//          'agent-reply'  an agent text block answering a mark (replyTo)
//          'agent-note'   an agent text block that is not an answer
//          'link'         an arrow that only connects a reply to what it answers
//          'region'       the locked dashed box a mark draws around a selection (mark.meta.regionId)
//          'reply-label'  the locked "↩ quote" line on top of an agent-reply; a child of the reply, so it moves with it
//          'answered-badge' the locked green ✓ on the corner of an answered mark; a child of the mark
// status   marks: 'open' | 'answered'
//          agent-reply: 'pending' while the agent is still working on it (a dashed "Thinking…" placeholder
//          that replyToMark later fills in place); no status once it holds the answer

interface BlockMeta {
	author?: string
	kind?: string
	status?: string
	targetIds?: string[]
	regionId?: string
	replyTo?: string
	answeredBy?: string
}
const metaOf = (s: TLShape) => s.meta as BlockMeta

// ---- Helpers ---------------------------------------------------------------------------------

function normShapeId(id: string) {
	return id.startsWith('shape:') ? (id as TLShape['id']) : createShapeId(id)
}

interface RichTextNode {
	type?: string
	text?: string
	content?: RichTextNode[]
}

function richTextToString(rt: TLRichText | undefined): string {
	if (!rt) return ''
	const walk = (node: RichTextNode): string => {
		if (typeof node.text === 'string') return node.text
		const inner = (node.content ?? []).map(walk)
		return node.type === 'doc' ? inner.join('\n') : inner.join('')
	}
	return walk(rt as RichTextNode)
}

// The props fields we read across shape types. Shape props are a per-type union, so we view them
// through one loose shape instead of narrowing per type.
interface LooseProps {
	w?: number
	h?: number
	growY?: number
	scale?: number
	geo?: string
	color?: string
	fill?: string
	richText?: TLRichText
	assetId?: string | null
	kind?: string
	src?: string
	mimeType?: string
	name?: string
	caption?: string
	autoSize?: boolean
}
const propsOf = (s: TLShape) => s.props as unknown as LooseProps
const textOf = (s: TLShape) => richTextToString(propsOf(s).richText)

const isShape = (r: TLRecord): r is TLShape => r.typeName === 'shape'
const isBinding = (r: TLRecord): r is TLBinding => r.typeName === 'binding'
const isArrowBinding = (r: TLRecord): r is TLArrowBinding => isBinding(r) && r.type === 'arrow'
const isPage = (r: TLRecord): r is TLPage => r.typeName === 'page'

type Txn = TLSyncStorageTransaction<TLRecord>

const isPending = (s: TLShape) => metaOf(s).kind === 'agent-reply' && metaOf(s).status === 'pending'

// A pending placeholder with its link arrow(s) and their bindings (or only `only`'s).
function pendingIds(all: TLRecord[], only?: TLShape): Set<string> {
	const ids = new Set<string>(all.filter(isShape).filter((s) => (only ? s.id === only.id : isPending(s))).map((s) => s.id))
	for (const s of all.filter(isShape)) if (ids.has(s.parentId)) ids.add(s.id) // its quote label
	for (const r of all) if (isBinding(r) && ids.has(r.toId)) ids.add(r.fromId)
	for (const r of all) if (isBinding(r) && (ids.has(r.fromId) || ids.has(r.toId))) ids.add(r.id)
	return ids
}

// Everything the agent reads goes through here. It never sees pending placeholders: shown a "Thinking…" block it
// deleted it as stale, in parallel with filling it, and lost its own answer. They still count as taken space.
// Quote labels and answered badges are decoration of their parent, not content.
const DECORATION: Record<string, true> = { 'reply-label': true, 'answered-badge': true }

const readAll = (): TLRecord[] =>
	room.storage.transaction((txn) => {
		const all = Array.from(txn.values())
		const hidden = pendingIds(all)
		return all.filter((r) => !hidden.has(r.id) && !(isShape(r) && DECORATION[metaOf(r).kind ?? '']))
	}).result

function pageOf(shape: TLShape, byId: Map<string, TLRecord>): string | null {
	let parent: string = shape.parentId
	for (let i = 0; i < 50; i++) {
		if (parent.startsWith('page:')) return parent
		const next = byId.get(parent)
		if (!next || !isShape(next)) return null
		parent = next.parentId
	}
	return null
}

function sizeOf(shape: TLShape): { w: number; h: number } {
	const p = propsOf(shape)
	if (shape.type === 'note') {
		// Notes grow with their text once a browser has laid them out; until then, estimate it ourselves.
		const scale = p.scale ?? 1
		const grown = (200 + (p.growY ?? 0)) * scale
		return { w: 200 * scale, h: Math.max(grown, textBlockHeight(textOf(shape), 200 * scale, DRAW_M)) }
	}
	if (shape.type === MEDIA_CARD) return { w: p.w ?? 0, h: (p.h ?? 0) + CAPTION_H }
	if (shape.type === 'text' && typeof p.w === 'number') return { w: p.w, h: textBlockHeight(textOf(shape), p.w) }
	if (typeof p.w === 'number') return { w: p.w, h: (p.h ?? 0) + (p.growY ?? 0) }
	return { w: 0, h: 0 }
}

// Bounding box of a shape for layout purposes. Arrows take no space; freehand strokes are encoded
// so we only know where they start and reserve a small box there.
function rectOf(shape: TLShape): Rect | null {
	if (shape.type === 'arrow') return null
	const { w, h } = sizeOf(shape)
	return { x: shape.x, y: shape.y, w: w || 40, h: h || 40 }
}

function obstaclesOn(all: TLRecord[], pageId: string): Rect[] {
	return all
		.filter(isShape)
		.filter((s) => s.parentId === pageId)
		.map(rectOf)
		.filter((r): r is Rect => r !== null)
}

// Straight lines between the two ends of every bound arrow on the page. New content must stay off them too.
function segmentsOn(all: TLRecord[], pageId: string): Segment[] {
	const rects = new Map<string, Rect>()
	for (const s of all.filter(isShape)) {
		const r = s.parentId === pageId ? rectOf(s) : null
		if (r) rects.set(s.id, r)
	}
	const ends = new Map<string, { start?: Point; end?: Point }>()
	for (const b of all.filter(isArrowBinding)) {
		const r = rects.get(b.toId)
		if (r) ends.set(b.fromId, { ...ends.get(b.fromId), [b.props.terminal]: { x: r.x + r.w / 2, y: r.y + r.h / 2 } })
	}
	return [...ends.values()].flatMap((e) => (e.start && e.end ? [[e.start, e.end] as Segment] : []))
}

// ---- Reading ---------------------------------------------------------------------------------

function describeOne(s: TLShape, records: TLRecord[], byId: Map<string, TLRecord>, bindings: TLArrowBinding[]) {
	const p = propsOf(s)
	const m = metaOf(s)
	const { w, h } = sizeOf(s)
	const out: Record<string, unknown> = {
		id: s.id,
		type: s.type === 'geo' ? p.geo : s.type,
		x: Math.round(s.x),
		y: Math.round(s.y),
		author: m.author ?? 'user',
	}
	const pid = pageOf(s, byId)
	if (pid) Object.assign(out, { pageId: pid, pageName: (byId.get(pid) as TLPage | undefined)?.name })
	if (w || h) Object.assign(out, { w: Math.round(w), h: Math.round(h) })
	const text = textOf(s)
	if (text) out.text = text
	if (p.color) out.color = p.color
	if (m.kind) out.kind = m.kind
	if (m.kind === 'mark') Object.assign(out, { status: m.status ?? 'open', targetIds: m.targetIds ?? [] })
	if (m.status === 'pending') out.status = 'pending'
	if (m.replyTo) out.replyTo = m.replyTo
	if (s.type === MEDIA_CARD) {
		out.type = 'media'
		if (p.caption) out.text = p.caption
		out.media = { kind: p.kind, name: p.name, mimeType: p.mimeType, src: p.src, ...(p.kind === 'image' ? { seeWith: 'view_image' } : {}) }
	} else if (s.type === 'image' || s.type === 'video') {
		const asset = p.assetId ? (byId.get(p.assetId) as TLAsset | undefined) : undefined
		const props = asset && (asset.type === 'image' || asset.type === 'video') ? asset.props : undefined
		out.media = { kind: s.type, name: props?.name, mimeType: props?.mimeType, ...(s.type === 'image' ? { seeWith: 'view_image' } : {}) }
	}
	if (s.parentId !== pageOf(s, byId)) out.parentId = s.parentId
	if (s.type === 'arrow') {
		for (const b of bindings.filter((b) => b.fromId === s.id)) {
			out[b.props.terminal === 'start' ? 'from' : 'to'] = b.toId
		}
	}
	void records
	return out
}

export function describeShapes(shapeIds?: string[], pageId?: string) {
	const records = readAll()
	const byId = new Map(records.map((r) => [r.id as string, r]))
	const bindings = records.filter(isArrowBinding)
	const wanted = shapeIds && new Set(shapeIds.map(normShapeId))

	return records
		.filter(isShape)
		.filter((s) => !wanted || wanted.has(s.id))
		.filter((s) => !pageId || pageOf(s, byId) === pageId)
		.map((s) => describeOne(s, records, byId, bindings))
}

// Shape count per page, so the agent can see where things are without reading every shape.
export function pageCounts(): Record<string, number> {
	const records = readAll()
	const byId = new Map(records.map((r) => [r.id as string, r]))
	const counts: Record<string, number> = {}
	for (const s of records.filter(isShape)) {
		const pid = pageOf(s, byId)
		if (pid && s.type !== 'arrow') counts[pid] = (counts[pid] ?? 0) + 1
	}
	return counts
}

export function listPages() {
	return readAll()
		.filter(isPage)
		.map((p) => ({ id: p.id as string, name: p.name }))
}

// Every shape and binding id in the document. A browser tab must have all of them before it can render what the
// agent just wrote: sync is asynchronous, so the server returns before the tab has caught up.
export function syncIds(): string[] {
	return readAll()
		.filter((r) => isShape(r) || isBinding(r))
		.map((r) => r.id as string)
}

// Where content already is, so the agent can reason about free space.
export function contentBounds(pageId?: string) {
	const records = readAll()
	const byId = new Map(records.map((r) => [r.id as string, r]))
	const rects = records
		.filter(isShape)
		.filter((s) => !pageId || pageOf(s, byId) === pageId)
		.map(rectOf)
		.filter((r): r is Rect => r !== null)
	if (rects.length === 0) return null
	const x1 = Math.min(...rects.map((r) => r.x))
	const y1 = Math.min(...rects.map((r) => r.y))
	const x2 = Math.max(...rects.map((r) => r.x + r.w))
	const y2 = Math.max(...rects.map((r) => r.y + r.h))
	return { x: Math.round(x1), y: Math.round(y1), w: Math.round(x2 - x1), h: Math.round(y2 - y1) }
}

// ---- Marks -----------------------------------------------------------------------------

// The earlier turns of a conversation, oldest first: what the user wrote, what the agent answered and the box it
// was about. A mark continues a conversation when it is aimed at one of the agent's replies, or at a box that an
// earlier, answered mark already used. A chain of replies is followed up to 6 deep.
function threadOf(mark: TLShape, records: TLRecord[], byId: Map<string, TLRecord>, depth = 6): Record<string, unknown>[] {
	if (depth === 0) return []
	const earlier = new Map<string, TLShape>()
	for (const id of metaOf(mark).targetIds ?? []) {
		const reply = byId.get(id)
		const first = reply && isShape(reply) && metaOf(reply).kind === 'agent-reply' ? byId.get(metaOf(reply).replyTo as string) : undefined
		if (first && isShape(first)) earlier.set(first.id, first)
	}
	const regionId = metaOf(mark).regionId
	if (regionId) {
		for (const r of records) {
			if (isShape(r) && r.id !== mark.id && metaOf(r).kind === 'mark' && metaOf(r).regionId === regionId && metaOf(r).answeredBy) earlier.set(r.id, r)
		}
	}
	const turns: Record<string, unknown>[] = []
	for (const first of [...earlier.values()].sort((a, b) => (a.index < b.index ? -1 : 1))) {
		const answer = metaOf(first).answeredBy ? byId.get(metaOf(first).answeredBy as string) : undefined
		const region = metaOf(first).regionId ? byId.get(metaOf(first).regionId as string) : undefined
		const box = region && isShape(region) ? rectOf(region) : undefined
		turns.push(...threadOf(first, records, byId, depth - 1), {
			markId: first.id,
			user: textOf(first),
			...(answer && isShape(answer) ? { agent: textOf(answer) } : {}),
			...(box ? { selection: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) } } : {}),
		})
	}
	return turns
}

export function listMarks(status: 'open' | 'answered' | 'all' = 'open') {
	const records = readAll()
	const byId = new Map(records.map((r) => [r.id as string, r]))
	const bindings = records.filter(isArrowBinding)
	return records
		.filter(isShape)
		.filter((s) => metaOf(s).kind === 'mark')
		.filter((s) => textOf(s).trim() !== '') // an empty note is a draft the user has not written yet
		.filter((s) => status === 'all' || (metaOf(s).status ?? 'open') === status)
		.map((s) => {
			const m = metaOf(s)
			const region = m.regionId ? byId.get(m.regionId) : undefined
			const box = region && isShape(region) ? rectOf(region) : undefined
			const thread = threadOf(s, records, byId)
			return {
				...describeOne(s, records, byId, bindings),
				...(thread.length > 0 ? { thread } : {}),
				...(box ? { selection: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) } } : {}),
				targets: (m.targetIds ?? [])
					.map((id) => byId.get(id))
					.filter((t): t is TLShape => !!t && isShape(t))
					.map((t) => describeOne(t, records, byId, bindings)),
				answeredBy: m.answeredBy,
			}
		})
}

// ---- Writing ---------------------------------------------------------------------------------

function validated<T extends TLRecord>(record: T): T {
	const type = schema.types[record.typeName as 'shape' | 'binding' | 'asset' | 'page']
	return type.validate(record) as T
}

export function createPage(name: string) {
	return room.storage.transaction((txn) => {
		const pages = Array.from(txn.values()).filter(isPage)
		if (pages.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new Error(`A page named "${name}" already exists`)
		const last = pages.map((p) => p.index).sort().at(-1)
		const page = validated({
			id: `page:${crypto.randomUUID()}` as TLPage['id'],
			typeName: 'page',
			name,
			index: getIndexAbove(last),
			meta: {},
		} as TLPage)
		txn.set(page.id, page)
		return { id: page.id as string, name }
	}).result
}

export function resolvePageId(requested?: string): string {
	const pages = listPages()
	if (requested) {
		if (!pages.some((p) => p.id === requested)) throw new Error(`Unknown page ${requested}`)
		return requested
	}
	// Prefer the page the user is looking at.
	const current = getUiContext()?.currentPageId
	if (current && pages.some((p) => p.id === current)) return current
	if (!pages[0]) throw new Error('Canvas has no pages yet. Open the web app once to initialize it.')
	return pages[0].id
}

// Arrows are drawn behind every block: they get an index below everything else on the page.
function arrowIndex(all: TLRecord[], pageId: string): IndexKey {
	const lowest = all
		.filter(isShape)
		.filter((s) => s.parentId === pageId)
		.map((s) => s.index)
		.sort()[0]
	return getIndexBelow(lowest)
}

function topIndex(all: TLRecord[], pageId: string): IndexKey | undefined {
	return all
		.filter(isShape)
		.filter((s) => s.parentId === pageId)
		.map((s) => s.index)
		.sort()
		.at(-1)
}

// Preferred spot for new content with no anchor: the top-left of what the user is looking at.
function viewportCorner(pageId: string): Point {
	const ui = getUiContext()
	if (ui && ui.currentPageId === pageId) return { x: ui.viewport.x + 80, y: ui.viewport.y + 100 } // clear of tldraw's top menu and side panel
	return { x: 0, y: 0 }
}


interface Common {
	pageId: string
	index: IndexKey
	meta: BlockMeta
}

function buildShape(
	input: ShapeInput,
	c: Common,
	size: { w: number; h: number },
	lookup: (id: string) => TLShape | undefined
): TLShape {
	const id = input.id ? normShapeId(input.id) : createShapeId()
	const base = {
		id,
		typeName: 'shape' as const,
		x: input.x ?? 0,
		y: input.y ?? 0,
		rotation: 0,
		index: c.index,
		parentId: c.pageId,
		isLocked: false,
		opacity: 1,
		meta: c.meta as TLShape['meta'],
	}
	const color = input.color ?? 'black'
	const richText = toRichText(input.text ?? '')

	if (input.type === 'text') {
		return {
			...base,
			type: 'text',
			props: {
				color,
				size: 'm',
				font: 'draw',
				textAlign: 'start',
				w: size.w,
				richText,
				scale: 1,
				autoSize: input.w === undefined,
			},
		} as TLShape
	}
	if (input.type === 'note') {
		return {
			...base,
			type: 'note',
			props: {
				color: input.color ?? 'yellow',
				labelColor: 'black',
				size: 'm',
				font: 'draw',
				fontSizeAdjustment: null, // null = the editor recomputes it; 0 would shrink the text to nothing
				align: 'middle',
				verticalAlign: 'middle',
				growY: 0,
				url: '',
				richText,
				scale: 1,
				textLastEditedBy: null,
			},
		} as TLShape
	}
	if (input.type === 'arrow') {
		const from = input.from ? lookup(normShapeId(input.from)) : undefined
		const to = input.to ? lookup(normShapeId(input.to)) : undefined
		if (input.from && !from) throw new Error(`Arrow ${id}: unknown "from" shape ${input.from}`)
		if (input.to && !to) throw new Error(`Arrow ${id}: unknown "to" shape ${input.to}`)
		const center = (s: TLShape) => {
			const { w, h } = sizeOf(s)
			return { x: s.x + w / 2, y: s.y + h / 2 }
		}
		const start = from ? center(from) : { x: input.x ?? 0, y: input.y ?? 0 }
		const end = to ? center(to) : { x: input.x2 ?? start.x + 150, y: input.y2 ?? start.y }
		return {
			...base,
			x: 0,
			y: 0,
			type: 'arrow',
			props: {
				kind: input.route === 'elbow' ? 'elbow' : 'arc',
				labelColor: 'black',
				color,
				fill: 'none',
				dash: 'draw',
				size: 'm',
				arrowheadStart: 'none',
				arrowheadEnd: 'arrow',
				font: 'draw',
				start,
				end,
				bend: input.route === 'curve' ? curveBend(start, end) : 0,
				richText,
				labelPosition: 0.5,
				scale: 1,
				elbowMidPoint: 0.5,
			},
		} as TLShape
	}
	return {
		...base,
		type: 'geo',
		props: {
			geo: input.type,
			dash: 'draw',
			url: '',
			w: size.w,
			h: size.h,
			growY: 0,
			scale: 1,
			flipX: false,
			flipY: false,
			labelColor: 'black',
			color,
			fill: input.fill ?? 'none',
			size: 'm',
			font: 'draw',
			align: 'middle',
			verticalAlign: 'middle',
			richText,
		},
	} as TLShape
}

// How far a "curve" arrow bows away from the straight line: a gentle arc that grows with the length.
function curveBend(a: Point, b: Point): number {
	return Math.round(Math.min(90, Math.max(24, Math.hypot(b.x - a.x, b.y - a.y) * 0.2)))
}

// The look of every text block the agent writes: a violet, sans-serif, left-aligned box. Together with
// meta.author = 'agent' this makes agent writing recognisable at a glance and unmistakable in the data.
function buildAgentBlock(text: string, rect: Rect, c: Common, quote?: string): TLShape {
	return validated({
		id: createShapeId(),
		typeName: 'shape',
		type: 'geo',
		x: rect.x,
		y: rect.y,
		rotation: 0,
		index: c.index,
		parentId: c.pageId,
		isLocked: false,
		opacity: 1,
		meta: c.meta as TLShape['meta'],
		props: {
			geo: 'rectangle',
			dash: 'solid',
			url: '',
			w: rect.w,
			h: rect.h,
			growY: 0,
			scale: 1,
			flipX: false,
			flipY: false,
			labelColor: 'black',
			color: 'light-violet',
			fill: 'solid',
			size: 's',
			font: 'sans',
			align: 'start',
			verticalAlign: 'start',
			richText: quote ? replyRichText(text) : toRichText(text),
		},
	} as TLShape)
}

// First line of every reply: the user's note it answers, so the reply is understood without following an arrow.
function quoteOf(ann: TLShape): string {
	const t = textOf(ann).replace(/\s+/g, ' ').trim()
	return `↩ “${t.length > QUOTE_CHARS ? `${t.slice(0, QUOTE_CHARS)}…` : t}”`
}

// The reply's own text starts two lines down: the first line is left empty for the quote label (see addQuoteLabel).
function replyRichText(text: string): TLRichText {
	return { type: 'doc', content: [{ type: 'paragraph' }, { type: 'paragraph' }, ...(toRichText(text).content as unknown[])] } as TLRichText
}

// The quote is a separate locked text shape, parented to the reply: violet instead of black, and it cannot be
// selected, edited or deleted on its own, yet it moves and is deleted with the reply.
function addQuoteLabel(txn: Txn, block: TLShape, quote: string) {
	const label = validated({
		id: createShapeId(),
		typeName: 'shape',
		type: 'text',
		x: 16, // tldraw's label padding
		y: 16,
		rotation: 0,
		index: 'a1' as IndexKey,
		parentId: block.id,
		isLocked: true,
		opacity: 1,
		meta: { author: 'agent', kind: 'reply-label' },
		props: {
			color: 'violet',
			size: 's',
			font: 'sans',
			textAlign: 'start',
			w: propsOf(block).w! - 32,
			richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: quote, marks: [{ type: 'italic' }] }] }] },
			scale: 1,
			autoSize: false,
		},
	} as unknown as TLShape)
	txn.set(label.id, label)
}

interface Anchors {
	start?: Point
	end?: Point
}

function arrowBinding(arrow: TLShape, target: TLShape, terminal: 'start' | 'end', anchor?: Point): TLBinding {
	return {
		id: createBindingId(),
		typeName: 'binding',
		type: 'arrow',
		fromId: arrow.id,
		toId: target.id,
		props: {
			terminal,
			normalizedAnchor: anchor ?? { x: 0.5, y: 0.5 },
			isExact: false,
			isPrecise: anchor !== undefined,
			snap: 'none',
		},
		meta: {},
	} as TLBinding
}

function bindArrow(txn: Txn, arrow: TLShape, from: TLShape | undefined, to: TLShape | undefined, anchors: Anchors = {}) {
	for (const [target, terminal, anchor] of [
		[from, 'start', anchors.start],
		[to, 'end', anchors.end],
	] as const) {
		if (!target) continue
		const binding = validated(arrowBinding(arrow, target, terminal, anchor))
		txn.set(binding.id, binding)
	}
}

// A thin grey arrow tying a reply to what it answers. kind 'link' keeps it out of the way when reading.
function addLink(txn: Txn, from: TLShape, to: TLShape, c: Common): TLShape {
	const arrow = validated(
		buildShape(
			{ type: 'arrow', from: from.id, to: to.id, color: 'grey', route: 'curve' },
			{ ...c, index: arrowIndex(Array.from(txn.values()), c.pageId), meta: { author: 'agent', kind: 'link' } },
			{ w: 0, h: 0 },
			(id) => (id === from.id ? from : id === to.id ? to : undefined)
		)
	)
	txn.set(arrow.id, arrow)
	bindArrow(txn, arrow, from, to)
	return arrow
}

export function createShapes(inputs: ShapeInput[], pageIdHint?: string, replace = false) {
	const pageId = resolvePageId(pageIdHint)
	return room.storage.transaction((txn) => {
		const all = Array.from(txn.values())
		// Shapes being recreated are about to be replaced, so they are not in the way of their own replacement.
		const replaced = replace ? new Set<string>(inputs.flatMap((i) => (i.id ? [normShapeId(i.id)] : []))) : new Set<string>()
		const rest = all.filter((r) => !replaced.has(r.id))
		const obstacles = obstaclesOn(rest, pageId)
		const segments = segmentsOn(rest, pageId)
		// Rect of every shape on the page by id, so arrows can be checked for crossing shapes.
		const rects = new Map<string, Rect>()
		for (const s of all.filter(isShape).filter((s) => s.parentId === pageId)) {
			const r = rectOf(s)
			if (r) rects.set(s.id, r)
		}
		// Shapes that arrows attach to need extra room around them so the arrows are visible.
		const connected = new Set(inputs.flatMap((i) => [i.from, i.to]).filter((id): id is string => !!id).map(normShapeId))
		let index = topIndex(all, pageId)
		let lowArrow = arrowIndex(all, pageId)
		const created = new Map<string, TLShape>()
		const lookup = (id: string) => created.get(id) ?? (txn.get(id) as TLShape | undefined)

		// A shape reached by an arrow is placed beside the shape the arrow comes from (right, then below, ...),
		// so a flow reads as a flow and a branch drops below its parent instead of stringing out in one row.
		const predecessor = new Map<string, string>()
		for (const i of inputs) {
			if (i.type === 'arrow' && i.from && i.to && !predecessor.has(normShapeId(i.to))) {
				predecessor.set(normShapeId(i.to), normShapeId(i.from))
			}
		}
		const nonArrows = inputs.filter((i) => i.type !== 'arrow')
		const byId = new Map<string, ShapeInput>(nonArrows.flatMap((i) => (i.id ? [[normShapeId(i.id), i] as const] : [])))
		const seen = new Set<ShapeInput>()
		const order: ShapeInput[] = []
		const visit = (i: ShapeInput) => {
			if (seen.has(i)) return
			seen.add(i)
			const parent = i.id ? byId.get(predecessor.get(normShapeId(i.id)) ?? '') : undefined
			if (parent) visit(parent) // place parents first
			order.push(i)
		}
		nonArrows.forEach(visit)
		// Arrows last, so they can reference shapes created in the same call.
		const ordered = [...order, ...inputs.filter((i) => i.type === 'arrow')]
		const result: { id: string; x?: number; y?: number; w?: number; h?: number; placed?: boolean }[] = []
		const warnings: string[] = []

		const sizeFor = (input: ShapeInput) => {
			const text = input.text ?? ''
			// A diamond only has room for text in its middle, so it needs to be bigger than a box to fit a label.
			const w = input.w ?? (input.type === 'text' || input.type === 'note' ? 200 : input.type === 'diamond' ? 200 : 160)
			const h =
				input.type === 'note'
					? 200
					: input.h ??
						Math.max(input.type === 'text' ? 40 : input.type === 'diamond' ? 130 : 100, text ? textBlockHeight(text, w) : 0)
			return { w, h }
		}

		// Shapes given explicit x/y are one drawing (a wireframe, a diagram). If it lands on existing shapes or arrows,
		// the whole drawing slides to the nearest free space as a unit, so its parts keep their layout.
		let dx = 0
		let dy = 0
		const drawn = nonArrows.filter((i) => i.x !== undefined && i.y !== undefined).map((i) => ({ x: i.x!, y: i.y!, ...sizeFor(i) }))
		if (drawn.length) {
			const x = Math.min(...drawn.map((r) => r.x))
			const y = Math.min(...drawn.map((r) => r.y))
			const box = { x, y, w: Math.max(...drawn.map((r) => r.x + r.w)) - x, h: Math.max(...drawn.map((r) => r.y + r.h)) - y }
			if (!isFree(obstacles, segments, box)) {
				const spot = findFreeRect(obstacles, box.w, box.h, { prefer: [box], fallback: box, segments })
				dx = spot.x - x
				dy = spot.y - y
			}
		}

		for (const input of ordered) {
			const isArrow = input.type === 'arrow'
			const at = isArrow ? (lowArrow = getIndexBelow(lowArrow)) : (index = getIndexAbove(index))
			const { w, h } = sizeFor(input)
			let placed = false
			const spec = { ...input }
			const gap = input.id && connected.has(normShapeId(input.id)) ? DIAGRAM_GAP : GAP

			if (!isArrow) {
				if (spec.x === undefined || spec.y === undefined) {
					const nearShape = spec.near ? lookup(normShapeId(spec.near)) : undefined
					if (spec.near && !nearShape) throw new Error(`Unknown "near" shape ${spec.near}`)
					const parentId = input.id ? predecessor.get(normShapeId(input.id)) : undefined
					const anchorRect = (nearShape && rectOf(nearShape)) ?? (parentId ? rects.get(parentId) : undefined)
					const spot = findFreeRect(obstacles, w, h, {
						prefer: anchorRect ? sidesOf(anchorRect, w, h, gap) : [],
						fallback: viewportCorner(pageId),
						gap,
						segments,
					})
					spec.x = spot.x
					spec.y = spot.y
					placed = true
				} else {
					spec.x += dx
					spec.y += dy
				}
				obstacles.push({ x: spec.x, y: spec.y, w, h })
			}

			const shape = validated(buildShape(spec, { pageId, index: at, meta: { author: 'agent' } }, { w, h }, lookup))
			if (txn.get(shape.id)) {
				if (!replace) {
					throw new Error(`Shape id ${shape.id} already exists. Use update_shapes to change it, or pass replace: true to recreate it.`)
				}
				// Re-creating keeps other arrows attached (same id); only this shape's own arrow ends are rebuilt.
				for (const r of Array.from(txn.values())) if (isBinding(r) && r.fromId === shape.id) txn.delete(r.id)
			}
			txn.set(shape.id, shape)
			created.set(shape.id, shape)
			if (!isArrow) rects.set(shape.id, { x: spec.x!, y: spec.y!, w, h })
			result.push(isArrow ? { id: shape.id } : { id: shape.id, x: spec.x, y: spec.y, w, h, placed })

			if (isArrow) {
				const from = input.from ? lookup(normShapeId(input.from)) : undefined
				const to = input.to ? lookup(normShapeId(input.to)) : undefined
				bindArrow(txn, shape, from, to, input.route === 'elbow' ? elbowAnchors(from, to, rects) : {})
				warnings.push(...arrowWarnings(input, shape.id, from, to, rects))
			}
		}
		const shifted = dx || dy ? { shifted: { dx, dy, note: 'Your x/y landed on existing shapes or arrows, so the whole drawing was moved as one to the nearest free space. The positions in `created` are final.' } } : {}
		return { pageId, created: result, warnings, ...shifted }
	}).result
}

// An L-shaped route reads best when the arrow leaves its source sideways and enters its target from above or below.
// That also keeps a loop-back arrow from landing on the same side as the forward arrow. Aligned shapes keep the default.
function elbowAnchors(from: TLShape | undefined, to: TLShape | undefined, rects: Map<string, Rect>): Anchors {
	const a = from && rects.get(from.id)
	const b = to && rects.get(to.id)
	if (!a || !b) return {}
	const dx = b.x + b.w / 2 - (a.x + a.w / 2)
	const dy = b.y + b.h / 2 - (a.y + a.h / 2)
	if (Math.abs(dy) < Math.max(a.h, b.h) / 2 || Math.abs(dx) < Math.max(a.w, b.w) / 2) return {}
	return { start: { x: dx > 0 ? 1 : 0, y: 0.5 }, end: { x: 0.5, y: dy > 0 ? 0 : 1 } }
}

// An arrow that runs through a third shape, or sits too close to read, is a layout bug the agent can fix.
function arrowWarnings(
	input: ShapeInput,
	arrowId: string,
	from: TLShape | undefined,
	to: TLShape | undefined,
	rects: Map<string, Rect>
): string[] {
	if (!from || !to) return []
	const a = rects.get(from.id)
	const b = rects.get(to.id)
	if (!a || !b) return []
	const label = `Arrow ${input.id ?? arrowId} (${from.id} -> ${to.id})`
	const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
	const out: string[] = []
	// A right-angle route only runs straight (and so through whatever sits between) when the shapes line up.
	const ca = center(a)
	const cb = center(b)
	const aligned = Math.abs(ca.y - cb.y) < Math.max(a.h, b.h) / 2 || Math.abs(ca.x - cb.x) < Math.max(a.w, b.w) / 2
	if (input.route !== 'elbow' || aligned) {
		for (const [id, r] of rects) {
			if (id === from.id || id === to.id) continue
			if (segmentHitsRect(ca, cb, r)) {
				out.push(`${label} passes through ${id}. Put the two shapes where nothing sits between them (e.g. in different rows) by giving explicit x/y or a different "near".`)
			}
		}
	}
	if (overlaps(a, b)) out.push(`${label}: the two shapes overlap, so the arrow will not be visible.`)
	return out
}

export function updateShapes(patches: ShapePatch[]) {
	return room.storage.transaction((txn) => {
		const updated: string[] = []
		for (const patch of patches) {
			const id = normShapeId(patch.id)
			const shape = txn.get(id) as TLShape | undefined
			if (!shape) throw new Error(`Unknown shape ${patch.id}`)
			const props: Record<string, unknown> = { ...shape.props }
			if (patch.text !== undefined && 'richText' in props) props.richText = toRichText(patch.text)
			if (patch.text !== undefined && shape.type === MEDIA_CARD) props.caption = patch.text
			if (patch.color) props.color = patch.color
			if (patch.fill && 'fill' in props) props.fill = patch.fill
			if (patch.w !== undefined && 'w' in props) props.w = patch.w
			if (patch.h !== undefined && 'h' in props) props.h = patch.h
			// Resizing a picture by one side keeps its proportions, otherwise it is stretched.
			if (shape.type === 'image' || shape.type === 'video' || shape.type === MEDIA_CARD) {
				const old = propsOf(shape)
				if (patch.w !== undefined && patch.h === undefined && old.w && old.h) props.h = Math.round((patch.w * old.h) / old.w)
				if (patch.h !== undefined && patch.w === undefined && old.w && old.h) props.w = Math.round((patch.h * old.w) / old.h)
			}
			const next = validated({
				...shape,
				x: patch.x ?? shape.x,
				y: patch.y ?? shape.y,
				props,
			} as TLShape)
			txn.set(id, next)
			updated.push(id)
		}
		return updated
	}).result
}

export function deleteShapes(ids: string[]) {
	return room.storage.transaction((txn) => {
		const targets = new Set(ids.map(normShapeId))
		const all = Array.from(txn.values())
		const doomed: string[] = []
		for (const r of all) {
			if (isShape(r) && (targets.has(r.id) || targets.has(r.parentId as TLShape['id']))) doomed.push(r.id)
			// Drop bindings that point at, or originate from, a deleted shape.
			if (isBinding(r) && (targets.has(r.fromId as TLShape['id']) || targets.has(r.toId as TLShape['id'])))
				doomed.push(r.id)
		}
		for (const id of doomed) txn.delete(id)
		return doomed.filter((id) => id.startsWith('shape:'))
	}).result
}

// ---- Agent text blocks and mark answers ---------------------------------------------------

const BLOCK_WIDTH = 360

export function addTextBlock(opts: { text: string; near?: string; w?: number; x?: number; y?: number; pageId?: string }) {
	const pageId = resolvePageId(opts.pageId)
	return room.storage.transaction((txn) => {
		const all = Array.from(txn.values())
		const obstacles = obstaclesOn(all, pageId)
		const anchor = opts.near ? (txn.get(normShapeId(opts.near)) as TLShape | undefined) : undefined
		if (opts.near && !anchor) throw new Error(`Unknown shape ${opts.near}`)
		const w = opts.w ?? BLOCK_WIDTH
		const h = Math.max(60, textBlockHeight(opts.text, w))
		const anchorRect = anchor && rectOf(anchor)
		const spot = findFreeRect(obstacles, w, h, {
			prefer: anchorRect ? sidesOf(anchorRect, w, h, DIAGRAM_GAP) : [],
			fallback: opts.x !== undefined && opts.y !== undefined ? { x: opts.x, y: opts.y } : viewportCorner(pageId),
			segments: segmentsOn(all, pageId),
		})
		const c: Common = {
			pageId,
			index: getIndexAbove(topIndex(all, pageId)),
			meta: { author: 'agent', kind: 'agent-note', ...(anchor ? { replyTo: anchor.id } : {}) },
		}
		const block = buildAgentBlock(opts.text, spot, c)
		txn.set(block.id, block)
		if (anchor) addLink(txn, block, anchor, c)
		return { id: block.id as string, x: Math.round(spot.x), y: Math.round(spot.y), w, h }
	}).result
}

function getMark(txn: Txn, id: string): TLShape {
	const ann = txn.get(normShapeId(id))
	if (!ann || !isShape(ann) || metaOf(ann).kind !== 'mark') throw new Error(`${id} is not a mark`)
	return ann
}

const BADGE_SIZE = 40

// The ✓ is drawn as a stroke, not typed as a glyph: a glyph's position inside the disc depends on the font the
// browser falls back to, a stroke is centred by construction. Corner points of the tick inside the 40px disc.
const TICK: [number, number][] = [[11, 21], [17, 28], [29, 13]]
function tickPoints(): { x: number; y: number; z: number }[] {
	const pts: { x: number; y: number; z: number }[] = []
	TICK.slice(1).forEach(([x1, y1], i) => {
		const [x0, y0] = TICK[i]!
		for (let k = 0; k < 5; k++) pts.push({ x: x0 + ((x1 - x0) * k) / 5, y: y0 + ((y1 - y0) * k) / 5, z: 0.5 })
	})
	const [lx, ly] = TICK.at(-1)!
	pts.push({ x: lx, y: ly, z: 0.5 })
	return pts
}

// The badge: a hand-drawn green disc (child of the mark) with a drawn tick (child of the disc). Both are locked.
function addBadge(txn: Txn, ann: TLShape) {
	const meta = { author: 'agent', kind: 'answered-badge' }
	const disc = validated({
		...buildShape({ type: 'ellipse', color: 'green', fill: 'solid', x: 200 - BADGE_SIZE / 2 - 2, y: -BADGE_SIZE / 2 + 2 }, { pageId: ann.id, index: 'a1' as IndexKey, meta }, { w: BADGE_SIZE, h: BADGE_SIZE }, () => undefined),
		isLocked: true,
	} as TLShape)
	const tick = validated({
		id: createShapeId(),
		typeName: 'shape',
		type: 'draw',
		x: 0,
		y: 0,
		rotation: 0,
		index: 'a1' as IndexKey,
		parentId: disc.id,
		isLocked: true,
		opacity: 1,
		meta,
		props: {
			color: 'green',
			fill: 'none',
			dash: 'draw',
			size: 'm',
			segments: [{ type: 'free', path: b64Vecs.encodePoints(tickPoints()) }],
			isComplete: true,
			isClosed: false,
			isPen: false,
			scale: 1,
			scaleX: 1,
			scaleY: 1,
		},
	} as unknown as TLShape)
	txn.set(disc.id, disc)
	txn.set(tick.id, tick)
}

// An answered mark turns solid grey and gets a locked green ✓ on its corner. The badge is a child of the mark, so it
// moves and is deleted with it. (The web app reverses all of this if the user edits the mark again.)
function markAnswered(txn: Txn, ann: TLShape, meta: Partial<BlockMeta>) {
	txn.set(ann.id, { ...ann, opacity: 1, props: { ...ann.props, color: 'grey' }, meta: { ...ann.meta, status: 'answered', ...meta } } as TLShape)
	const hasBadge = Array.from(txn.values()).some((r) => isShape(r) && r.parentId === ann.id && metaOf(r).kind === 'answered-badge')
	if (!hasBadge) addBadge(txn, ann)
}

// Boards made before answered marks turned grey (same note at 55% opacity), or whose badge still types its ✓ as text.
export function migrateAnsweredMarks() {
	room.storage.transaction((txn) => {
		for (const r of Array.from(txn.values())) {
			if (!isShape(r)) continue
			if (metaOf(r).kind === 'mark' && metaOf(r).status === 'answered' && r.opacity !== 1) markAnswered(txn, r, {})
			if (metaOf(r).kind === 'answered-badge' && r.type === 'geo' && textOf(r) !== '') {
				txn.delete(r.id)
				const parent = txn.get(r.parentId as TLShape['id'])
				if (parent && isShape(parent)) addBadge(txn, parent)
			}
		}
	})
}

// The box around a marked selection turns violet (the agent's colour) and solid once the mark is answered.
function markRegionAnswered(txn: Txn, ann: TLShape) {
	const regionId = metaOf(ann).regionId
	const region = regionId ? txn.get(regionId as TLShape['id']) : undefined
	if (region && isShape(region)) txn.set(region.id, { ...region, props: { ...region.props, color: 'violet', dash: 'solid' } } as TLShape)
}

// A mark on a selection points at its dashed box; the reply goes under that box and points at it too.
// A mark on one shape has no box, so the reply goes under that shape; a mark aimed at nothing answers under its own note.
function replyAnchor(txn: Txn, ann: TLShape): TLShape {
	const { regionId, targetIds } = metaOf(ann)
	const target = regionId ?? (targetIds?.length === 1 ? targetIds[0] : undefined)
	const found = target ? txn.get(target as TLShape['id']) : undefined
	return found && isShape(found) && rectOf(found) ? found : ann
}

const REPLY_REACH = 1600 // how far from the anchor and the mark a reply may land before anywhere on the page will do

// A reply belongs directly under what it answers. If that spot is taken (say by the reply to another mark on the
// same thing), it takes the nearest free spot between there and under its own mark, e.g. beside the other reply,
// rather than queueing further down the column, away from the question.
function replySpot(obstacles: Rect[], segments: Segment[], anchor: TLShape, mark: TLShape, w: number, h: number): Rect {
	const [right, under, left, above] = sidesOf(rectOf(anchor)!, w, h, DIAGRAM_GAP) as [Point, Point, Point, Point]
	const underMark = sidesOf(rectOf(mark)!, w, h, DIAGRAM_GAP)[1]!
	return (
		freeRectNear(obstacles, segments, w, h, under, underMark, REPLY_REACH) ??
		findFreeRect(obstacles, w, h, { prefer: [right, left, above], fallback: under, segments })
	)
}

// ---- Pending replies ---------------------------------------------------------------------
// While the agent works, every open mark with text shows a dashed "Thinking…" block where the answer will go.
// It reserves PENDING_H of free space up front; replyToMark later fills the same shape, shrinking it to the text
// (always safe) or, if the answer is taller than the slot, moving it only when the extra height would overlap.

const PENDING_H = 240
const QUOTE_CHARS = 30 // short enough that the quote label stays on one line of a reply

const pendingFor = (all: TLRecord[], markId: string) =>
	all.filter(isShape).find((s) => isPending(s) && metaOf(s).replyTo === markId)

// Removes a placeholder together with the link arrow(s) tied to it.
function dropPending(txn: Txn, ph: TLShape) {
	for (const id of pendingIds(Array.from(txn.values()), ph)) txn.delete(id)
}

export function reservePendingReplies() {
	return room.storage.transaction((txn) => {
		const all = Array.from(txn.values())
		const open = all
			.filter(isShape)
			.filter((s) => metaOf(s).kind === 'mark' && (metaOf(s).status ?? 'open') !== 'answered' && textOf(s).trim() !== '' && !pendingFor(all, s.id))
		const obstacles = new Map<string, Rect[]>()
		const lines = new Map<string, Segment[]>()
		const tops = new Map<string, IndexKey | undefined>()
		for (const ann of open) {
			const pageId = ann.parentId as string
			if (!obstacles.has(pageId)) {
				obstacles.set(pageId, obstaclesOn(all, pageId))
				lines.set(pageId, segmentsOn(all, pageId))
			}
			const taken = obstacles.get(pageId)!
			const anchor = replyAnchor(txn, ann)
			const spot = replySpot(taken, lines.get(pageId)!, anchor, ann, BLOCK_WIDTH, PENDING_H)
			taken.push(spot)
			const index = getIndexAbove(tops.has(pageId) ? tops.get(pageId) : topIndex(all, pageId))
			tops.set(pageId, index)
			const base = buildAgentBlock('Thinking…', spot, { pageId, index, meta: { author: 'agent', kind: 'agent-reply', status: 'pending', replyTo: ann.id } }, quoteOf(ann))
			const block = { ...base, props: { ...base.props, dash: 'dashed', fill: 'semi' } } as TLShape
			txn.set(block.id, block)
			addQuoteLabel(txn, block, quoteOf(ann))
			addLink(txn, block, anchor, { pageId, index, meta: {} })
		}
	}).result
}

// Placeholders the agent never answered (it did something else, or the run ended) must not linger.
export function clearPendingReplies() {
	return room.storage.transaction((txn) => {
		for (const r of Array.from(txn.values())) if (isShape(r) && isPending(r)) dropPending(txn, r)
	}).result
}

// Answering = writing a reply block beside the mark AND flipping its status. Doing both here, in one
// transaction, is what makes "is it answered?" reliable.
export function replyToMark(id: string, text: string) {
	return room.storage.transaction((txn) => {
		const ann = getMark(txn, id)
		const all = Array.from(txn.values())
		const pageId = ann.parentId as string
		const w = BLOCK_WIDTH
		const quote = quoteOf(ann)
		const h = Math.max(60, textBlockHeight(`${quote}\n\n${text}`, w))
		const pending = pendingFor(all, ann.id)
		let block: TLShape
		let spot: Rect
		if (pending) {
			// Fill the placeholder in place; the link arrow is already bound to it.
			// Stays where it is if the answer fits there; a taller answer that no longer fits slides down, never above.
			const rest = all.filter((r) => r.id !== pending.id)
			const taken = obstaclesOn(rest, pageId)
			const lines = segmentsOn(rest, pageId)
			const here = { x: pending.x, y: pending.y, w, h }
			spot = isFree(taken, lines, here) ? here : replySpot(taken, lines, replyAnchor(txn, ann), ann, w, h)
			const meta = { ...pending.meta }
			delete meta.status
			block = { ...pending, x: spot.x, y: spot.y, meta, props: { ...pending.props, w, h, dash: 'solid', fill: 'solid', richText: replyRichText(text) } } as TLShape
			txn.set(block.id, block)
		} else {
			const anchor = replyAnchor(txn, ann)
			spot = replySpot(obstaclesOn(all, pageId), segmentsOn(all, pageId), anchor, ann, w, h)
			const index = getIndexAbove(topIndex(all, pageId))
			block = buildAgentBlock(text, spot, { pageId, index, meta: { author: 'agent', kind: 'agent-reply', replyTo: ann.id } }, quote)
			txn.set(block.id, block)
			addQuoteLabel(txn, block, quote)
			addLink(txn, block, anchor, { pageId, index, meta: {} })
		}
		markAnswered(txn, ann, { answeredBy: block.id })
		markRegionAnswered(txn, ann)
		return { replyId: block.id as string, x: Math.round(spot.x), y: Math.round(spot.y) }
	}).result
}

// Closing a mark without writing anything (e.g. the request was just done on the canvas).
export function resolveMark(id: string) {
	return room.storage.transaction((txn) => {
		const ann = getMark(txn, id)
		const pending = pendingFor(Array.from(txn.values()), ann.id)
		if (pending) dropPending(txn, pending)
		markAnswered(txn, ann, {})
		markRegionAnswered(txn, ann)
		return ann.id as string
	}).result
}

// ---- Media (images, GIFs, video) ---------------------------------------------------------------

const MAX_VIEW_BYTES = 8 * 1024 * 1024

interface StoredMedia {
	kind: 'image' | 'video'
	name: string
	mimeType: string | null
	file: string
}

const fileFromSrc = (src: string) => safeId(decodeURIComponent(new URL(src, 'http://local').pathname.split('/').pop() ?? ''))

function findMedia(shapeId: string): StoredMedia {
	const records = readAll()
	const shape = records.find((r) => r.id === normShapeId(shapeId))
	if (!shape || !isShape(shape)) throw new Error(`${shapeId} is not a media shape`)
	const p = propsOf(shape)
	if (shape.type === MEDIA_CARD && p.src) {
		return { kind: p.kind as StoredMedia['kind'], name: p.name ?? '', mimeType: p.mimeType ?? null, file: fileFromSrc(p.src) }
	}
	// Images placed before media cards existed use a tldraw asset record.
	if (shape.type === 'image' || shape.type === 'video') {
		const asset = p.assetId ? (records.find((r) => r.id === p.assetId) as TLAsset | undefined) : undefined
		if (asset && (asset.type === 'image' || asset.type === 'video') && asset.props.src) {
			return { kind: asset.type, name: asset.props.name, mimeType: asset.props.mimeType, file: fileFromSrc(asset.props.src) }
		}
	}
	throw new Error(`${shapeId} is not an image or video, or has no stored file`)
}

export interface ViewedImage {
	base64: string
	mimeType: string
	name: string
}

export function readImage(shapeId: string): ViewedImage {
	const media = findMedia(shapeId)
	if (media.kind === 'video') throw new Error(`${shapeId} is a video (${media.name}); only images can be viewed`)
	const data = readFileSync(join(UPLOADS, media.file))
	if (data.length > MAX_VIEW_BYTES) {
		throw new Error(`Image is ${(data.length / 1048576).toFixed(1)} MB, over the ${MAX_VIEW_BYTES / 1048576} MB view limit`)
	}
	return { base64: data.toString('base64'), mimeType: sniffMedia(data)?.mimeType ?? media.mimeType ?? 'image/png', name: media.name }
}

export interface AddMediaOptions {
	file: Buffer
	name: string
	w?: number
	h?: number
	x?: number
	y?: number
	near?: string
	caption?: string
	pageId?: string
}

export interface AddedMedia {
	id: string
	kind: 'image' | 'video'
	mimeType: string
	x: number
	y: number
	w: number
	h: number
	/** Path the file is served from, e.g. /uploads/<uuid>-name.png */
	src: string
	note?: string
}

export function addMedia(opts: AddMediaOptions): AddedMedia {
	const info = sniffMedia(opts.file)
	if (!info) throw new Error('Unsupported file. Use PNG, JPEG, GIF, WebP, MP4 or WebM.')
	let note: string | undefined
	let { w: srcW, h: srcH } = info
	if (srcW === 0 || srcH === 0) {
		// A video whose header we could not parse: use the caller's size or assume 16:9.
		srcW = opts.w ?? 1280
		srcH = opts.h ?? Math.round((srcW * 9) / 16)
		note = 'Could not read the video size; assumed 16:9. Pass w and h to override.'
	}
	const pageId = resolvePageId(opts.pageId)
	const fileId = `${crypto.randomUUID()}-${safeId(opts.name)}`
	// Write the file before the transaction: an orphan file is harmless, a shape pointing at nothing is not.
	writeFileSync(join(UPLOADS, fileId), opts.file)

	return room.storage.transaction((txn) => {
		const all = Array.from(txn.values())
		const obstacles = obstaclesOn(all, pageId)
		const w = opts.w ?? Math.min(srcW, 480)
		const h = opts.h ?? Math.round((w * srcH) / srcW)
		const anchor = opts.near ? (txn.get(normShapeId(opts.near)) as TLShape | undefined) : undefined
		if (opts.near && !anchor) throw new Error(`Unknown shape ${opts.near}`)
		const spot = findFreeRect(obstacles, w, h + CAPTION_H, {
			prefer: anchor ? sidesOf(rectOf(anchor)!, w, h + CAPTION_H) : [],
			fallback: opts.x !== undefined && opts.y !== undefined ? { x: opts.x, y: opts.y } : viewportCorner(pageId),
			segments: segmentsOn(all, pageId),
		})

		const src = `/uploads/${encodeURIComponent(fileId)}`
		const shape = validated({
			id: createShapeId(),
			typeName: 'shape',
			type: MEDIA_CARD,
			x: spot.x,
			y: spot.y,
			rotation: 0,
			index: getIndexAbove(topIndex(all, pageId)),
			parentId: pageId,
			isLocked: false,
			opacity: 1,
			meta: { author: 'agent' },
			props: { w, h, kind: info.kind, src, mimeType: info.mimeType, name: opts.name, caption: opts.caption ?? '' },
		} as unknown as TLShape)
		txn.set(shape.id, shape)
		return { id: shape.id as string, kind: info.kind, mimeType: info.mimeType, x: Math.round(spot.x), y: Math.round(spot.y), w, h, src, note }
	}).result
}

// ---- Change tracking ---------------------------------------------------------------------------

export const currentClock = () => room.storage.getClock()

export interface CanvasChanges {
	clock: number
	/** True when history before `sinceClock` is gone: re-read the whole canvas. */
	reloadAll: boolean
	changed: Record<string, unknown>[]
	deleted: string[]
}

// What changed since the agent last looked. Covers everything that syncs, from both the user and the agent:
// shapes added, edited or moved, and shapes deleted. (Selection and viewport are live state: see get_context.)
export function changesSince(sinceClock: number): CanvasChanges {
	const { result, clock } = room.storage.transaction((txn) => ({
		result: txn.getChangesSince(sinceClock),
		clock: txn.getClock(),
	})).result
	if (!result) return { clock, reloadAll: false, changed: [], deleted: [] }
	const records = readAll()
	const byId = new Map(records.map((r) => [r.id as string, r]))
	const bindings = records.filter(isArrowBinding)
	const putIds = Object.keys(result.diff.puts)
	const changed = putIds
		.map((id) => byId.get(id))
		.filter((r): r is TLShape => !!r && isShape(r))
		.map((s) => describeOne(s, records, byId, bindings))
	const deleted = result.diff.deletes.filter((id) => id.startsWith('shape:'))
	return { clock, reloadAll: result.wipeAll, changed, deleted }
}

// Boards made before arrows went behind blocks: move every arrow that sits above a block to below all of them.
export function migrateArrowsBehind() {
	room.storage.transaction((txn) => {
		const all = Array.from(txn.values())
		for (const page of all.filter(isPage)) {
			const onPage = all.filter(isShape).filter((s) => s.parentId === page.id)
			const lowestBlock = onPage.filter((s) => s.type !== 'arrow').map((s) => s.index).sort()[0]
			if (!lowestBlock) continue
			let low = arrowIndex(all, page.id)
			for (const a of onPage.filter((s) => s.type === 'arrow' && s.index > lowestBlock).sort((x, y) => (x.index < y.index ? -1 : 1))) {
				txn.set(a.id, { ...a, index: low })
				low = getIndexBelow(low)
			}
		}
	})
}

// Marks were called annotations before; rewrite stored shapes so existing boards keep working.
export function migrateLegacyMarks() {
	room.storage.transaction((txn) => {
		for (const r of Array.from(txn.values())) {
			if (isShape(r) && (r.meta as BlockMeta).kind === 'annotation') txn.set(r.id, { ...r, meta: { ...r.meta, kind: 'mark' } })
		}
	})
}
