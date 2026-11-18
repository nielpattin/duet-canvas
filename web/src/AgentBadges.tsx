import { useEditor, useValue, type TLShapeId } from 'tldraw'
import { metaOf, repliesToMark } from './marks.ts'
import { SparkIcon } from './icons.tsx'

// A small spark in the corner of the agent's text blocks, so you can tell its words from yours at a glance.
// Its pictures carry the spark in their caption (see mediaCard.tsx); diagram shapes and arrows are not badged.
const AGENT_TEXT_KINDS = new Set(['agent-note', 'agent-reply'])

// Hovering or selecting a mark or its reply outlines the whole pair (mark, the box it drew, reply) in the agent's
// violet, so on a busy canvas you can see which answer belongs to which note.
function PairOutline() {
	const editor = useEditor()
	const boxes = useValue(
		'pair outline',
		() => {
			const selected = editor.getSelectedShapeIds()
			const id = editor.getHoveredShapeId() ?? (selected.length === 1 ? selected[0] : undefined)
			const s = id && editor.getShape(id)
			if (!s) return []
			const { kind, replyTo } = metaOf(s)
			const mark = kind === 'mark' ? s : kind === 'agent-reply' && replyTo ? editor.getShape(replyTo as TLShapeId) : undefined
			if (!mark) return []
			const ids = [mark.id, metaOf(mark).regionId, ...repliesToMark(editor, mark).map((r) => r.id)]
			return ids.flatMap((i) => {
				const b = i && editor.getShapePageBounds(i as TLShapeId)
				if (!b) return []
				const tl = editor.pageToViewport({ x: b.minX, y: b.minY })
				const br = editor.pageToViewport({ x: b.maxX, y: b.maxY })
				return [{ id: i as string, x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y }]
			})
		},
		[editor]
	)
	return (
		<>
			{boxes.map((b) => (
				<div
					key={b.id}
					style={{ position: 'absolute', left: b.x - 4, top: b.y - 4, width: b.w + 8, height: b.h + 8, border: '2px solid #6d4aff', borderRadius: 8, boxShadow: '0 0 0 3px rgba(109,74,255,.22)', pointerEvents: 'none' }}
				/>
			))}
		</>
	)
}

export function AgentBadges() {
	const editor = useEditor()
	const badges = useValue(
		'agent badges',
		() => {
			const out: { id: string; x: number; y: number; z: number }[] = []
			const z = editor.getZoomLevel()
			for (const s of editor.getCurrentPageRenderingShapesSorted()) {
				const m = s.meta as { author?: string; kind?: string }
				if (m.author !== 'agent' || !AGENT_TEXT_KINDS.has(m.kind ?? '')) continue
				const b = editor.getShapePageBounds(s)
				if (!b) continue
				const p = editor.pageToViewport({ x: b.maxX, y: b.minY })
				out.push({ id: s.id, x: p.x, y: p.y, z })
			}
			return out
		},
		[editor]
	)
	return (
		<>
			<PairOutline />
			{badges.map((b) => (
				<div
					key={b.id}
					title="Written by the agent"
					style={{
						position: 'absolute',
						// Scales with the canvas so the badge keeps its size relative to its block.
						left: b.x - 6 * b.z - 20,
						top: b.y + 6 * b.z,
						transform: `scale(${b.z})`,
						transformOrigin: '100% 0',
						width: 20,
						height: 20,
						borderRadius: '50%',
						background: '#6d4aff',
						color: 'white',
						display: 'grid',
						placeItems: 'center',
						boxShadow: '0 1px 3px rgba(0,0,0,.35)',
						pointerEvents: 'none',
					}}
				>
					<SparkIcon />
				</div>
			))}
		</>
	)
}
