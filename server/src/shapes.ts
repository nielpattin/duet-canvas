import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TLSyncStorageTransaction } from '@tldraw/sync-core'
import {
	createBindingId,
	createShapeId,
	createTLSchema,
	toRichText,
	type TLArrowBinding,
	type TLAsset,
	type TLBinding,
	type TLPage,
	type TLRecord,
	type TLRichText,
	type TLShape,
} from '@tldraw/tlschema'
import { getIndexAbove, type IndexKey } from '@tldraw/utils'
import { z } from 'zod'
import { safeId, UPLOADS } from './config.ts'
import { sniffMedia } from './media.ts'
import { DIAGRAM_GAP, DRAW_M, findFreeRect, GAP, overlaps, segmentHitsRect, sidesOf, textBlockHeight, type Point, type Rect } from './layout.ts'
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
		.enum(['straight', 'elbow'])
		.optional()
		.describe('Arrow only: "straight" (default) or "elbow" (right-angle routing, good for loops and long flows)'),
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
// kind     'annotation'   a user note aimed at the canvas or at specific shapes (targetIds)
//          'agent-reply'  an agent text block answering an annotation (replyTo)
//          'agent-note'   an agent text block that is not an answer
//          'link'         an arrow that only connects a reply to what it answers
// status   annotations only: 'open' | 'answered'

interface BlockMeta {
	author?: string
	kind?: string
	status?: string
	targetIds?: string[]
	replyTo?: string
	answeredBy?: string
}
const metaOf = (s: TLShape) => s.meta as BlockMeta

// ---- Helpers ---------------------------------------------------------------------------------

const schema = createTLSchema()

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
	richText?: TLRichText
	assetId?: string | null
	autoSize?: boolean
}
const propsOf = (s: TLShape) => s.props as unknown as LooseProps
const textOf = (s: TLShape) => richTextToString(propsOf(s).richText)

const isShape = (r: TLRecord): r is TLShape => r.typeName === 'shape'
const isBinding = (r: TLRecord): r is TLBinding => r.typeName === 'binding'
const isArrowBinding = (r: TLRecord): r is TLArrowBinding => isBinding(r) && r.type === 'arrow'
const isPage = (r: TLRecord): r is TLPage => r.typeName === 'page'

type Txn = TLSyncStorageTransaction<TLRecord>

