import { mkdirSync } from 'node:fs'
import { CODEX_BIN } from '../config.ts'
import type { Detected, DriverFactory, ModelInfo } from './driver.ts'
import { JsonRpc } from './jsonrpc.ts'
import { detectCli, launch } from './proc.ts'
import { SessionDriver, type Turn } from './session.ts'
import { CANVAS_MCP_URL, SYSTEM_PROMPT, toolName, WORKSPACE } from './workspace.ts'
import { clip, saveChatImage, type WireBlock } from './wire.ts'

export const detectCodex = (): Promise<Detected> => detectCli('Codex', CODEX_BIN, 'CODEX_BIN')

// Per thread. The canvas MCP server is auto-approved (Codex would otherwise ask before every call, and a chat has
// nobody to ask); web search and the optional app features are off. Codex's own shell and file tools cannot be
// removed, so the sandbox is read-only and nothing is ever approved: the agent can look, not change.
const THREAD = {
	cwd: WORKSPACE,
	baseInstructions: SYSTEM_PROMPT,
	sandbox: 'read-only',
	approvalPolicy: 'never',
	config: {
		'mcp_servers.duet_canvas': { url: CANVAS_MCP_URL, default_tools_approval_mode: 'approve' },
		web_search: 'disabled',
		'features.apps': false,
		'features.browser_use': false,
		'features.computer_use': false,
		'features.plugins': false,
		'features.goals': false,
		'features.image_generation': false,
	},
}

type CodexModel = { id: string; model?: string; displayName?: string; hidden?: boolean; isDefault?: boolean; inputModalities?: string[]; supportedReasoningEfforts?: { reasoningEffort: string }[] }
type Item = { type: string; id: string; [k: string]: any }
type Running = {
	threadId: string
	turnId?: string
	interrupt: boolean
	/** Blocks of this turn's assistant message, in the order the items started. */
	blocks: Map<string, WireBlock>
	assistant: string
	done: PromiseWithResolvers<void>
	error?: string
}

// Codex runs as the user's own installed `codex` binary through its app-server (JSON-RPC over stdio), signed in by the
// user (`codex login`); we never read its credentials. One process serves every chat; each chat is a Codex thread.
export class CodexDriver extends SessionDriver {
	protected readonly agent = 'codex' as const
	#rpc!: JsonRpc
	#loaded: string | undefined
	#models: CodexModel[] = []
	#run: Running | undefined
	/** Startup state of the canvas MCP server per thread; a turn that starts before it is ready runs without canvas tools. */
	#canvas = new Map<string, { status: string; error?: string }>()
	#canvasReady = new Map<string, () => void>()

