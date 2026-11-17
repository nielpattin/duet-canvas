import { useSync } from '@tldraw/sync'
import { Tldraw, type TLAssetStore, type TLComponents, useEditor, useValue, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'
import { countItems, countOpenAnnotations, createAnnotation, reopenEditedAnnotations } from './annotations.ts'
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

function AnnotateButton() {
	const editor = useEditor()
	const open = useValue('open annotations', () => countOpenAnnotations(editor), [editor])
	const items = useValue('item count', () => countItems(editor), [editor])
	return (
		<div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 8, pointerEvents: 'all' }}>
			<span
				title="Annotations the agent has not answered yet"
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
			<button
				onClick={() => createAnnotation(editor)}
				title="Leave the agent a note. Select shapes first to aim it at them."
				style={{
					padding: '8px 14px',
					border: '2px solid #e0457b',
					borderRadius: 10,
					background: '#fde4ee',
					color: '#9b1d4d',
					font: '600 14px system-ui',
					cursor: 'pointer',
				}}
			>
				✎ Annotate
			</button>
		</div>
	)
}

const components: TLComponents = { SharePanel: AnnotateButton }

function onMount(editor: Editor) {
	const stopPush = pushContextToServer(editor)
	const stopRules = reopenEditedAnnotations(editor)
	return () => {
		stopPush()
		stopRules()
	}
}

export function App() {
	const store = useSync({ uri: `${wsProtocol}://${location.host}/connect`, assets })
	return (
		<div style={{ position: 'fixed', inset: 0 }}>
			<Tldraw store={store} components={components} onMount={onMount} />
		</div>
	)
}
