import { useSyncExternalStore } from 'react'
import { attachmentFromBase64, MAX_IMAGES, prepareImage, type Attachment } from './images.ts'

// Wire format: mirrored from server/src/chat/wire.ts and hub.ts. Keep in sync.
export type WireBlock =
	| { type: 'text'; text: string }
	| { type: 'thinking'; text: string }
	| { type: 'tool'; id: string; name: string; args: string }
	| { type: 'image'; src?: string }
export type WireMessage = {
	role: 'user' | 'assistant' | 'tool' | 'summary'
	blocks: WireBlock[]
	toolCallId?: string
	isError?: boolean
	error?: string
}
export type ModelInfo = { provider: string; id: string; name: string; image: boolean }
export type Item = { id: string; message: WireMessage }
export type ChatInfo = { id: string; agent: AgentId; title: string; updatedAt: number; current: boolean }
export type Queue = { steering: string[]; followUp: string[] }
export type Usage = {
	cost: number
	tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number }
	context: { tokens: number; contextWindow: number; percent: number } | null
}
type CurrentModel = { provider: string; id: string; name: string }
export type { Attachment }

export type AgentId = 'omp' | 'claude' | 'codex' | 'opencode'
export type AgentInfo = { id: AgentId; label: string } & ({ ok: true; version: string } | { ok: false; message: string })

// 'off': no chat here (a Docker server cannot reach the user's agent CLIs). 'locked': native server, but this browser
// has no token yet. 'no-agent': native server, none of the supported agent CLIs found.
export type Availability =
	| { kind: 'checking' }
	| { kind: 'off' }
	| { kind: 'locked' }
	| { kind: 'no-agent'; message: string }
	| { kind: 'ready'; agents: AgentInfo[] }

export type ChatState = {
	availability: Availability
	/** The agent the server runs the chat on; null until the socket has said. */
	agent: AgentId | null
	connected: boolean
	open: boolean
	running: boolean
	/** How long the last finished run took, in ms; null while running or before any run this session. */
	tookMs: number | null
	stopping: boolean
	model: CurrentModel | null
	thinking: string | null
	levels: string[]
	items: Item[]
	models: ModelInfo[] | null
	chats: ChatInfo[] | null
	queue: Queue
	usage: Usage | null
	extraTools: string[]
	draft: { text: string; images: Attachment[] }
	error: string | null
}

type ServerMessage =
	| { t: 'agent'; agent: AgentId }
	| { t: 'state'; model: CurrentModel | null; thinking: string | null; levels: string[]; running: boolean; queue: Queue; usage: Usage; extraTools: string[] }
	| { t: 'history'; messages: WireMessage[] }
	| { t: 'message'; id: string; message: WireMessage; done: boolean }
	| { t: 'running'; running: boolean; ms?: number }
	| { t: 'queue'; steering: string[]; followUp: string[] }
	| { t: 'models'; models: ModelInfo[] }
	| { t: 'chats'; chats: ChatInfo[] }
	| { t: 'restored'; items: { text: string; images?: { mimeType: string; data: string }[] }[] }
	| { t: 'error'; message: string }

const OPEN_KEY = 'canvas.chat.open'
// Older builds kept the token here; it is handed to the server once and dropped.
const LEGACY_TOKEN_KEY = 'canvas.chat.token'

// Trades an unlock code for the server's HttpOnly cookie, so page scripts never hold the token.
const unlock = async (token: string) =>
	(await fetch('/api/chat/unlock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })).ok

// The unlock link carries the code once (?chat=...); strip it from the address bar.
function takeLinkToken() {
	const url = new URL(location.href)
	const fromLink = url.searchParams.get('chat')
	if (fromLink) {
		url.searchParams.delete('chat')
		history.replaceState(null, '', url)
	}
	const legacy = localStorage.getItem(LEGACY_TOKEN_KEY)
	localStorage.removeItem(LEGACY_TOKEN_KEY)
	return fromLink ?? legacy
}

let state: ChatState = {
	availability: { kind: 'checking' },
	agent: null,
	connected: false,
	open: localStorage.getItem(OPEN_KEY) === '1',
	running: false,
	tookMs: null,
	stopping: false,
	model: null,
	thinking: null,
	levels: [],
	items: [],
	models: null,
	chats: null,
	queue: { steering: [], followUp: [] },
	usage: null,
	extraTools: [],
	draft: { text: '', images: [] },
	error: null,
}
const listeners = new Set<() => void>()

function set(patch: Partial<ChatState>) {
	state = { ...state, ...patch }
	for (const l of listeners) l()
}

const subscribe = (l: () => void) => {
	listeners.add(l)
	return () => listeners.delete(l)
}

// Pick the fields a component needs (selectors must return an existing value, not a freshly built one), so typing in
// the composer does not re-render the whole conversation.
export function useChat(): ChatState
export function useChat<T>(select: (s: ChatState) => T): T
export function useChat<T>(select?: (s: ChatState) => T) {
	return useSyncExternalStore(subscribe, () => (select ? select(state) : state))
}

let ws: WebSocket | undefined

const cmd = (m: Record<string, unknown>) => {
	if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m))
}

function revoke(images: Attachment[]) {
	for (const i of images) URL.revokeObjectURL(i.url)
}