const readAll = (): TLRecord[] => room.storage.transaction((txn) => Array.from(txn.values())).result

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
	if (m.kind === 'annotation') Object.assign(out, { status: m.status ?? 'open', targetIds: m.targetIds ?? [] })
	if (m.replyTo) out.replyTo = m.replyTo
	if (s.type === 'image' || s.type === 'video') {
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

export function listPages() {
	return readAll()
		.filter(isPage)
		.map((p) => ({ id: p.id as string, name: p.name }))
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

// ---- Annotations -----------------------------------------------------------------------------

export function listAnnotations(status: 'open' | 'answered' | 'all' = 'open') {
	const records = readAll()
	const byId = new Map(records.map((r) => [r.id as string, r]))
	const bindings = records.filter(isArrowBinding)
	return records
		.filter(isShape)
		.filter((s) => metaOf(s).kind === 'annotation')
		.filter((s) => textOf(s).trim() !== '') // an empty note is a draft the user has not written yet
		.filter((s) => status === 'all' || (metaOf(s).status ?? 'open') === status)
		.map((s) => {
			const m = metaOf(s)
			return {
				...describeOne(s, records, byId, bindings),
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

function resolvePageId(requested?: string): string {
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
				bend: 0,
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

// The look of every text block the agent writes: a violet, sans-serif, left-aligned box. Together with
// meta.author = 'agent' this makes agent writing recognisable at a glance and unmistakable in the data.
function buildAgentBlock(text: string, rect: Rect, c: Common): TLShape {
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
			richText: toRichText(text),
		},
	} as TLShape)
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
			{ type: 'arrow', from: from.id, to: to.id, color: 'grey' },
			{ ...c, meta: { author: 'agent', kind: 'link' } },
			{ w: 0, h: 0 },
			(id) => (id === from.id ? from : id === to.id ? to : undefined)
		)
	)
	txn.set(arrow.id, arrow)
	bindArrow(txn, arrow, from, to)
	return arrow
}

export function createShapes(inputs: ShapeInput[], pageIdHint?: string) {
	const pageId = resolvePageId(pageIdHint)
	return room.storage.transaction((txn) => {
		const all = Array.from(txn.values())
		const obstacles = obstaclesOn(all, pageId)
		// Rect of every shape on the page by id, so arrows can be checked for crossing shapes.
		const rects = new Map<string, Rect>()
		for (const s of all.filter(isShape).filter((s) => s.parentId === pageId)) {
			const r = rectOf(s)
			if (r) rects.set(s.id, r)
		}
		// Shapes that arrows attach to need extra room around them so the arrows are visible.
		const connected = new Set(inputs.flatMap((i) => [i.from, i.to]).filter((id): id is string => !!id).map(normShapeId))
		let index = topIndex(all, pageId)
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
		const result: { id: string; x?: number; y?: number; placed?: boolean }[] = []
		const warnings: string[] = []

		for (const input of ordered) {
			index = getIndexAbove(index)
			const isArrow = input.type === 'arrow'
			const text = input.text ?? ''
			// A diamond only has room for text in its middle, so it needs to be bigger than a box to fit a label.
			const w = input.w ?? (input.type === 'text' || input.type === 'note' ? 200 : input.type === 'diamond' ? 200 : 160)
			const h =
				input.type === 'note'
					? 200
					: input.h ??
						Math.max(input.type === 'text' ? 40 : input.type === 'diamond' ? 130 : 100, text ? textBlockHeight(text, w) : 0)
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
					})
					spec.x = spot.x
					spec.y = spot.y
					placed = true
				} else if (obstacles.some((o) => overlaps({ x: spec.x!, y: spec.y!, w, h }, o))) {
					warnings.push(`${input.id ?? input.type} at (${spec.x}, ${spec.y}) overlaps an existing shape. Omit x/y to auto-place.`)
				}
				obstacles.push({ x: spec.x, y: spec.y, w, h })
			}

			const shape = validated(buildShape(spec, { pageId, index, meta: { author: 'agent' } }, { w, h }, lookup))
			if (txn.get(shape.id)) throw new Error(`Shape id ${shape.id} already exists`)
			txn.set(shape.id, shape)
			created.set(shape.id, shape)
			if (!isArrow) rects.set(shape.id, { x: spec.x!, y: spec.y!, w, h })
			result.push(isArrow ? { id: shape.id } : { id: shape.id, x: spec.x, y: spec.y, placed })

			if (isArrow) {
				const from = input.from ? lookup(normShapeId(input.from)) : undefined
				const to = input.to ? lookup(normShapeId(input.to)) : undefined
				bindArrow(txn, shape, from, to, input.route === 'elbow' ? elbowAnchors(from, to, rects) : {})
				warnings.push(...arrowWarnings(input, shape.id, from, to, rects))
			}
		}
		return { created: result, warnings }
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
			if (patch.color) props.color = patch.color
			if (patch.fill && 'fill' in props) props.fill = patch.fill
			if (patch.w !== undefined && 'w' in props) props.w = patch.w
			if (patch.h !== undefined && 'h' in props) props.h = patch.h
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

// ---- Agent text blocks and annotation answers ---------------------------------------------------

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
			prefer: anchorRect ? sidesOf(anchorRect, w, h) : [],
			fallback: opts.x !== undefined && opts.y !== undefined ? { x: opts.x, y: opts.y } : viewportCorner(pageId),
		})
		const c: Common = {
			pageId,
			index: getIndexAbove(topIndex(all, pageId)),
			meta: { author: 'agent', kind: 'agent-note', ...(anchor ? { replyTo: anchor.id } : {}) },
		}
		const block = buildAgentBlock(opts.text, spot, c)
		txn.set(block.id, block)
		if (anchor) addLink(txn, block, anchor, { ...c, index: getIndexAbove(c.index) })
		return { id: block.id as string, x: Math.round(spot.x), y: Math.round(spot.y), w, h }
	}).result
}

function getAnnotation(txn: Txn, id: string): TLShape {
	const ann = txn.get(normShapeId(id))
	if (!ann || !isShape(ann) || metaOf(ann).kind !== 'annotation') throw new Error(`${id} is not an annotation`)
	return ann
}

// Answering = writing a reply block beside the annotation AND flipping its status. Doing both here, in one
// transaction, is what makes "is it answered?" reliable.
export function replyToAnnotation(id: string, text: string) {
	return room.storage.transaction((txn) => {
		const ann = getAnnotation(txn, id)
		const all = Array.from(txn.values())
		const pageId = ann.parentId as string
		const obstacles = obstaclesOn(all, pageId)
		const w = BLOCK_WIDTH
		const h = Math.max(60, textBlockHeight(text, w))
		const annRect = rectOf(ann)!
		// A reply reads best directly under the note it answers, so try below before right.
		const [right, under, left, above] = sidesOf(annRect, w, h) as [Point, Point, Point, Point]
		const spot = findFreeRect(obstacles, w, h, { prefer: [under, right, left, above], fallback: under })
		const index = getIndexAbove(topIndex(all, pageId))
		const block = buildAgentBlock(text, spot, {
			pageId,
			index,
			meta: { author: 'agent', kind: 'agent-reply', replyTo: ann.id },
		})
		txn.set(block.id, block)
		addLink(txn, block, ann, { pageId, index: getIndexAbove(index), meta: {} })
		txn.set(ann.id, { ...ann, opacity: 0.55, meta: { ...ann.meta, status: 'answered', answeredBy: block.id } })
		return { replyId: block.id as string, x: Math.round(spot.x), y: Math.round(spot.y) }
	}).result
}

