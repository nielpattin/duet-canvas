import {
	NoteShapeUtil,
	stopEventPropagation,
	TldrawUiMenuGroup,
	TldrawUiMenuItem,
	useEditor,
	useValue,
	createShapeId,
	type Editor,
	type TLNoteShape,
	type TLShape,
	type TLShapeId,
	type TLUiActionsContextType,
} from 'tldraw'
import type { JSX } from 'react'
import './markAssist.css'
import { chat, useChat } from './chat/store.ts'
import { answeredMarks, countItems, countOpenMarks, hasText, isOpenMark, markSelection, openMarksWithText, repliesToMark } from './marks.ts'

// Top-to-bottom, then left-to-right.
const readingOrder = (editor: Editor, marks: TLShape[]) =>
	marks.slice().sort((a, b) => {
		const ba = editor.getShapePageBounds(a)
		const bb = editor.getShapePageBounds(b)
		return ba && bb ? ba.y - bb.y || ba.x - bb.x : 0
	})

// Selects the open mark after the selected one (or the first) and brings it into view.
function nextOpenMark(editor: Editor) {
	const marks = readingOrder(editor, openMarksWithText(editor))
	if (marks.length === 0) return
	const selectedIds = editor.getSelectedShapeIds()
	const next = marks[(marks.findIndex((m) => selectedIds.includes(m.id)) + 1) % marks.length]
	if (!next) return
	const bounds = editor.getShapePageBounds(next)
	editor.select(next.id)
	if (!bounds) return
	// Already on screen: keep the zoom and just bring it to the middle.
	if (editor.getViewportPageBounds().contains(bounds)) editor.centerOnPoint(bounds.center, { animation: { duration: 200 } })
	else editor.zoomToSelection({ animation: { duration: 200 } })
}

// Deletes answered marks and the agent replies that answer them, as one undo step.
function clearAnsweredMarks(editor: Editor) {
	const answered = answeredMarks(editor)
	if (answered.length === 0) return
	const ids = new Set<TLShapeId>()
	for (const mark of answered) {
		ids.add(mark.id)
		for (const reply of repliesToMark(editor, mark)) ids.add(reply.id)
		// Resolved marks have no reply block, answered ones also name it directly.
		const answeredBy = mark.meta.answeredBy
		if (typeof answeredBy === 'string') ids.add(createShapeId(answeredBy))
	}
	editor.markHistoryStoppingPoint('clear answered marks')
	editor.run(() => editor.deleteShapes([...ids]))
}

export const markTranslations = {
	'action.mark-selection': 'Mark selection',
	'action.next-open-mark': 'Next open mark',
	'action.clear-answered-marks': 'Clear answered marks',
}

/** Registers the mark actions; call from `overrides.actions`. */
export function addMarkActions(editor: Editor, actions: TLUiActionsContextType) {
	actions['mark-selection'] = {
		id: 'mark-selection',
		label: 'action.mark-selection',
		kbd: 'cmd+m,ctrl+m',
		onSelect: () => markSelection(editor),
	}
	actions['next-open-mark'] = {
		id: 'next-open-mark',
		label: 'action.next-open-mark',
		kbd: 'shift+m',
		onSelect: () => nextOpenMark(editor),
	}
	actions['clear-answered-marks'] = {
		id: 'clear-answered-marks',
		label: 'action.clear-answered-marks',
		onSelect: () => clearAnsweredMarks(editor),
	}
}

