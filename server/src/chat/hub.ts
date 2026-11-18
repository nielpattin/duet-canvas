import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { WebSocket } from 'ws'
import { z } from 'zod'
import { DATA_DIR, OMP_BIN, PORT } from '../config.ts'
import { onTokenChange } from './auth.ts'
import { deleteChat, findChat, listChats, SESSIONS, touchChat } from './chats.ts'
import { userMcpServerNames } from './mcpGuard.ts'
import { clearPendingReplies, reservePendingReplies } from '../shapes.ts'
import { OmpRpc, type Frame } from './rpc.ts'
import { attachmentNote, clip, errorText, saveChatImage, toWire, type WireMessage } from './wire.ts'

const run = promisify(execFile)

// A canvas hiccup must never take the chat down with it.
function canvasSafely(fn: () => unknown) {
	try {
		fn()
	} catch (e) {
		console.error('canvas pending replies:', errorText(e))
	}
}

// omp keys sessions by cwd and loads context files from it, so it gets its own workspace instead of the user's project.
const WORKSPACE = join(DATA_DIR, 'workspace')
const CONFIG = join(WORKSPACE, 'chat.yml')
const PREFS = join(DATA_DIR, 'chat-prefs.json')

// The last model and effort the user picked. omp starts a new chat on its own default, so we put the choice back.
type Prefs = { model?: { provider: string; id: string }; thinking?: string }
function loadPrefs(): Prefs {
	try {
		return JSON.parse(readFileSync(PREFS, 'utf8'))
	} catch {
		return {}
	}
}
function savePrefs(patch: Prefs) {
	writeFileSync(PREFS, JSON.stringify({ ...loadPrefs(), ...patch }))
}

// The chat agent may only touch the canvas. `--no-tools` drops every built-in (bash, edit, eval, fs, LSP...) and
// `tools.xdev: false` keeps the MCP tools top-level, so the model needs no read/write to reach them.
// Extensions, skills, rules and context files are off so the user's coding setup does not leak into this chat.
// Checked with get_state.dumpTools: exactly the 14 canvas tools (see mcpGuard.ts for the user's own MCP servers).
// Replaces omp's coding-assistant prompt. Tool mechanics (marks, clock, layout) live in the MCP server's instructions
// (mcp.ts); this only sets who the agent is and how it behaves.
const SYSTEM_PROMPT = `
You are the canvas agent: a collaborator on a shared infinite whiteboard the user has open beside this chat. You can see and edit the board only through your canvas tools. You cannot run commands, read files or browse; do not offer to.

How to work
- Ground yourself first. If the user says "this", "here" or refers to something on the board, look (get_context, list_marks, get_canvas) before answering. Never guess what is on the canvas.
- The user edits while you work. Before editing after a long step, check what changed and leave their shapes alone unless asked.
- Marks are the user's messages on the board. Answer each open mark with the canvas itself where you can (a diagram, a revised block), and close every mark you handled.
- Put substance on the canvas and keep chat short: the board is the deliverable, the chat only says what you did and where (page, area). Do not repeat in chat what you wrote on the board.
- Think in diagrams, not paragraphs. Prefer connected shapes, groups and short labels over long prose. Keep blocks scannable: one idea per block, plain words, no filler.
- Make things look tidy: align to a grid, keep related items close, avoid overlap and crossing arrows, and let the server place new content when position does not matter.
- Look at the result only when appearance matters. Do not screenshot routine edits.
- Do the whole request. If it is ambiguous in a way that changes the outcome, ask one short question; otherwise pick the sensible reading, do it, and say which you chose.
- Be direct and honest. If something cannot be done with your tools, say so plainly. No flattery, no apologies, no emojis unless the user uses them.
`.trim()

const OMP_ARGS = [
	'--system-prompt', SYSTEM_PROMPT,
	'--mode', 'rpc', '--no-ui', '--yolo', '--continue',
	'--no-tools', '--no-extensions', '--no-skills', '--no-rules', '--no-context-files', '--no-lsp',
	'--session-dir', SESSIONS, '--config', CONFIG,
]

const EVENTS = ['agent_start', 'agent_end', 'message_start', 'message_update', 'message_end', 'model_changed', 'thinking_level_changed', 'queue_update']

function prepareWorkspace() {
	mkdirSync(join(WORKSPACE, '.omp'), { recursive: true })
	mkdirSync(SESSIONS, { recursive: true })
	const servers: Record<string, unknown> = {}
	for (const name of userMcpServerNames()) servers[name] = { type: 'http', url: 'http://127.0.0.1:9/disabled', enabled: false }
	servers.canvas = { type: 'http', url: `http://127.0.0.1:${PORT}/mcp`, enabled: true }
	writeFileSync(join(WORKSPACE, '.omp', 'mcp.json'), JSON.stringify({ mcpServers: servers }))
	writeFileSync(CONFIG, 'tools:\n  xdev: false\n')
}

