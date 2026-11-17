import {
	TldrawUiMenuGroup,
	TldrawUiMenuItem,
	useEditor,
	useValue,
	createShapeId,
	type Editor,
	type TLShape,
	type TLShapeId,
	type TLUiActionsContextType,
} from 'tldraw'
import type { JSX } from 'react'
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
	const usable = useChat((s) => s.availability.kind === 'ready' && s.connected)
	const running = useChat((s) => s.running)
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
			{usable && (
				<button
					type="button"
					title="Ask the agent to answer your open marks"
					disabled={running}
					onClick={() => {
						chat.openPanel()
						chat.prompt('Answer my open marks')
					}}
					style={{
						...pillButton,
						textDecoration: 'none',
						border: '1px solid var(--tl-color-low-border)',
						borderRadius: 6,
						padding: '2px 8px',
						opacity: running ? 0.5 : 1,
					}}
				>
					Ask agent
				</button>
			)}
		</span>
	)
}
