import { Box, createShapeId, type Editor, type TLShape, type TLShapeId, type TLShapePartial, toRichText, type VecLike } from 'tldraw'

// Shared with the server (see server/src/shapes.ts, "Conventions stored in shape.meta").
interface BlockMeta {
	author?: string
	kind?: string
	status?: string
	targetIds?: string[]
	regionId?: string
	replyTo?: string
}
export const metaOf = (s: TLShape) => s.meta as BlockMeta

export const isMark = (s: TLShape) => metaOf(s).kind === 'mark'
export const isRegion = (s: TLShape) => metaOf(s).kind === 'region'
export const isOpenMark = (s: TLShape) => isMark(s) && metaOf(s).status !== 'answered'

/** Things a mark can be aimed at: anything except arrows and other marks. */
export const canTarget = (s: TLShape) => s.type !== 'arrow' && !isMark(s) && !isRegion(s)

const NOTE_SIZE = 200
const GAP = 40

// Finds a spot for a note that does not sit on another shape, starting next to `anchor`.
function freeSpot(editor: Editor, anchor: { x: number; y: number; maxX: number }): { x: number; y: number } {
	const others = editor.getCurrentPageShapes().flatMap((s) => {
		const b = editor.getShapePageBounds(s)
		return b && s.type !== 'arrow' ? [b] : []
	})
	const hits = (x: number, y: number) =>
		others.some((b) => x < b.maxX + 16 && x + NOTE_SIZE + 16 > b.minX && y < b.maxY + 16 && y + NOTE_SIZE + 16 > b.minY)
	const x = anchor.maxX + GAP
	for (let i = 0; i < 40; i++) {
		const y = anchor.y + i * 60
		if (!hits(x, y)) return { x, y }
	}
	return { x, y: anchor.y }
}

// Adds a pink handwritten note (a "mark") the agent reads as a message from the user.
// - One target or none: the note is joined to that shape by a dashed arrow (or floats at `point`).
// - A selection: a dashed box is drawn around all of it and ONE arrow joins the note to the box.
//   The box is what turns violet when the agent answers (see server replyToMark).
//   `reuseRegion`: feedback on a box that already exists: the new note joins that box, which turns pink again.
export function createMark(editor: Editor, targets: TLShape[], point?: VecLike, asSelection = false, reuseRegion?: TLShapeId) {
	const boundsOf = (shapes: TLShape[]) => Box.Common(shapes.flatMap((t) => editor.getShapePageBounds(t) ?? []))
	const targetBox = targets.length > 0 ? boundsOf(targets) : undefined

	let regionId: TLShapeId | undefined
	if (reuseRegion && editor.getShape(reuseRegion)) {
		regionId = reuseRegion
		editor.updateShape({ id: reuseRegion, type: 'geo', props: { color: 'light-red', dash: 'dashed' } })
	} else if (asSelection && targetBox) {
		regionId = createShapeId()
		const r = padded(targetBox)
		editor.createShape({
			id: regionId,
			type: 'geo',
			x: r.x,
			y: r.y,
			props: { geo: 'rectangle', w: r.w, h: r.h, color: 'light-red', dash: 'dashed', fill: 'none', size: 'm' },
			meta: { author: 'user', kind: 'region', targetIds: targets.map((t) => t.id) },
		})
	}

	let origin: { x: number; y: number }
	if (targetBox) {
		const box = regionId ? padded(targetBox) : targetBox
		origin = freeSpot(editor, { x: 0, y: box.y, maxX: box.x + box.w })
	} else {
		const c = point ?? editor.getViewportPageBounds().center
		origin = { x: c.x - NOTE_SIZE / 2, y: c.y - NOTE_SIZE / 2 }
	}

	const id = createShapeId()
	editor.createShape({
		id,
		type: 'note',
		x: origin.x,
		y: origin.y,
		props: { color: 'light-red', font: 'draw', richText: toRichText('') },
		meta: { author: 'user', kind: 'mark', status: 'open', targetIds: targets.map((t) => t.id), ...(regionId ? { regionId } : {}) },
	} satisfies TLShapePartial)

	const noteCenter = { x: origin.x + NOTE_SIZE / 2, y: origin.y + NOTE_SIZE / 2 }
	const aims: { id: TLShapeId; center: { x: number; y: number } }[] = regionId
		? [{ id: regionId, center: padded(targetBox!).center }]
		: targets.flatMap((t) => {
				const tb = editor.getShapePageBounds(t)
				return tb ? [{ id: t.id, center: tb.center }] : []
			})
	for (const aim of aims) {
		const arrowId = createShapeId()
		editor.createShape({
			id: arrowId,
			type: 'arrow',
			x: 0,
			y: 0,
			props: { color: 'light-red', dash: 'dashed', start: noteCenter, end: aim.center, bend: 30 },
			meta: { author: 'user', kind: 'link' },
		})
		editor.createBindings(
			(['start', 'end'] as const).map((terminal) => ({
				type: 'arrow',
				fromId: arrowId,
				toId: terminal === 'start' ? id : aim.id,
				props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' as const },
			}))
		)
	}

	editor.select(id)
	editor.setEditingShape(id)
}

