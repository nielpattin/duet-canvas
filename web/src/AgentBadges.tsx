import { useEditor, useValue } from 'tldraw'
import { SparkIcon } from './icons.tsx'

// A small spark in the corner of the agent's text blocks, so you can tell its words from yours at a glance.
// Its pictures carry the spark in their caption (see mediaCard.tsx); diagram shapes and arrows are not badged.
const AGENT_TEXT_KINDS = new Set(['agent-note', 'agent-reply'])

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