export async function detectOmp(): Promise<{ ok: true; version: string } | { ok: false; message: string }> {
	try {
		const { stdout } = await run(OMP_BIN, ['--version'], { timeout: 8000, windowsHide: true })
		return { ok: true, version: stdout.trim() }
	} catch (e) {
		return { ok: false, message: `Could not run "${OMP_BIN}" (${errorText(e)}). Install omp or set OMP_BIN.` }
	}
}

const Image = z.object({ mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']), data: z.string().max(14_000_000) })
const Queue = z.enum(['steering', 'followUp'])
const Cmd = z.discriminatedUnion('t', [
	z.object({ t: z.literal('prompt'), message: z.string().max(100_000), images: z.array(Image).max(6).default([]), mode: z.enum(['steer', 'followUp']).default('steer') }),
	z.object({ t: z.literal('abort') }),
	z.object({ t: z.literal('new_chat') }),
	z.object({ t: z.literal('models') }),
	z.object({ t: z.literal('set_model'), provider: z.string().min(1), modelId: z.string().min(1) }),
	z.object({ t: z.literal('set_thinking'), level: z.string().min(1) }),
	z.object({ t: z.literal('chats') }),
	z.object({ t: z.literal('open_chat'), id: z.string().min(1) }),
	z.object({ t: z.literal('delete_chat'), id: z.string().min(1) }),
	z.object({ t: z.literal('unqueue'), message: z.string(), queue: Queue }),
	z.object({ t: z.literal('promote'), message: z.string() }),
])

const send = (ws: WebSocket, m: unknown) => {
	if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m))
}

const PAGE = 24 // messages per history page: small enough that pages full of screenshots stay under the frame limit
const STATE_DEBOUNCE_MS = 1000

// One omp process (started on first use, kept alive) serves every browser tab. The server owns the chat, as it owns the canvas.
export class ChatHub {
	#rpc: OmpRpc | undefined
	#starting: Promise<OmpRpc> | undefined
	#clients = new Set<WebSocket>()
	#running = false
	#startedAt = 0
	#current: { id: string; file: string } | undefined
	#stateTimer: NodeJS.Timeout | undefined
	#gen = 0 // omp message ids restart at msg-1 in every process; the generation keeps them unique for the browser