const targetsOf = (editor: Editor, region: TLShape) =>
	(metaOf(region).targetIds ?? []).flatMap((id) => editor.getShape(id as TLShapeId) ?? [])

/**
 * Marks whatever is selected right now (right-click menu). Does nothing if nothing markable is selected.
 * A selected box counts as the shapes it surrounds. A box on its own is reused, so feedback on an answered mark
 * stays on the same box; any other mix gets a new box.
 */
export function markSelection(editor: Editor) {
	const selected = editor.getSelectedShapes()
	const regions = selected.filter(isRegion)
	const [only] = regions
	if (only && selected.length === 1) {
		const targets = targetsOf(editor, only)
		if (targets.length > 0) return createMark(editor, targets, undefined, true, only.id)
	}
	const targets = new Map<TLShapeId, TLShape>()
	for (const s of selected) {
		for (const t of isRegion(s) ? targetsOf(editor, s) : canTarget(s) ? [s] : []) targets.set(t.id, t)
	}
	if (targets.size > 0) createMark(editor, [...targets.values()], undefined, true)
}

const REGION_PAD = 12
// The box is clickable (so you can give feedback on it) but never moves by hand: it always wraps its shapes.
let refitting = false

const padded = (b: Box) => new Box(b.x - REGION_PAD, b.y - REGION_PAD, b.w + 2 * REGION_PAD, b.h + 2 * REGION_PAD)

// Keeps marks tidy as shapes change:
// - the selection box refits when a target moves or resizes, and goes away with the last target or its last mark;
// - a link arrow (mark -> target, reply -> mark) goes away once either end is deleted.
export function keepMarksTidy(editor: Editor) {
	const regionsFor = (id: string) => editor.getCurrentPageShapes().filter((s) => isRegion(s) && metaOf(s).targetIds?.includes(id))
	const refit = (region: TLShape) => {
		const alive = (metaOf(region).targetIds ?? []).flatMap((id) => editor.getShape(id as TLShapeId) ?? [])
		const boxes = alive.flatMap((t) => editor.getShapePageBounds(t) ?? [])
		if (boxes.length === 0) return editor.deleteShape(region.id)
		const r = padded(Box.Common(boxes))
		const p = region.props as { w: number; h: number }
		if (r.x === region.x && r.y === region.y && r.w === p.w && r.h === p.h) return
		refitting = true
		try {
			editor.updateShape({ id: region.id, type: 'geo', x: r.x, y: r.y, props: { w: r.w, h: r.h } })
		} finally {
			refitting = false
		}
	}
	// A hand-made move, resize or rotate of the box snaps back; colour and deletion are still allowed.
	const offGuard = editor.sideEffects.registerBeforeChangeHandler('shape', (prev, next, source) => {
		if (source !== 'user' || refitting || !isRegion(next)) return next
		const a = prev.props as { w: number; h: number }
		const b = next.props as { w: number; h: number }
		return prev.x === next.x && prev.y === next.y && prev.rotation === next.rotation && a.w === b.w && a.h === b.h ? next : prev
	})
	const offChange = editor.sideEffects.registerAfterChangeHandler('shape', (prev, next) => {
		if (isRegion(next) || next.type === 'arrow') return
		if (prev.x === next.x && prev.y === next.y && prev.rotation === next.rotation && JSON.stringify(prev.props) === JSON.stringify(next.props)) return
		for (const region of regionsFor(next.id)) refit(region)
	})
	// tldraw drops an arrow's bindings before our handler runs, so find orphans by what they lost: a link
	// arrow needs both ends bound.
	const sweepLinks = () => {
		const orphans = editor
			.getCurrentPageShapes()
			.filter((a) => a.type === 'arrow' && metaOf(a).kind === 'link' && editor.getBindingsFromShape(a, 'arrow').length < 2)
		if (orphans.length > 0) editor.deleteShapes(orphans.map((a) => a.id))
	}
	const offDelete = editor.sideEffects.registerAfterDeleteHandler('shape', (shape) => {
		if (isMark(shape)) {
			const rid = metaOf(shape).regionId as TLShapeId | undefined
			// Another mark may still use the same box (feedback on an answered mark).
			const shared = editor.getCurrentPageShapes().some((s) => isMark(s) && metaOf(s).regionId === rid)
			if (rid && !shared && editor.getShape(rid)) editor.deleteShape(rid)
		} else if (!isRegion(shape)) {
			for (const region of regionsFor(shape.id)) refit(region)
		}
		if (shape.type !== 'arrow') sweepLinks()
	})
	// Arrows are drawn behind blocks. tldraw lifts a bound arrow above the shapes it joins; undo that, and
	// send every arrow the user draws to the back.
	const offArrowLift = editor.sideEffects.registerBeforeChangeHandler('shape', (prev, next, source) =>
		source === 'user' && next.type === 'arrow' && next.index > prev.index ? { ...next, index: prev.index } : next
	)
	const offArrowBack = editor.sideEffects.registerAfterCreateHandler('shape', (shape, source) => {
		if (source === 'user' && shape.type === 'arrow') editor.sendToBack([shape.id])
	})
	return () => {
		offChange()
		offGuard()
		offDelete()
		offArrowLift()
		offArrowBack()
	}
}