function onServer(m: ServerMessage) {
	switch (m.t) {
		case 'agent':
			// Everything below belongs to the agent that was left: models, chats, usage and the conversation.
			set({ agent: m.agent, model: null, thinking: null, levels: [], models: null, chats: null, items: [], queue: { steering: [], followUp: [] }, usage: null, extraTools: [], running: false, tookMs: null, stopping: false })
			break
		case 'state':
			set({ model: m.model, thinking: m.thinking, levels: m.levels, running: m.running, queue: m.queue, usage: m.usage, extraTools: m.extraTools, stopping: m.running ? state.stopping : false })
			break
		case 'history':
			set({ items: m.messages.map((message, i) => ({ id: `h${i}`, message })), tookMs: null })
			break
		case 'message': {
			// Every update carries the whole message so far, so replacing by id is all the reducer needs.
			// The live message is nearly always last, so search from the end.
			const item = { id: m.id, message: m.message }
			let i = state.items.length - 1
			while (i >= 0 && state.items[i]!.id !== m.id) i--
			set({ items: i < 0 ? [...state.items, item] : state.items.map((x, j) => (j === i ? item : x)) })
			break
		}
		case 'running':
			set({ running: m.running, tookMs: m.running ? null : (m.ms ?? state.tookMs), stopping: m.running ? state.stopping : false })
			break
		case 'queue':
			set({ queue: { steering: m.steering, followUp: m.followUp } })
			break
		case 'models':
			set({ models: m.models })
			break
		case 'chats':
			set({ chats: m.chats })
			break
		case 'restored': {
			// Text and pictures the user had queued come back into the composer.
			const text = [state.draft.text, ...m.items.map((i) => i.text)].filter(Boolean).join('\n')
			const images = [...state.draft.images, ...m.items.flatMap((i) => i.images?.map((x) => attachmentFromBase64(x.mimeType, x.data)) ?? [])].slice(0, MAX_IMAGES)
			set({ draft: { text, images } })
			break
		}
		case 'error':
			set({ error: m.message })
			break
	}
}

function connect() {
	const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/chat`)
	ws = socket
	socket.onopen = () => set({ connected: true, error: null })
	socket.onmessage = (e) => onServer(JSON.parse(e.data))
	socket.onclose = () => {
		ws = undefined
		set({ connected: false, running: false, stopping: false })
		// Re-check rather than blindly reconnect: the token or omp may have changed.
		setTimeout(check, 2000)
	}
}

async function check() {
	try {
		const availability: Availability = await (await fetch('/api/chat/status')).json()
		set({ availability })
		if (availability.kind === 'ready' && !ws) connect()
	} catch {
		// The server may just be restarting; keep what we know and look again.
		if (state.availability.kind === 'checking') set({ availability: { kind: 'off' } })
		else setTimeout(check, 2000)
	}
}
void (async () => {
	const linkToken = takeLinkToken()
	if (linkToken) await unlock(linkToken).catch(() => false)
	await check()
})()

function send(mode: 'steer' | 'followUp') {
	const { text, images } = state.draft
	if (!text.trim() && !images.length) return
	chat.prompt(text, { images, mode })
	revoke(images)
	set({ draft: { text: '', images: [] } })
}

export const chat = {
	recheck: check,
	// Accepts the whole unlock link or just its code; false when the server rejects it.
	async unlock(input: string) {
		const text = input.trim()
		const code = text.includes('chat=') ? (new URL(text, location.href).searchParams.get('chat') ?? '') : text
		const ok = code !== '' && (await unlock(code).catch(() => false))
		if (ok) await check()
		return ok
	},
	toggle() {
		const open = !state.open
		localStorage.setItem(OPEN_KEY, open ? '1' : '0')
		set({ open })
	},
	openPanel() {
		if (state.open) return
		localStorage.setItem(OPEN_KEY, '1')
		set({ open: true })
	},
	// Programmatic prompt (suggestions, marks). The composer's own send goes through chat.send.
	prompt: (message: string, opts: { images?: Attachment[]; mode?: 'steer' | 'followUp' } = {}) =>
		cmd({ t: 'prompt', message, mode: opts.mode ?? 'steer', images: (opts.images ?? []).map(({ mimeType, data }) => ({ mimeType, data })) }),
	send,
	stop() {
		set({ stopping: true })
		cmd({ t: 'abort' })
	},
	unqueue: (message: string, queue: 'steering' | 'followUp') => cmd({ t: 'unqueue', message, queue }),
	promote: (message: string) => cmd({ t: 'promote', message }),
	newChat: () => cmd({ t: 'new_chat' }),
	setAgent: (agent: AgentId) => cmd({ t: 'set_agent', agent }),
	loadChats: () => cmd({ t: 'chats' }),
	openChat: (id: string) => cmd({ t: 'open_chat', id }),
	deleteChat: (id: string) => cmd({ t: 'delete_chat', id }),
	loadModels() {
		if (!state.models) cmd({ t: 'models' })
	},
	setModel: (m: ModelInfo) => cmd({ t: 'set_model', provider: m.provider, modelId: m.id }),
	setThinking: (level: string) => cmd({ t: 'set_thinking', level }),
	setDraftText: (text: string) => set({ draft: { ...state.draft, text } }),
	async addImages(files: File[]) {
		const room = MAX_IMAGES - state.draft.images.length
		if (files.length > room) set({ error: `Up to ${MAX_IMAGES} images per message` })
		try {
			const added = await Promise.all(files.slice(0, Math.max(room, 0)).map(prepareImage))
			set({ draft: { ...state.draft, images: [...state.draft.images, ...added] } })
		} catch (e) {
			set({ error: e instanceof Error ? e.message : String(e) })
		}
	},
	removeImage(id: string) {
		revoke(state.draft.images.filter((i) => i.id === id))
		set({ draft: { ...state.draft, images: state.draft.images.filter((i) => i.id !== id) } })
	},
	setError: (error: string | null) => set({ error }),
	dismissError: () => set({ error: null }),
}