	constructor() {
		// A rotated token must also cut the sockets that connected with the old one.
		onTokenChange(() => this.#clients.forEach((ws) => ws.terminate()))
	}

	add(ws: WebSocket) {
		this.#clients.add(ws)
		ws.on('close', () => this.#clients.delete(ws))
		ws.on('message', (raw) => void this.#handle(ws, raw.toString()))
		void this.#sync(ws)
	}

	dispose() {
		clearTimeout(this.#stateTimer)
		this.#rpc?.close()
	}

	#broadcast(m: unknown) {
		for (const ws of this.#clients) send(ws, m)
	}

	#ensure(): Promise<OmpRpc> {
		if (this.#rpc && !this.#rpc.closed) return Promise.resolve(this.#rpc)
		this.#starting ??= this.#start().finally(() => (this.#starting = undefined))
		return this.#starting
	}

	async #start() {
		prepareWorkspace()
		const gen = ++this.#gen
		const rpc = new OmpRpc(OMP_BIN, OMP_ARGS, WORKSPACE, (f) => this.#onFrame(gen, f), (reason) => {
			if (this.#rpc === rpc) this.#rpc = undefined
			this.#running = false
			this.#broadcast({ t: 'running', running: false })
			this.#broadcast({ t: 'error', message: reason })
		})
		await rpc.request('set_event_filter', { events: EVENTS, messageUpdates: 'full' })
		await this.#applyPrefs(rpc)
		this.#rpc = rpc
		return rpc
	}

	// Best effort: a model that is gone or has lost its credentials must not stop the chat from starting.
	async #applyPrefs(rpc: OmpRpc) {
		const { model, thinking } = loadPrefs()
		try {
			const s = await rpc.request('get_state')
			if (model && !(s.model?.provider === model.provider && s.model?.id === model.id)) {
				await rpc.request('set_model', { provider: model.provider, modelId: model.id }, 60_000)
			}
			if (thinking && thinking !== (await rpc.request('get_state')).thinkingLevel) await rpc.request('set_thinking_level', { level: thinking })
		} catch {
			// keep whatever omp chose
		}
	}

	#onFrame(gen: number, f: Frame) {
		switch (f.type) {
			case 'agent_start':
				canvasSafely(reservePendingReplies)
				this.#startedAt = Date.now()
				this.#running = true
				this.#broadcast({ t: 'running', running: true })
				break
			case 'agent_end':
				canvasSafely(clearPendingReplies)
				this.#running = false
				this.#broadcast({ t: 'running', running: false, ms: Date.now() - this.#startedAt })
				this.#pushState(true)
				break
			case 'message_start':
			case 'message_end':
			case 'message_update': {
				// 'full' updates carry the whole message so far, so a tab that joins mid-stream needs no replay.
				const message = toWire(f.type === 'message_update' ? f.assistantMessageEvent?.partial : f.message)
				if (message) this.#broadcast({ t: 'message', id: `${gen}:${f.messageId}`, message, done: f.type === 'message_end' })
				// Keep the spend counter moving during long runs without a stats request per token.
				if (f.type === 'message_end' && f.message?.role === 'assistant') this.#pushState(false)
				break
			}
			case 'queue_update':
				this.#broadcast({ t: 'queue', steering: f.steering ?? [], followUp: f.followUp ?? [] })
				break
			case 'prompt_result':
				if (f.status === 'error') this.#broadcast({ t: 'error', message: f.error?.message ?? 'The request failed' })
				break
			case 'model_changed':
			case 'thinking_level_changed':
				this.#pushState(false)
				break
		}
	}

	#pushState(touch: boolean) {
		if (!this.#rpc) return
		clearTimeout(this.#stateTimer)
		this.#stateTimer = setTimeout(
			() => {
				const rpc = this.#rpc
				if (!rpc) return
				this.#state(rpc).then(
					(s) => {
						this.#broadcast(s)
						if (touch && this.#current && existsSync(this.#current.file)) touchChat(this.#current.id, this.#current.file)
					},
					() => {}
				)
			},
			touch ? 0 : STATE_DEBOUNCE_MS
		)
	}

	async #state(rpc: OmpRpc) {
		const [s, levels, stats] = await Promise.all([
			rpc.request('get_state'),
			rpc.request('get_available_thinking_levels'),
			rpc.request('get_session_stats'),
		])
		this.#running = Boolean(s.isStreaming)
		this.#current = s.sessionId && s.sessionFile ? { id: s.sessionId, file: s.sessionFile } : undefined
		return {
			t: 'state',
			model: s.model ? { provider: s.model.provider, id: s.model.id, name: s.model.name ?? s.model.id } : null,
			thinking: s.thinkingLevel,
			levels: levels.levels,
			running: this.#running,
			queue: { steering: s.queuedMessages?.steering ?? [], followUp: s.queuedMessages?.followUp ?? [] },
			usage: { cost: stats.cost ?? 0, tokens: stats.tokens ?? {}, context: stats.contextUsage ?? null },
			// Anything beyond the canvas tools means a server from the user's own omp config got through mcpGuard.
			extraTools: ((s.dumpTools ?? []) as { name: string }[]).map((t) => t.name).filter((n) => !n.startsWith('mcp__canvas_')),
		}
	}

