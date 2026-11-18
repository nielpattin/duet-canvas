import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OMP_BIN } from '../config.ts'
import { SESSIONS } from './chats.ts'
import type { ChatDriver, Detected, DriverEvents, DriverFactory, DriverState, ModelInfo, PrefsStore, PromptInput, Restored } from './driver.ts'
import { userMcpServerNames } from './mcpGuard.ts'
import { detectCli } from './proc.ts'
import { OmpRpc, type Frame } from './rpc.ts'
import { attachmentNote, toWire, type WireMessage } from './wire.ts'
import { CANVAS_MCP_URL, SYSTEM_PROMPT, WORKSPACE } from './workspace.ts'

export const detectOmp = (): Promise<Detected> => detectCli('omp', OMP_BIN, 'OMP_BIN')

const CONFIG = join(WORKSPACE, 'chat.yml')

// `--no-tools` drops every built-in (bash, edit, eval, fs, LSP...) and `tools.xdev: false` keeps the MCP tools
// top-level, so the model needs no read/write to reach them.
// Extensions, skills, rules and context files are off so the user's coding setup does not leak into this chat.
// Checked with get_state.dumpTools: exactly the 14 canvas tools (see mcpGuard.ts for the user's own MCP servers).
const OMP_ARGS = [
	'--system-prompt', SYSTEM_PROMPT,
	'--mode', 'rpc', '--no-ui', '--yolo', '--continue',
	'--no-tools', '--no-extensions', '--no-skills', '--no-rules', '--no-context-files', '--no-lsp',
	'--session-dir', SESSIONS, '--config', CONFIG,
]

const EVENTS = ['agent_start', 'agent_end', 'message_start', 'message_update', 'message_end', 'model_changed', 'thinking_level_changed', 'queue_update']

const PAGE = 24 // messages per history page: small enough that pages full of screenshots stay under the frame limit

function prepareWorkspace() {
	mkdirSync(join(WORKSPACE, '.omp'), { recursive: true })
	mkdirSync(SESSIONS, { recursive: true })
	const servers: Record<string, unknown> = {}
	for (const name of userMcpServerNames()) servers[name] = { type: 'http', url: 'http://127.0.0.1:9/disabled', enabled: false }
	servers.canvas = { type: 'http', url: CANVAS_MCP_URL, enabled: true }
	writeFileSync(join(WORKSPACE, '.omp', 'mcp.json'), JSON.stringify({ mcpServers: servers }))
	writeFileSync(CONFIG, 'tools:\n  xdev: false\n')
}

// One `omp --mode rpc` process (started on first use, kept alive). omp keeps the sessions, so this is a thin translation.
export class OmpDriver implements ChatDriver {
	closed = false
	#rpc!: OmpRpc
	#running = false

	#ev: DriverEvents
	#prefs: PrefsStore

	constructor(ev: DriverEvents, prefs: PrefsStore) {
		this.#ev = ev
		this.#prefs = prefs
	}

