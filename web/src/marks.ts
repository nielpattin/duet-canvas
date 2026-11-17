import { createShapeId, type Editor, type TLShape, type TLShapePartial, toRichText, type VecLike } from 'tldraw'

// Shared with the server (see server/src/shapes.ts, "Conventions stored in shape.meta").
interface BlockMeta {
	author?: string
	kind?: string
	status?: string
	targetIds?: string[]
}
const metaOf = (s: TLShape) => s.meta as BlockMeta

export const isMark = (s: TLShape) => metaOf(s).kind === 'mark'
export const isOpenMark = (s: TLShape) => isMark(s) && metaOf(s).status !== 'answered'

/** Things a mark can be aimed at: anything except arrows and other marks. */
export const canTarget = (s: TLShape) => s.type !== 'arrow' && !isMark(s)

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

// Adds a pink handwritten note (a "mark") the agent reads as a message from the user. Aimed at `targets`
// (including the agent's own blocks and media) it is joined to each by a dashed arrow; with no targets it
// is a free note at `point`.
export function createMark(editor: Editor, targets: TLShape[], point?: VecLike) {
	let origin: { x: number; y: number }
	if (targets.length > 0) {
		const bounds = targets.flatMap((t) => editor.getShapePageBounds(t) ?? [])
		const minY = Math.min(...bounds.map((b) => b.minY))
		const maxX = Math.max(...bounds.map((b) => b.maxX))
		origin = freeSpot(editor, { x: 0, y: minY, maxX })
	} else {
		const c = point ?? editor.getViewportPageBounds().center
		origin = { x: c.x - NOTE_SIZE / 2, y: c.y - NOTE_SIZE / 2 }
	}

	const id = createShapeId()
	const note: TLShapePartial = {
		id,
		type: 'note',
		x: origin.x,
		y: origin.y,
		props: { color: 'light-red', font: 'draw', richText: toRichText('') },
		meta: { author: 'user', kind: 'mark', status: 'open', targetIds: targets.map((t) => t.id) },
	}
	editor.createShape(note)

	const noteCenter = { x: origin.x + NOTE_SIZE / 2, y: origin.y + NOTE_SIZE / 2 }
	for (const target of targets) {
		const tb = editor.getShapePageBounds(target)
		if (!tb) continue
		const arrowId = createShapeId()
		editor.createShape({
			id: arrowId,
			type: 'arrow',
			x: 0,
			y: 0,
			props: { color: 'light-red', dash: 'dashed', start: noteCenter, end: tb.center, bend: 30 },
			meta: { author: 'user', kind: 'link' },
		})
		editor.createBindings(
			(['start', 'end'] as const).map((terminal) => ({
				type: 'arrow',
				fromId: arrowId,
				toId: terminal === 'start' ? id : target.id,
				props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' as const },
			}))
		)
	}

	editor.select(id)
	editor.setEditingShape(id)
}

// If the user edits an answered mark, it is a new message: reopen it so the agent sees it again.
export function reopenEditedMarks(editor: Editor) {
	return editor.sideEffects.registerBeforeChangeHandler('shape', (prev, next) => {
		const m = metaOf(next)
		if (m.kind !== 'mark' || m.status !== 'answered') return next
		const before = JSON.stringify((prev.props as { richText?: unknown }).richText)
		const after = JSON.stringify((next.props as { richText?: unknown }).richText)
		if (before === after) return next
		return { ...next, opacity: 1, meta: { ...next.meta, status: 'open' } }
	})
}

function hasText(s: TLShape) {
	return JSON.stringify((s.props as { richText?: unknown }).richText).includes('"text":"')
}

export const countOpenMarks = (editor: Editor) => editor.getCurrentPageShapes().filter((s) => isOpenMark(s) && hasText(s)).length

// Shapes a person would count as "items": everything except arrows (links and connectors).
export const countItems = (editor: Editor) => editor.getCurrentPageShapes().filter((s) => s.type !== 'arrow').length