/** Mark items for the context menu; render inside `DefaultContextMenu`. */
export function MarkMenuItems(): JSX.Element | null {
	const editor = useEditor()
	const hasSelection = useValue('has selection', () => editor.getSelectedShapeIds().length > 0, [editor])
	const openIds = useValue(
		'open marks in selection',
		() =>
			editor
				.getSelectedShapes()
				.filter((s) => isOpenMark(s) && hasText(s))
				.map((s) => s.id),
		[editor]
	)
	const answered = useValue('answered marks', () => answeredMarks(editor).length, [editor])
	const usable = useChat((s) => s.availability.kind === 'ready' && s.connected)
	if (!hasSelection && answered === 0) return null
	return (
		<>
			{hasSelection && (
				<TldrawUiMenuGroup id="mark-selection-group">
					<TldrawUiMenuItem id="mark-selection" label="Mark selection" kbd="cmd+m,ctrl+m" onSelect={() => markSelection(editor)} />
				</TldrawUiMenuGroup>
			)}
			{openIds.length > 0 && usable && (
				<TldrawUiMenuGroup id="mark-ask-group">
					<TldrawUiMenuItem
						id="mark-ask-agent"
						label="Ask agent to answer this mark"
						onSelect={() => {
							chat.openPanel()
							chat.prompt(`Answer the open mark(s): ${openIds.join(', ')}`)
						}}
					/>
				</TldrawUiMenuGroup>
			)}
			{answered > 0 && (
				<TldrawUiMenuGroup id="mark-clear-group">
					<TldrawUiMenuItem id="clear-answered-marks" label={`Clear answered marks (${answered})`} onSelect={() => clearAnsweredMarks(editor)} />
				</TldrawUiMenuGroup>
			)}
		</>
	)
}

const pillButton = {
	background: 'none',
	border: 0,
	padding: 0,
	font: 'inherit',
	color: 'inherit',
	cursor: 'pointer',
	textDecoration: 'underline dotted',
} as const

/** Counts on the share panel; the open-marks part jumps to the next open mark. */
export function OpenMarksPill(): JSX.Element {
	const editor = useEditor()
	const open = useValue('open marks', () => countOpenMarks(editor), [editor])
	const items = useValue('item count', () => countItems(editor), [editor])
	const pink = open > 0
	return (
		<span
			title={pink ? 'Marks the agent has not answered yet' : undefined}
			style={{
				display: 'inline-flex',
				alignItems: 'center',
				gap: 8,
				padding: '8px 12px',
				borderRadius: 10,
				background: 'var(--tl-color-panel)',
				border: `2px solid ${pink ? '#e0457b' : 'var(--tl-color-low-border)'}`,
				color: 'var(--tl-color-text)',
				font: '600 13px system-ui',
			}}
		>
			{items} items ·{' '}
			{pink ? (
				<button type="button" title="Jump to the next open mark (Shift+M)" onClick={() => nextOpenMark(editor)} style={{ ...pillButton, color: '#e0457b' }}>
					{open} open {open === 1 ? 'mark' : 'marks'}
				</button>
			) : (
				<span>{open} open marks</span>
			)}
		</span>
	)
}

// Marks are tldraw notes, so the note util draws the button inside the shape (as tldraw does for a note's link button).
export class MarkNoteShapeUtil extends NoteShapeUtil {
	override component(shape: TLNoteShape) {
		return (
			<>
				{super.component(shape)}
				{isOpenMark(shape) && hasText(shape) && <MarkAskButton id={shape.id} />}
			</>
		)
	}
}

/**
 * "Ask" badge on an open mark's corner: the agent answers that mark only. Same size, spot and hand-drawn look as the
 * green ✓ an answered mark gets (server/src/shapes.ts addBadge), so the badge just turns from "ask" into "done".
 */
function MarkAskButton({ id }: { id: TLShapeId }): JSX.Element | null {
	const usable = useChat((s) => s.availability.kind === 'ready' && s.connected)
	const running = useChat((s) => s.running)
	if (!usable) return null
	return (
		<button
			type="button"
			className="mark-ask"
			title="Ask the agent to answer this mark"
			aria-label="Ask the agent to answer this mark"
			disabled={running}
			// The canvas would otherwise take the press as select/drag of the note.
			onPointerDown={stopEventPropagation}
			onClick={() => {
				chat.openPanel()
				chat.prompt(`Answer only the open mark ${id}; leave the other marks alone.`)
			}}
		>
			<svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
				{/* A pen circle that overshoots where it started, like the ✓ badge's drawn ring. */}
				<path
					className="mark-ask__disc"
					d="M21.5 3.2C31 3.6 37 11 36.6 20.4 36.2 30 29 36.9 19.6 36.6 10.4 36.3 3.3 29.2 3.5 20 3.7 11.2 10 4 18.6 3.4c1.4-.1 3.8.1 5 1"
				/>
				<path d="M20.2 28.2 20.4 12.6M13.6 18.8l6.8-6.6 6.4 6.3" />
			</svg>
		</button>
	)
}
