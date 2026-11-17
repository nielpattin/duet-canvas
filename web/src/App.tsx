import { useSync } from '@tldraw/sync'
import {
	defaultShapeUtils,
	DefaultToolbar,
	DefaultToolbarContent,
	Tldraw,
	TldrawUiMenuToolItem,
	useEditor,
	useValue,
	type Editor,
	type TLAssetStore,
	type TLComponents,
	type TLUiOverrides,
} from 'tldraw'
import 'tldraw/tldraw.css'
import { AgentBadges } from './AgentBadges.tsx'
import { onBridgeMessage, setBridgeEditor } from './bridge.ts'
import { countItems, countOpenMarks, reopenEditedMarks } from './marks.ts'
import { MarkTool } from './MarkTool.ts'
import { convertUserMediaToCards, MediaCardShapeUtil } from './mediaCard.tsx'
import { pushContextToServer } from './pushContext.ts'

const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws'

// Large files (images, video) live on the server's disk next to the canvas database.
const assets: TLAssetStore = {
	async upload(_asset, file) {
		const id = `${crypto.randomUUID()}-${file.name}`
		const res = await fetch(`/uploads/${encodeURIComponent(id)}`, { method: 'PUT', body: file })
		if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
		return { src: `${location.origin}/uploads/${encodeURIComponent(id)}` }
	},
	resolve: (asset) => asset.props.src,
}

const shapeUtils = [MediaCardShapeUtil]
// The sync store builds its own schema, so unlike <Tldraw shapeUtils> it needs the built-in shapes listed too.
const syncShapeUtils = [...defaultShapeUtils, MediaCardShapeUtil]
const tools = [MarkTool]

function MarkIcon() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#e0457b" strokeWidth="1.6" strokeLinejoin="round">
			<path d="M8 1.5A4.5 4.5 0 0 0 3.5 6c0 3 4.5 8.5 4.5 8.5S12.5 9 12.5 6A4.5 4.5 0 0 0 8 1.5Z" />
			<circle cx="8" cy="6" r="1.6" />
		</svg>
	)
}

const overrides: TLUiOverrides = {
	tools(editor, toolsMap) {
		toolsMap.mark = { id: 'mark', icon: <MarkIcon />, label: 'tool.mark', kbd: 'm', onSelect: () => editor.setCurrentTool('mark') }
		return toolsMap
	},
	translations: { en: { 'tool.mark': 'Mark: leave the agent a note on something' } },
}

function Toolbar() {
	return (
		<DefaultToolbar>
			<TldrawUiMenuToolItem toolId="mark" />
			<DefaultToolbarContent />
		</DefaultToolbar>
	)
}

function CountPill() {
	const editor = useEditor()
	const open = useValue('open marks', () => countOpenMarks(editor), [editor])
	const items = useValue('item count', () => countItems(editor), [editor])
	return (
		<div style={{ display: 'flex', margin: 8, pointerEvents: 'all' }}>
			<span
				title="Marks the agent has not answered yet"
				style={{
					padding: '8px 12px',
					borderRadius: 10,
					background: 'white',
					border: `2px solid ${open > 0 ? '#e0457b' : '#d6d6d6'}`,
					color: open > 0 ? '#9b1d4d' : '#666',
					font: '600 13px system-ui',
				}}
			>
				{items} items · {open} open {open === 1 ? 'mark' : 'marks'}
			</span>
		</div>
	)
}

const components: TLComponents = { SharePanel: CountPill, Toolbar, InFrontOfTheCanvas: AgentBadges }

function onMount(editor: Editor) {
	const stopPush = pushContextToServer(editor)
	const stopRules = reopenEditedMarks(editor)
	const stopCards = convertUserMediaToCards(editor)
	setBridgeEditor(editor)
	return () => {
		setBridgeEditor(null)
		stopPush()
		stopRules()
		stopCards()
	}
}

export function App() {
	const store = useSync({
		uri: `${wsProtocol}://${location.host}/connect`,
		assets,
		shapeUtils: syncShapeUtils,
		onCustomMessageReceived: onBridgeMessage,
	})
	return (
		<div style={{ position: 'fixed', inset: 0 }}>
			<Tldraw store={store} shapeUtils={shapeUtils} tools={tools} overrides={overrides} components={components} onMount={onMount} />
		</div>
	)
}