	async start() {
		prepareWorkspace()
		this.#rpc = new OmpRpc(OMP_BIN, OMP_ARGS, WORKSPACE, (f) => this.#onFrame(f), (reason) => {
			this.closed = true
			this.#running = false
			this.#ev.closed(reason)
		})
		await this.#rpc.request('set_event_filter', { events: EVENTS, messageUpdates: 'full' })
		await this.#applyPrefs()
	}

	close() {
		this.#rpc.close()
	}

	// Best effort: a model that is gone or has lost its credentials must not stop the chat from starting.
	async #applyPrefs() {
		const { model, thinking } = this.#prefs.get()
		try {
			const s = await this.#rpc.request('get_state')
			if (model && !(s.model?.provider === model.provider && s.model?.id === model.id)) {
				await this.#rpc.request('set_model', { provider: model.provider, modelId: model.id }, 60_000)
			}
			if (thinking && thinking !== (await this.#rpc.request('get_state')).thinkingLevel) await this.#rpc.request('set_thinking_level', { level: thinking })
		} catch {
			// keep whatever omp chose
		}
	}

	#onFrame(f: Frame) {
		switch (f.type) {
			case 'agent_start':
				this.#running = true
				this.#ev.runStart()
				break
			case 'agent_end':
				this.#running = false
				this.#ev.runEnd()
				break
			case 'message_start':
			case 'message_end':
			case 'message_update': {
				// 'full' updates carry the whole message so far, so a tab that joins mid-stream needs no replay.
				const message = toWire(f.type === 'message_update' ? f.assistantMessageEvent?.partial : f.message)
				if (message) this.#ev.message(String(f.messageId), message, f.type === 'message_end')
				// Keep the spend counter moving during long runs without a stats request per token.
				if (f.type === 'message_end' && f.message?.role === 'assistant') this.#ev.changed(false)
				break
			}
			case 'queue_update':
				this.#ev.queue(f.steering ?? [], f.followUp ?? [])
				break
			case 'prompt_result':
				if (f.status === 'error') this.#ev.error(f.error?.message ?? 'The request failed')
				break
			case 'model_changed':
			case 'thinking_level_changed':
				this.#ev.changed(false)
				break
		}
	}

	async state(): Promise<DriverState> {
		const [s, levels, stats] = await Promise.all([
			this.#rpc.request('get_state'),
			this.#rpc.request('get_available_thinking_levels'),
			this.#rpc.request('get_session_stats'),
		])
		this.#running = Boolean(s.isStreaming)
		return {
			model: s.model ? { provider: s.model.provider, id: s.model.id, name: s.model.name ?? s.model.id } : null,
			thinking: s.thinkingLevel,
			levels: levels.levels,
			running: this.#running,
			queue: { steering: s.queuedMessages?.steering ?? [], followUp: s.queuedMessages?.followUp ?? [] },
			usage: { cost: stats.cost ?? 0, tokens: stats.tokens ?? {}, context: stats.contextUsage ?? null },
			// Anything beyond the canvas tools means a server from the user's own omp config got through mcpGuard.
			extraTools: ((s.dumpTools ?? []) as { name: string }[]).map((t) => t.name).filter((n) => !n.startsWith('mcp__canvas_')),
			current: s.sessionId && s.sessionFile ? { id: s.sessionId, file: s.sessionFile } : undefined,
		}
	}

	// Long sessions: walk the history in small pages (a single reply with many screenshots would blow the frame limit).
	// Busy or stale pages fall back to the one-shot snapshot.
	async history(): Promise<WireMessage[]> {
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
				const page = await this.#rpc.request('get_messages_page', { cursor, limit: PAGE }, 60_000)
				add(page.messages)
				cursor = page.nextCursor
			} while (cursor)
		} catch {
			out.length = 0
			add((await this.#rpc.request('get_messages', {}, 60_000)).messages)
		}
		return out
	}

	async prompt({ text, files, images, mode }: PromptInput) {
		const wireImages = images.map((i) => ({ type: 'image', mimeType: i.mimeType, data: i.data }))
		// streamingBehavior makes this one command right whether the agent is idle or mid-run:
		// "steer" is delivered at the next opportunity inside the run, "followUp" after it finishes.
		await this.#rpc.request('prompt', { message: text + attachmentNote(files), ...(wireImages.length ? { images: wireImages } : {}), streamingBehavior: mode }, 60_000)
		const s = await this.#rpc.request('get_state')
		return s.sessionId && s.sessionFile ? { id: s.sessionId as string, file: s.sessionFile as string } : undefined
	}

	async abort(): Promise<Restored[]> {
		// Stops the run and takes back anything still queued, so nothing the user typed is lost.
		const r = await this.#rpc.request('abort_and_restore_queue')
		return [...(r.steering ?? []), ...(r.followUp ?? [])]
	}

	async unqueue(message: string, queue: 'steering' | 'followUp') {
		const r = await this.#rpc.request('remove_queued_message', { message, queue })
		return r.removed ? { text: message, images: r.images } : undefined
	}

	async promote(message: string) {
		await this.#rpc.request('promote_queued_message', { message })
	}

	async newChat() {
		// The old session file stays on disk; only a new session id (and an empty context) starts.
		if (this.#running) await this.#rpc.request('abort')
		await this.#rpc.request('new_session')
		await this.#applyPrefs()
	}

	async openChat(file: string) {
		if (this.#running) await this.#rpc.request('abort')
		const r = await this.#rpc.request('switch_session', { sessionPath: file }, 60_000)
		if (r?.cancelled) throw new Error('Could not open that chat')
	}

	async models(): Promise<ModelInfo[]> {
		const { models } = await this.#rpc.request('get_available_models', {}, 90_000)
		return (models as Frame[]).map((m) => ({ provider: m.provider, id: m.id, name: m.name ?? m.id, image: Boolean(m.input?.includes('image')) }))
	}

	async setModel(provider: string, id: string) {
		// Same session id and transcript; the provider prompt cache just starts cold for the new model.
		await this.#rpc.request('set_model', { provider, modelId: id }, 60_000)
		this.#prefs.set({ model: { provider, id } })
	}

	async setThinking(level: string) {
		await this.#rpc.request('set_thinking_level', { level })
		this.#prefs.set({ thinking: level })
	}
}

export const ompDriver: DriverFactory = (events, prefs) => new OmpDriver(events, prefs)
