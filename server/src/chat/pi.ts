import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PI_BIN } from '../config.ts'
import { SESSIONS } from './chats.ts'
import type { ChatDriver, Detected, DriverEvents, DriverFactory, DriverState, ModelInfo, PrefsStore, PromptInput, Restored } from './driver.ts'
import { piAgentDir, userMcpServerNames } from './mcpGuard.ts'
import { detectCli, launch } from './proc.ts'
import { JsonlRpc, type Frame } from './rpc.ts'
import { attachmentNote, clip, toWire, type WireBlock, type WireMessage } from './wire.ts'
import { CANVAS_MCP_URL, SYSTEM_PROMPT, WORKSPACE } from './workspace.ts'

export const detectPi = (): Promise<Detected> => detectCli('pi', PI_BIN, 'PI_BIN')

const DIR = join(WORKSPACE, 'pi')
const PI_SESSIONS = join(SESSIONS, 'pi') // apart from omp's: `--continue` picks the newest file in the dir
const PROMPT_FILE = join(DIR, 'system-prompt.md')

// pi (earendil-works/pi) is omp's upstream: the same JSONL RPC, with a few differences handled below. MCP is a built-in
// extension, so extensions are off except that one. Skills, prompt templates, context files and themes are off, and the
// agent only gets the canvas tools. `--approve` trusts the project files we write in DIR (the MCP config and an empty
// APPEND_SYSTEM.md that shadows the user's own, which pi would otherwise append to our prompt).
const PI_ARGS = [
	'--mode', 'rpc', '--continue', '--approve',
	'--no-builtin-tools', '--no-extensions', '-e', 'builtin:mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes',
	'--system-prompt', PROMPT_FILE, '--session-dir', PI_SESSIONS,
]

function prepareWorkspace() {
	mkdirSync(join(DIR, '.pi'), { recursive: true })
	mkdirSync(PI_SESSIONS, { recursive: true })
	// A project entry that only says `enabled: false` switches off a user-level server of the same name.
	const servers: Record<string, unknown> = {}
	for (const name of userMcpServerNames(piAgentDir())) servers[name] = { enabled: false }
	servers.duet_canvas = { url: CANVAS_MCP_URL, exposure: 'direct' }
	writeFileSync(join(DIR, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: servers }))
	writeFileSync(join(DIR, '.pi', 'APPEND_SYSTEM.md'), '')
	writeFileSync(PROMPT_FILE, SYSTEM_PROMPT)
}

// pi names MCP tools mcp__<server>__<tool>; the browser expects mcp__<server>_<tool> (see workspace.ts).
const rename = (w: WireMessage): WireMessage => ({ ...w, blocks: w.blocks.map((b) => (b.type === 'tool' ? { ...b, name: b.name.replace(/^(mcp__[^_]+)__/, '$1_') } : b)) })
const wire = (m: unknown) => {
	const w = toWire(m)
	return w && rename(w)
}

type Live = { id: string; blocks: (WireBlock | undefined)[]; json: Map<number, string> }

// One `pi --mode rpc` process (started on first use, kept alive). pi keeps the sessions, so this is a thin translation.
// What pi lacks next to omp: streamed messages are deltas (rebuilt here), the queue cannot be read or edited in place
// (kept from queue_update; edits clear it and queue the rest again), and images in a restored message are lost.
export class PiDriver implements ChatDriver {
	closed = false
	#rpc!: JsonlRpc
	#ev: DriverEvents
	#prefs: PrefsStore
	#running = false
	#queue = { steering: [] as string[], followUp: [] as string[] }
	#live: Live | undefined
	#seq = 0

	constructor(ev: DriverEvents, prefs: PrefsStore) {
		this.#ev = ev
		this.#prefs = prefs
	}