// Closing an annotation without writing anything (e.g. the request was just done on the canvas).
export function resolveAnnotation(id: string) {
	return room.storage.transaction((txn) => {
		const ann = getAnnotation(txn, id)
		txn.set(ann.id, { ...ann, opacity: 0.55, meta: { ...ann.meta, status: 'answered' } })
		return ann.id as string
	}).result
}

// ---- Media (images, GIFs, video) ---------------------------------------------------------------

const MAX_VIEW_BYTES = 8 * 1024 * 1024

interface StoredMedia {
	shape: TLShape
	asset: TLAsset & { type: 'image' | 'video' }
	file: string
}

function findMedia(shapeId: string): StoredMedia {
	const records = readAll()
	const shape = records.find((r) => r.id === normShapeId(shapeId))
	if (!shape || !isShape(shape) || (shape.type !== 'image' && shape.type !== 'video')) {
		throw new Error(`${shapeId} is not an image or video shape`)
	}
	const assetId = propsOf(shape).assetId
	const asset = assetId ? (records.find((r) => r.id === assetId) as TLAsset | undefined) : undefined
	if (!asset || (asset.type !== 'image' && asset.type !== 'video') || !asset.props.src) {
		throw new Error(`${shapeId} has no stored file`)
	}
	const file = safeId(decodeURIComponent(new URL(asset.props.src, 'http://local').pathname.split('/').pop() ?? ''))
	return { shape, asset: asset as StoredMedia['asset'], file }
}

export interface ViewedImage {
	base64: string
	mimeType: string
	name: string
}

export function readImage(shapeId: string): ViewedImage {
	const { asset, file } = findMedia(shapeId)
	if (asset.type === 'video') throw new Error(`${shapeId} is a video (${asset.props.name}); only images can be viewed`)
	const data = readFileSync(join(UPLOADS, file))
	if (data.length > MAX_VIEW_BYTES) {
		throw new Error(`Image is ${(data.length / 1048576).toFixed(1)} MB, over the ${MAX_VIEW_BYTES / 1048576} MB view limit`)
	}
	return {
		base64: data.toString('base64'),
		mimeType: sniffMedia(data)?.mimeType ?? asset.props.mimeType ?? 'image/png',
		name: asset.props.name,
	}
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
		const captionH = opts.caption ? 48 : 0
		const anchor = opts.near ? (txn.get(normShapeId(opts.near)) as TLShape | undefined) : undefined
		if (opts.near && !anchor) throw new Error(`Unknown shape ${opts.near}`)
		const spot = findFreeRect(obstacles, w, h + captionH, {
			prefer: anchor ? sidesOf(rectOf(anchor)!, w, h + captionH) : [],
			fallback: opts.x !== undefined && opts.y !== undefined ? { x: opts.x, y: opts.y } : viewportCorner(pageId),
		})

		const src = `/uploads/${encodeURIComponent(fileId)}`
		const assetBase = { w: srcW, h: srcH, name: opts.name, isAnimated: info.animated, mimeType: info.mimeType, src }
		const asset = validated({
			id: `asset:${crypto.randomUUID()}` as TLAsset['id'],
			typeName: 'asset',
			type: info.kind,
			props: assetBase,
			meta: {},
		} as TLAsset)
		txn.set(asset.id, asset)

		let index = getIndexAbove(topIndex(all, pageId))
		const alt = opts.caption ?? opts.name
		const shape = validated({
			id: createShapeId(),
			typeName: 'shape',
			type: info.kind,
			x: spot.x,
			y: spot.y,
			rotation: 0,
			index,
			parentId: pageId as TLShape['parentId'],
			isLocked: false,
			opacity: 1,
			meta: { author: 'agent' },
			props:
				info.kind === 'image'
					? { w, h, playing: true, url: '', assetId: asset.id, crop: null, flipX: false, flipY: false, altText: alt }
					: { w, h, time: 0, playing: false, autoplay: false, url: '', assetId: asset.id, altText: alt },
		} as TLShape)
		txn.set(shape.id, shape)

		if (opts.caption) {
			index = getIndexAbove(index)
			const caption = validated(
				buildShape(
					{ type: 'text', x: spot.x, y: spot.y + h + 8, w, text: opts.caption },
					{ pageId, index, meta: { author: 'agent', kind: 'agent-note', replyTo: shape.id } },
					{ w, h: 40 },
					() => undefined
				)
			)
			txn.set(caption.id, caption)
		}
		return { id: shape.id as string, kind: info.kind, mimeType: info.mimeType, x: Math.round(spot.x), y: Math.round(spot.y), w, h, note }
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
