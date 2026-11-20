import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OPENCODE_BIN } from '../config.ts'
import type { Detected, DriverFactory, ModelInfo } from './driver.ts'
import { JsonRpc } from './jsonrpc.ts'
import { detectCli, launch } from './proc.ts'
import { SessionDriver, type Turn } from './session.ts'
import { CANVAS_MCP_URL, SYSTEM_PROMPT, WORKSPACE } from './workspace.ts'
import { clip, type WireBlock } from './wire.ts'

export const detectOpencode = (): Promise<Detected> => detectCli('opencode', OPENCODE_BIN, 'OPENCODE_BIN')

const AGENT = 'canvas'
const SESSION = { cwd: WORKSPACE, mcpServers: [{ type: 'http', name: 'duet_canvas', url: CANVAS_MCP_URL, headers: [] }] }
const PROMPT_TIMEOUT = 12 * 3600_000

// The agent's own definition, read from the workspace as project config: our system prompt, and permissions that deny
// every tool except the canvas MCP server's (opencode names those duet_canvas_<tool>).
const CONFIG = {
	$schema: 'https://opencode.ai/config.json',
	default_agent: AGENT,
	agents: {
		[AGENT]: {
			mode: 'primary',
			description: 'Canvas agent',
			system: SYSTEM_PROMPT,
			permissions: [
				{ action: '*', resource: '*', effect: 'deny' },
				{ action: 'duet_canvas_*', resource: '*', effect: 'allow' },
			],
		},
	},
}

type ConfigOption = { id: string; currentValue: string; options: { value: string; name: string }[] }
type Run = { sessionId: string; blocks: WireBlock[]; assistant: string }

const wireTool = (title: string) => title.replace(/^duet_canvas_/, 'mcp__duet_canvas_')

// opencode runs as the user's own installed `opencode` binary over ACP (Agent Client Protocol, stdio), using the
// provider logins the user set up with `opencode auth login`; we never read them. One process serves every chat; each
// chat is an opencode session. Model and effort are the session's config options.
export class OpencodeDriver extends SessionDriver {
	protected readonly agent = 'opencode' as const
	#rpc!: JsonRpc
	#config: ConfigOption[] = []
	/** A session made at startup only to learn the models; the first chat takes it over. */
	#spare: string | undefined
	#loaded: string | undefined
	#run: Run | undefined