	async start() {
		prepareWorkspace()
		this.#rpc = new JsonlRpc(launch(PI_BIN, PI_ARGS, { cwd: DIR }), 'pi', (f) => this.#onFrame(f), (reason) => {
			this.closed = true
			this.#running = false
			this.#ev.closed(reason)
		})
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
			if (model && !(s.model?.provider === model.provider && s.model?.id === model.id)) await this.#rpc.request('set_model', { provider: model.provider, modelId: model.id }, 60_000)
			if (thinking && thinking !== (await this.#rpc.request('get_state')).thinkingLevel) await this.#rpc.request('set_thinking_level', { level: thinking })
		} catch {
			// keep whatever pi chose
		}
	}

	#onFrame(f: Frame) {
		switch (f.type) {
			case 'agent_start':
				// Retries and queued messages start further low-level runs inside one session-level run.
				if (!this.#running) {
					this.#running = true
					this.#ev.runStart()
				}
				break
			case 'agent_settled':
				this.#running = false
				this.#ev.runEnd()
				break
			case 'message_start':
				if (f.message?.role === 'assistant') this.#live = { id: `a${++this.#seq}`, blocks: [], json: new Map() }
				break
			case 'message_update':
				this.#delta(f.assistantMessageEvent)
				break
			case 'message_end': {
				const w = wire(f.message)
				if (!w) break
				const live = f.message?.role === 'assistant' ? this.#live : undefined
				this.#ev.message(live?.id ?? `m${++this.#seq}`, w, true)
				if (live) {
					this.#live = undefined
					this.#ev.changed(false) // keeps the spend counter moving during long runs
				}
				break
			}
			case 'queue_update':
				this.#queue = { steering: f.steering ?? [], followUp: f.followUp ?? [] }
				this.#ev.queue(this.#queue.steering, this.#queue.followUp)
				break
			case 'thinking_level_changed':
				this.#ev.changed(false)
				break
		}
	}

	// Rebuilds the message so far from deltas, so a tab that joins mid-stream sees the whole message.
	#delta(e: Frame | undefined) {
		const live = this.#live
		if (!live || !e) return
		const i: number = e.contentIndex
		const b = live.blocks[i]
		switch (e.type) {
			case 'text_start':
				live.blocks[i] = { type: 'text', text: '' }
				break
			case 'thinking_start':
				live.blocks[i] = { type: 'thinking', text: '' }
				break
			case 'toolcall_start':
				live.blocks[i] = { type: 'tool', id: e.id, name: String(e.toolName).replace(/^(mcp__[^_]+)__/, '$1_'), args: '' }
				live.json.set(i, '')
				break
			case 'text_delta':
			case 'thinking_delta':
				if (b?.type === 'text' || b?.type === 'thinking') b.text += e.delta
				break
			case 'text_end':
			case 'thinking_end':
				if (b?.type === 'text' || b?.type === 'thinking') b.text = e.content
				break
			case 'toolcall_delta':
				if (b?.type === 'tool') b.args = clip(live.json.set(i, (live.json.get(i) ?? '') + e.delta).get(i)!, 400)
				break
			case 'toolcall_end':
				if (b?.type === 'tool') b.args = clip(JSON.stringify(e.toolCall?.arguments ?? {}), 400)
				break
			default:
				return
		}
		this.#ev.message(live.id, { role: 'assistant', blocks: live.blocks.filter((x): x is WireBlock => Boolean(x)) }, false)
	}

	async state(): Promise<DriverState> {
		const [s, levels, stats] = await Promise.all([
			this.#rpc.request('get_state'),
			this.#rpc.request('get_available_thinking_levels'),
			this.#rpc.request('get_session_stats'),
		])
		return {
			model: s.model ? { provider: s.model.provider, id: s.model.id, name: s.model.name ?? s.model.id } : null,
			thinking: s.thinkingLevel,
			levels: levels.levels,
			running: this.#running,
			queue: this.#queue,
			usage: { cost: stats.cost ?? 0, tokens: stats.tokens ?? {}, context: stats.contextUsage?.tokens == null ? null : stats.contextUsage },
			extraTools: [], // pi cannot list its tools over RPC; the user's own MCP servers are switched off in prepareWorkspace
			current: s.sessionId && s.sessionFile ? { id: s.sessionId, file: s.sessionFile } : undefined,
		}
	}

	async history(): Promise<WireMessage[]> {
		const { messages } = await this.#rpc.request('get_messages', {}, 60_000)
		return (messages as unknown[]).flatMap((m) => wire(m) ?? [])
	}

	async prompt({ text, files, images, mode }: PromptInput) {
		const wireImages = images.map((i) => ({ type: 'image', mimeType: i.mimeType, data: i.data }))
		// streamingBehavior makes this one command right whether the agent is idle or mid-run.
		await this.#rpc.request('prompt', { message: text + attachmentNote(files), ...(wireImages.length ? { images: wireImages } : {}), streamingBehavior: mode }, 60_000)
		const s = await this.#rpc.request('get_state')
		return s.sessionId && s.sessionFile ? { id: s.sessionId as string, file: s.sessionFile as string } : undefined
	}

	async abort(): Promise<Restored[]> {
		// Clear the queue first: abort would otherwise carry on with the queued messages.
		const q = await this.#rpc.request('clear_queue')
		await this.#rpc.request('abort')
		return [...(q.steering ?? []), ...(q.followUp ?? [])].map((text: string) => ({ text }))
	}

	// pi cannot remove one queued message, so the queue is cleared and the others are queued again in order.
	async #requeue(keep: { steering: string[]; followUp: string[] }) {
		await this.#rpc.request('clear_queue')
		for (const message of keep.steering) await this.#rpc.request('steer', { message })
		for (const message of keep.followUp) await this.#rpc.request('follow_up', { message })
	}

	async unqueue(message: string, queue: 'steering' | 'followUp') {
		const list = this.#queue[queue]
		const i = list.indexOf(message)
		if (i < 0) return undefined
		await this.#requeue({ ...this.#queue, [queue]: list.filter((_, n) => n !== i) })
		return { text: message }
	}

	async promote(message: string) {
		const i = this.#queue.followUp.indexOf(message)
		if (i < 0) return
		await this.#requeue({ steering: [...this.#queue.steering, message], followUp: this.#queue.followUp.filter((_, n) => n !== i) })
	}

	async newChat() {
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
		await this.#rpc.request('set_model', { provider, modelId: id }, 60_000)
		this.#prefs.set({ model: { provider, id } })
	}

	async setThinking(level: string) {
		await this.#rpc.request('set_thinking_level', { level })
		this.#prefs.set({ thinking: level })
	}
}

export const piDriver: DriverFactory = (events, prefs) => new PiDriver(events, prefs)