// If the user edits an answered mark, it is a new message: reopen it so the agent sees it again.
export function reopenEditedMarks(editor: Editor) {
	const offReopen = editor.sideEffects.registerBeforeChangeHandler('shape', (prev, next) => {
		const m = metaOf(next)
		if (m.kind !== 'mark' || m.status !== 'answered') return next
		const before = markText(prev)
		const after = markText(next)
		if (before === after) return next
		return { ...next, opacity: 1, props: { ...next.props, color: 'light-red' }, meta: { ...next.meta, status: 'open' } } as typeof next
	})
	// The answered ✓ is a locked child, so removing it has to ignore the lock.
	const offBadge = editor.sideEffects.registerAfterChangeHandler('shape', (prev, next) => {
		if (!isMark(next) || metaOf(prev).status !== 'answered' || metaOf(next).status === 'answered') return
		const badges = editor.getSortedChildIdsForParent(next.id).filter((id) => metaOf(editor.getShape(id)!).kind === 'answered-badge')
		if (badges.length > 0) editor.run(() => editor.deleteShapes(badges), { ignoreShapeLock: true })
	})
	return () => {
		offReopen()
		offBadge()
	}
}

/** The shape's rich text as a stable string ('' when it has none). */
export const markText = (s: TLShape) => ('richText' in s.props ? JSON.stringify(s.props.richText ?? '') : '')
export const hasText = (s: TLShape) => markText(s).includes('"text":"')

/** Open marks with something written in them: the ones the agent can answer. */
export const openMarksWithText = (editor: Editor) => editor.getCurrentPageShapes().filter((s) => isOpenMark(s) && hasText(s))

/** Marks the agent (or the user) already answered, on the current page. */
export const answeredMarks = (editor: Editor) => editor.getCurrentPageShapes().filter((s) => isMark(s) && metaOf(s).status === 'answered')

/** Agent reply blocks answering this mark (server convention: kind 'agent-reply', meta.replyTo). */
export const repliesToMark = (editor: Editor, mark: TLShape) =>
	editor.getCurrentPageShapes().filter((s) => metaOf(s).kind === 'agent-reply' && metaOf(s).replyTo === mark.id)

export const countOpenMarks = (editor: Editor) => openMarksWithText(editor).length

// Shapes a person would count as "items": everything except arrows (links and connectors).
export const countItems = (editor: Editor) => editor.getCurrentPageShapes().filter((s) => s.type !== 'arrow' && !isRegion(s) && !['reply-label', 'answered-badge'].includes(metaOf(s).kind ?? '')).length
