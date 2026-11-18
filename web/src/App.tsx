import { useSync } from '@tldraw/sync'
import {
	defaultShapeUtils,
	DefaultContextMenu,
	DefaultContextMenuContent,
	DefaultToolbar,
	DefaultToolbarContent,
	react,
	Tldraw,
	TldrawUiMenuToolItem,
	type Editor,
	type TLAssetStore,
	type TLComponents,
	type TLUiContextMenuProps,
	type TLUiOverrides,
} from 'tldraw'
import 'tldraw/tldraw.css'
import { AgentBadges } from './AgentBadges.tsx'
import { ChatPanel, ChatToggle } from './chat/ChatPanel.tsx'
import { setDarkMode } from './chat/theme.ts'
import { onBridgeMessage, setBridgeEditor } from './bridge.ts'
import { keepMarksTidy, reopenEditedMarks } from './marks.ts'
import { addMarkActions, MarkMenuItems, MarkNoteShapeUtil, markTranslations, OpenMarksPill } from './markAssist.tsx'
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

const shapeUtils = [MediaCardShapeUtil, MarkNoteShapeUtil]
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
	actions(editor, actions) {
		addMarkActions(editor, actions)
		return actions
	},
	translations: { en: { 'tool.mark': 'Mark: leave the agent a note on something', ...markTranslations } },
}

function ContextMenu(props: TLUiContextMenuProps) {
	return (
		<DefaultContextMenu {...props}>
			<MarkMenuItems />
			<DefaultContextMenuContent />
		</DefaultContextMenu>
	)
}

function Toolbar() {
	return (
		<DefaultToolbar>
			<TldrawUiMenuToolItem toolId="mark" />
			<DefaultToolbarContent />
		</DefaultToolbar>
	)
}

function SharePanel() {
	return (
		<div style={{ display: 'flex', gap: 8, margin: 8, pointerEvents: 'all' }}>
			<OpenMarksPill />
			<ChatToggle />
		</div>
	)
}

const components: TLComponents = { SharePanel, Toolbar, ContextMenu, InFrontOfTheCanvas: AgentBadges }

function onMount(editor: Editor) {
	const stopPush = pushContextToServer(editor)
	const stopRules = reopenEditedMarks(editor)
	const stopTidy = keepMarksTidy(editor)
	const stopCards = convertUserMediaToCards(editor)
	// The chat panel sits outside <Tldraw>, so it gets tldraw's theme (light/dark/system, live) from here.
	const stopTheme = react('chat theme', () => setDarkMode(editor.user.getIsDarkMode()))
	setBridgeEditor(editor)
	return () => {
		setBridgeEditor(null)
		stopTheme()
		stopPush()
		stopRules()
		stopTidy()
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
		<div style={{ position: 'fixed', inset: 0, display: 'flex' }}>
			<div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
				<Tldraw store={store} shapeUtils={shapeUtils} tools={tools} overrides={overrides} components={components} onMount={onMount} />
			</div>
			<ChatPanel />
		</div>
	)
}