	async start() {
		mkdirSync(WORKSPACE, { recursive: true })
		const child = launch(CODEX_BIN, ['app-server'], { cwd: WORKSPACE })
		this.#rpc = new JsonRpc(child, 'codex', {
			onNotification: (method, params) => this.#notify(method, params),
			// Approvals and questions: there is nobody to answer in a chat, so the agent is told no.
			onRequest: (method) => {
				throw new Error(`The canvas chat cannot handle "${method}"`)
			},
			onClose: (reason) => {
				this.closed = true
				this.#run?.done.reject(new Error(reason))
				this.ev.closed(reason)
			},
		})
		await this.#rpc.request('initialize', { clientInfo: { name: 'duet_canvas', title: 'duet_canvas', version: '0.1.0' } })
		this.#rpc.notify('initialized')
		await this.#loadModels()
	}

	close() {
		this.closed = true
		this.#rpc?.close()
	}

	async #loadModels() {
		const all: CodexModel[] = []
		let cursor: string | null | undefined
		do {
			const page = await this.#rpc.request('model/list', cursor ? { cursor } : {})
			all.push(...page.data)
			cursor = page.nextCursor
		} while (cursor)
		this.#models = all.filter((m) => !m.hidden)
		const defaultModel = this.#models.find((m) => m.isDefault) ?? this.#models[0]
		if (!this.model && defaultModel) this.model = { provider: 'openai', id: defaultModel.model ?? defaultModel.id, name: defaultModel.displayName ?? defaultModel.id }
		else if (this.model) this.model.name = this.#models.find((m) => (m.model ?? m.id) === this.model!.id)?.displayName ?? this.model.name
	}

	levels() {
		const m = this.#models.find((x) => (x.model ?? x.id) === this.model?.id)
		return ['default', ...(m?.supportedReasoningEfforts?.map((e) => e.reasoningEffort) ?? [])]
	}

	protected async listModels(): Promise<ModelInfo[]> {
		return this.#models.map((m) => ({ provider: 'openai', id: m.model ?? m.id, name: m.displayName ?? m.id, image: m.inputModalities?.includes('image') ?? true }))
	}

	protected interrupt() {
		const run = this.#run
		if (!run) return
		run.interrupt = true
		if (run.turnId) void this.#rpc.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }).catch(() => {})
		// A turn that ignores the interrupt (or a dead process) must not hold the chat forever.
		setTimeout(() => run.done.resolve(), 10_000).unref()
	}

	protected async steer(turn: Turn) {
		const run = this.#run
		if (!run?.turnId) return false
		try {
			await this.#rpc.request('turn/steer', { threadId: run.threadId, expectedTurnId: run.turnId, input: this.#input(turn) })
			return true
		} catch {
			return false // the turn ended in the meantime; the message goes to the queue
		}
	}

	#input(turn: Turn) {
		const images = turn.images.flatMap((i) => saveChatImage(i.mimeType, i.data)?.file ?? [])
		return [{ type: 'text', text: turn.text, text_elements: [] }, ...images.map((path) => ({ type: 'localImage', path }))]
	}

	async #openThread(): Promise<string> {
		const model = this.model?.id
		if (this.native) {
			await this.#rpc.request('thread/resume', { threadId: this.native, ...THREAD, ...(model ? { model } : {}) })
		} else {
			const r = await this.#rpc.request('thread/start', { ...THREAD, ...(model ? { model } : {}), ephemeral: false })
			this.native = r.thread.id as string
		}
		this.#loaded = this.native
		await this.#waitCanvas(this.native!)
		return this.native!
	}

	async #waitCanvas(threadId: string) {
		const settled = () => (this.#canvas.get(threadId)?.status ?? 'starting') !== 'starting'
		if (!settled()) {
			const { promise, resolve } = Promise.withResolvers<void>()
			this.#canvasReady.set(threadId, resolve)
			const timer = setTimeout(resolve, 30_000)
			await promise
			clearTimeout(timer)
			this.#canvasReady.delete(threadId)
		}
		const c = this.#canvas.get(threadId)
		if (c?.status !== 'ready') this.ev.error(`The canvas tools did not start in Codex${c?.error ? `: ${c.error}` : ''}`)
	}

	protected async runTurn(turn: Turn) {
		if (!this.native || this.native !== this.#loaded) await this.#openThread()
		const run: Running = { threadId: this.native!, interrupt: false, blocks: new Map(), assistant: `a:${this.nextId()}`, done: Promise.withResolvers<void>() }
		this.#run = run
		try {
			const effort = this.thinking && this.thinking !== 'default' && this.levels().includes(this.thinking) ? this.thinking : undefined
			const r = await this.#rpc.request('turn/start', { threadId: run.threadId, input: this.#input(turn), ...(this.model ? { model: this.model.id } : {}), ...(effort ? { effort } : {}) })
			run.turnId ??= r.turn.id
			if (run.interrupt) void this.#rpc.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }).catch(() => {})
			await run.done.promise
			if (run.error && !run.interrupt) throw new Error(run.error)
		} finally {
			if (this.#run === run) this.#run = undefined
		}
	}

	#emit(run: Running, done: boolean) {
		this.put(run.assistant, { role: 'assistant', blocks: [...run.blocks.values()] }, done)
	}

	#notify(method: string, p: Record<string, any>) {
		if (method === 'mcpServer/startupStatus/updated' && p.name === 'duet_canvas') {
			this.#canvas.set(p.threadId, { status: p.status, error: p.error ?? undefined })
			if (p.status !== 'starting') this.#canvasReady.get(p.threadId)?.()
			return
		}
		const run = this.#run
		if (method === 'thread/tokenUsage/updated') {
			if (run && p.threadId === run.threadId) this.#usage(p.tokenUsage)
			return
		}
		if (!run || p.threadId !== run.threadId) return
		switch (method) {
			case 'turn/started':
				run.turnId ??= p.turn.id
				break
			case 'item/started':
			case 'item/completed': {
				const item: Item = p.item
				const done = method === 'item/completed'
				switch (item.type) {
					case 'agentMessage':
						run.blocks.set(item.id, { type: 'text', text: item.text ?? '' })
						this.#emit(run, false)
						break
					case 'reasoning': {
						const text = [...(item.summary ?? []), ...(item.content ?? [])].join('\n\n')
						run.blocks.set(item.id, { type: 'thinking', text })
						if (text || !done) this.#emit(run, false)
						break
					}
					case 'mcpToolCall':
						run.blocks.set(item.id, { type: 'tool', id: item.id, name: toolName(item.server, item.tool), args: clip(JSON.stringify(item.arguments ?? {}), 400) })
						this.#emit(run, false)
						if (done) {
							const content: Record<string, any>[] = item.result?.content ?? []
							const blocks = content.flatMap((c): WireBlock[] => (c.type === 'text' ? [{ type: 'text', text: clip(String(c.text ?? ''), 20_000) }] : c.type === 'image' ? [{ type: 'image' }] : []))
							if (item.error) blocks.push({ type: 'text', text: String(item.error.message ?? 'The tool call failed') })
							this.put(`t:${item.id}`, { role: 'tool', blocks, toolCallId: item.id, isError: item.status === 'failed' }, true)
						}
						break
					case 'commandExecution':
					case 'fileChange':
						// Not part of the canvas tool set; shown so a run that used them is not mysterious.
						run.blocks.set(item.id, { type: 'tool', id: item.id, name: item.type, args: clip(String(item.command ?? ''), 400) })
						this.#emit(run, false)
						if (done) this.put(`t:${item.id}`, { role: 'tool', blocks: [{ type: 'text', text: clip(String(item.aggregatedOutput ?? ''), 20_000) }], toolCallId: item.id, isError: item.status === 'failed' }, true)
						break
				}
				break
			}
			case 'item/agentMessage/delta': {
				const b = run.blocks.get(p.itemId)
				if (b?.type === 'text') (b.text += p.delta), this.#emit(run, false)
				break
			}
			case 'item/reasoning/summaryTextDelta':
			case 'item/reasoning/textDelta': {
				const b = run.blocks.get(p.itemId)
				if (b?.type === 'thinking') (b.text += p.delta), this.#emit(run, false)
				break
			}
			case 'error':
				if (!p.willRetry) run.error = p.error?.message ?? 'The request failed'
				break
			case 'turn/completed':
				if (p.turn.status === 'failed') run.error ??= p.turn.error?.message ?? 'The turn failed'
				run.done.resolve()
				break
		}
	}

	#usage(u: { total: Record<string, number>; last: Record<string, number>; modelContextWindow?: number }) {
		const t = u.total
		this.usage.tokens = { input: (t.inputTokens ?? 0) - (t.cachedInputTokens ?? 0), output: t.outputTokens ?? 0, cacheRead: t.cachedInputTokens ?? 0, cacheWrite: t.cacheWriteInputTokens ?? 0, total: t.totalTokens ?? 0 }
		const window = u.modelContextWindow
		if (window) this.usage.context = { tokens: u.last.totalTokens ?? 0, contextWindow: window, percent: ((u.last.totalTokens ?? 0) / window) * 100 }
		this.ev.changed(false)
	}
}

export const codexDriver: DriverFactory = (events, prefs) => new CodexDriver(events, prefs)