	// Long sessions: walk the history in small pages (a single reply with many screenshots would blow the frame limit).
	// Busy or stale pages fall back to the one-shot snapshot.
	async #history(rpc: OmpRpc): Promise<WireMessage[]> {
		const out: WireMessage[] = []
		const add = (messages: unknown[]) => {
			for (const m of messages) {
				const w = toWire(m)
				if (w) out.push(w)
			}
		}
		try {
			let cursor: string | undefined
			do {
				const page = await rpc.request('get_messages_page', { cursor, limit: PAGE }, 60_000)
				add(page.messages)
				cursor = page.nextCursor
			} while (cursor)
		} catch {
			out.length = 0
			add((await rpc.request('get_messages', {}, 60_000)).messages)
		}
		return out
	}

	async #sync(ws: WebSocket) {
		try {
			const rpc = await this.#ensure()
			send(ws, await this.#state(rpc))
			const messages = await this.#history(rpc)
			send(ws, { t: 'history', messages })
			// A session that existed before the index (or was reopened by --continue) still shows up in the history list.
			const first = messages.find((m) => m.role === 'user')?.blocks.find((b) => b.type === 'text')
			if (this.#current && first?.type === 'text' && existsSync(this.#current.file)) touchChat(this.#current.id, this.#current.file, clip(first.text.replace(/\s+/g, ' ').trim(), 60))
		} catch (e) {
			send(ws, { t: 'error', message: errorText(e) })
		}
	}

	async #resync(rpc: OmpRpc) {
		this.#broadcast(await this.#state(rpc))
		this.#broadcast({ t: 'history', messages: await this.#history(rpc) })
	}

	#restored(ws: WebSocket, items: { text?: string; images?: { mimeType: string; data: string }[] }[]) {
		if (items.length) send(ws, { t: 'restored', items: items.map((i) => ({ text: i.text ?? '', images: i.images?.map(({ mimeType, data }) => ({ mimeType, data })) })) })
	}

	async #handle(ws: WebSocket, raw: string) {
		try {
			const cmd = Cmd.parse(JSON.parse(raw))
			const rpc = await this.#ensure()
			switch (cmd.t) {
				case 'prompt': {
					const text = cmd.message.trim() || (cmd.images.length ? 'See the attached image.' : '')
					if (!text) break
					const files = cmd.images.flatMap((i) => saveChatImage(i.mimeType, i.data)?.file ?? [])
					const images = cmd.images.map((i) => ({ type: 'image', mimeType: i.mimeType, data: i.data }))
					// streamingBehavior makes this one command right whether the agent is idle or mid-run:
					// "steer" is delivered at the next opportunity inside the run, "followUp" after it finishes.
					await rpc.request('prompt', { message: text + attachmentNote(files), ...(images.length ? { images } : {}), streamingBehavior: cmd.mode }, 60_000)
					const s = await rpc.request('get_state')
					if (s.sessionId && s.sessionFile) {
						this.#current = { id: s.sessionId, file: s.sessionFile }
						touchChat(s.sessionId, s.sessionFile, clip(text.replace(/\s+/g, ' '), 60))
					}
					break
				}
				case 'abort': {
					// Stops the run and takes back anything still queued, so nothing the user typed is lost.
					const r = await rpc.request('abort_and_restore_queue')
					this.#restored(ws, [...(r.steering ?? []), ...(r.followUp ?? [])])
					break
				}
				case 'unqueue': {
					const r = await rpc.request('remove_queued_message', { message: cmd.message, queue: cmd.queue })
					if (r.removed) this.#restored(ws, [{ text: cmd.message, images: r.images }])
					break
				}
				case 'promote':
					await rpc.request('promote_queued_message', { message: cmd.message })
					break
				case 'new_chat':
					// The old session file stays on disk; only a new session id (and an empty context) starts.
					if (this.#running) await rpc.request('abort')
					await rpc.request('new_session')
					await this.#applyPrefs(rpc)
					await this.#resync(rpc)
					break
				case 'chats':
					send(ws, { t: 'chats', chats: this.#chatList() })
					break
				case 'open_chat': {
					const chat = findChat(cmd.id)
					if (!chat) throw new Error('That chat no longer exists')
					if (this.#running) await rpc.request('abort')
					const r = await rpc.request('switch_session', { sessionPath: chat.file }, 60_000)
					if (r?.cancelled) throw new Error('Could not open that chat')
					await this.#resync(rpc)
					break
				}
				case 'delete_chat':
					if (cmd.id === this.#current?.id) throw new Error('Open another chat before deleting this one')
					deleteChat(cmd.id)
					send(ws, { t: 'chats', chats: this.#chatList() })
					break
				case 'models': {
					const { models } = await rpc.request('get_available_models', {}, 90_000)
					send(ws, {
						t: 'models',
						models: (models as any[]).map((m) => ({ provider: m.provider, id: m.id, name: m.name ?? m.id, image: Boolean(m.input?.includes('image')) })),
					})
					break
				}
				case 'set_model':
					// Same session id and transcript; the provider prompt cache just starts cold for the new model.
					await rpc.request('set_model', { provider: cmd.provider, modelId: cmd.modelId }, 60_000)
					savePrefs({ model: { provider: cmd.provider, id: cmd.modelId } })
					this.#broadcast(await this.#state(rpc))
					break
				case 'set_thinking':
					await rpc.request('set_thinking_level', { level: cmd.level })
					savePrefs({ thinking: cmd.level })
					this.#broadcast(await this.#state(rpc))
					break
			}
		} catch (e) {
			send(ws, { t: 'error', message: e instanceof z.ZodError ? 'Bad chat command' : errorText(e) })
		}
	}

	#chatList() {
		return listChats().map((c) => ({ id: c.id, title: c.title || 'Untitled chat', updatedAt: c.updatedAt, current: c.id === this.#current?.id }))
	}
}