	async start() {
		mkdirSync(WORKSPACE, { recursive: true })
		writeFileSync(join(WORKSPACE, 'opencode.jsonc'), JSON.stringify(CONFIG))
		const child = launch(OPENCODE_BIN, ['acp'], { cwd: WORKSPACE })
		this.#rpc = new JsonRpc(child, 'opencode', {
			onNotification: (method, params) => method === 'session/update' && this.#update(params),
			onRequest: (method, params) => this.#serve(method, params),
			onClose: (reason) => {
				this.closed = true
				this.ev.closed(reason)
			},
		})
		await this.#rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'duet_canvas', version: '0.1.0' } })
		const s = await this.#rpc.request('session/new', SESSION)
		this.#spare = s.sessionId
		this.#config = s.configOptions ?? []
		await this.#configure(s.sessionId)
		this.#refreshModel()
	}

	close() {
		this.closed = true
		// The unused startup session would otherwise stay in the user's opencode history.
		if (this.#spare) this.#drop(this.#spare, () => this.#rpc.close())
		else this.#rpc?.close()
	}

	#drop(sessionId: string, then?: () => void) {
		this.#rpc.request('session/delete', { sessionId }, 2000).catch(() => {}).finally(then)
	}

	// Only the canvas tools may run; anything else the agent reaches for is refused.
	#serve(method: string, p: { toolCall?: { title?: string }; options?: { optionId: string; kind: string }[] }) {
		if (method !== 'session/request_permission') throw new Error(`The canvas chat cannot handle "${method}"`)
		const allow = String(p.toolCall?.title ?? '').startsWith('duet_canvas_') ? p.options?.find((o) => o.kind === 'allow_once') : undefined
		const pick = allow ?? p.options?.find((o) => o.kind.startsWith('reject'))
		return { outcome: pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' } }
	}

	async #set(sessionId: string, configId: string, value: string) {
		const r = await this.#rpc.request('session/set_config_option', { sessionId, configId, value })
		this.#config = r.configOptions ?? this.#config
	}

	/** Puts the session on our agent and on the model and effort the user chose. A model that is gone is skipped. */
	async #configure(sessionId: string) {
		const option = (id: string) => this.#config.find((c) => c.id === id)
		try {
			if (option('mode')?.currentValue !== AGENT) await this.#set(sessionId, 'mode', AGENT)
			const model = this.model?.id
			if (model && option('model')?.options.some((o) => o.value === model) && option('model')?.currentValue !== model) await this.#set(sessionId, 'model', model)
			const effort = this.thinking && this.thinking !== 'default' ? this.thinking : 'default'
			const e = option('effort')
			if (e && e.options.some((o) => o.value === effort) && e.currentValue !== effort) await this.#set(sessionId, 'effort', effort)
		} catch {
			// keep whatever opencode chose
		}
	}

	#refreshModel() {
		const m = this.#config.find((c) => c.id === 'model')
		if (!m) return
		const current = m.options.find((o) => o.value === m.currentValue)
		if (current) this.model = { provider: current.value.split('/')[0]!, id: current.value, name: this.#name(current) }
	}

	#name = (o: { value: string; name: string }) => o.name.replace(`${o.value.split('/')[0]}/`, '')

	levels() {
		const e = this.#config.find((c) => c.id === 'effort')
		return e ? ['default', ...e.options.map((o) => o.value).filter((v) => v !== 'default')] : ['default']
	}

	protected async listModels(): Promise<ModelInfo[]> {
		const m = this.#config.find((c) => c.id === 'model')
		return (m?.options ?? []).map((o) => ({ provider: o.value.split('/')[0]!, id: o.value, name: this.#name(o), image: true }))
	}

	async setModel(provider: string, id: string) {
		await super.setModel(provider, id)
		// Effort options belong to the model, so the session's list is refreshed when the model changes.
		const session = this.native ?? this.#spare
		if (session) await this.#configure(session)
		this.ev.changed(false)
	}

	async setThinking(level: string) {
		await super.setThinking(level)
		const session = this.native ?? this.#spare
		if (session) await this.#configure(session)
	}

	protected interrupt() {
		if (this.#run) this.#rpc.notify('session/cancel', { sessionId: this.#run.sessionId })
	}

	async #session(): Promise<string> {
		if (!this.native && this.#spare) {
			this.native = this.#spare
			this.#spare = undefined
		} else if (!this.native) {
			const s = await this.#rpc.request('session/new', SESSION)
			this.#config = s.configOptions ?? []
			this.native = s.sessionId
		} else if (this.native !== this.#loaded) {
			const r = await this.#rpc.request('session/resume', { sessionId: this.native, ...SESSION })
			this.#config = r?.configOptions ?? this.#config
			if (this.#spare) (this.#drop(this.#spare), (this.#spare = undefined))
		}
		this.#loaded = this.native
		await this.#configure(this.native!)
		return this.native!
	}

	protected async runTurn(turn: Turn) {
		const sessionId = await this.#session()
		const run: Run = { sessionId, blocks: [], assistant: `a:${this.nextId()}` }
		this.#run = run
		try {
			const prompt = [{ type: 'text', text: turn.text }, ...turn.images.map((i) => ({ type: 'image', mimeType: i.mimeType, data: i.data }))]
			const r = await this.#rpc.request('session/prompt', { sessionId, prompt }, PROMPT_TIMEOUT)
			const u = r?.usage
			if (u) {
				const t = this.usage.tokens
				t.input = (t.input ?? 0) + (u.inputTokens ?? 0)
				t.output = (t.output ?? 0) + (u.outputTokens ?? 0)
				t.cacheRead = (t.cacheRead ?? 0) + (u.cachedReadTokens ?? 0)
				t.cacheWrite = (t.cacheWrite ?? 0) + (u.cachedWriteTokens ?? 0)
				this.ev.changed(false)
			}
		} finally {
			if (this.#run === run) this.#run = undefined
		}
	}

	#emit(run: Run) {
		this.put(run.assistant, { role: 'assistant', blocks: [...run.blocks] }, false)
	}

	#update(p: { sessionId: string; update: Record<string, any> }) {
		const u = p.update
		if (u.sessionUpdate === 'usage_update') {
			if (this.#run?.sessionId === p.sessionId) {
				this.usage.cost = u.cost?.amount ?? this.usage.cost
				if (u.size) this.usage.context = { tokens: u.used ?? 0, contextWindow: u.size, percent: ((u.used ?? 0) / u.size) * 100 }
				this.ev.changed(false)
			}
			return
		}
		const run = this.#run
		if (!run || run.sessionId !== p.sessionId) return
		switch (u.sessionUpdate) {
			case 'agent_message_chunk':
			case 'agent_thought_chunk': {
				const type = u.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thinking'
				const text = String(u.content?.text ?? '')
				const last = run.blocks.at(-1)
				if (last?.type === type) last.text += text
				else run.blocks.push({ type, text })
				this.#emit(run)
				break
			}
			case 'tool_call':
				if (run.blocks.some((x) => x.type === 'tool' && x.id === u.toolCallId)) break
				run.blocks.push({ type: 'tool', id: u.toolCallId, name: wireTool(String(u.title ?? u.name ?? 'tool')), args: clip(JSON.stringify(u.rawInput ?? {}), 400) })
				this.#emit(run)
				break
			case 'tool_call_update': {
				const b = run.blocks.find((x) => x.type === 'tool' && x.id === u.toolCallId)
				if (b?.type === 'tool' && u.rawInput && Object.keys(u.rawInput).length) b.args = clip(JSON.stringify(u.rawInput), 400)
				if (u.status !== 'completed' && u.status !== 'failed') {
					if (b) this.#emit(run)
					break
				}
				const content: { type: string; content?: { type: string; text?: string } }[] = u.content ?? []
				const blocks = content.flatMap((c): WireBlock[] => (c.type === 'content' && c.content?.type === 'text' ? [{ type: 'text', text: clip(String(c.content.text ?? ''), 20_000) }] : c.content?.type === 'image' ? [{ type: 'image' }] : []))
				this.put(`t:${u.toolCallId}`, { role: 'tool', blocks, toolCallId: u.toolCallId, isError: u.status === 'failed' }, true)
				break
			}
		}
	}
}

export const opencodeDriver: DriverFactory = (events, prefs) => new OpencodeDriver(events, prefs)
