import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { CLAUDE_BIN } from '../config.ts'
import type { Detected, DriverFactory, ModelInfo } from './driver.ts'
import { detectCli, killTree, launch, type Child } from './proc.ts'
import type { Frame } from './rpc.ts'
import { SessionDriver, type Turn } from './session.ts'
import { CANVAS_MCP_URL, SYSTEM_PROMPT, toolName, WORKSPACE } from './workspace.ts'
import { clip, errorText, type WireBlock } from './wire.ts'

export const detectClaude = (): Promise<Detected> => detectCli('Claude Code', CLAUDE_BIN, 'CLAUDE_BIN')

const MCP_FILE = join(WORKSPACE, 'claude-mcp.json')
const PROMPT_FILE = join(WORKSPACE, 'claude-system-prompt.txt')
const MODELS = [
	['default', 'Default'],
	['opus', 'Opus'],
	['sonnet', 'Sonnet'],
	['haiku', 'Haiku'],
]

type Part = { type: 'text'; text: string } | { type: 'thinking'; text: string } | { type: 'tool'; id: string; name: string; json: string }

const blocks = (parts: Part[]): WireBlock[] =>
	parts.map((p) => (p.type === 'tool' ? { type: 'tool', id: p.id, name: p.name, args: clip(p.json || '{}', 400) } : p))

// Claude Code runs as the user's own installed `claude` binary, logged in by the user (`claude login`); we never read
// its credentials. One short-lived process per turn: `-p` with stream-json in and out, the chat resumed by session id.
// That keeps model and effort changes a matter of flags, and the process holds nothing between turns.
// `--tools ""` removes every built-in tool, so only the canvas MCP server is reachable.
export class ClaudeDriver extends SessionDriver {
	protected readonly agent = 'claude' as const
	#child: Child | undefined

	async start() {
		mkdirSync(WORKSPACE, { recursive: true })
		writeFileSync(MCP_FILE, JSON.stringify({ mcpServers: { canvas: { type: 'http', url: CANVAS_MCP_URL } } }))
		writeFileSync(PROMPT_FILE, SYSTEM_PROMPT)
		this.model ??= { provider: 'anthropic', id: 'default', name: 'Default' }
	}

	close() {
		this.closed = true
		if (this.#child) killTree(this.#child)
	}

	levels() {
		return ['default', 'low', 'medium', 'high', 'xhigh', 'max']
	}

	protected async listModels(): Promise<ModelInfo[]> {
		return MODELS.map(([id, name]) => ({ provider: 'anthropic', id: id!, name: name!, image: true }))
	}

	protected interrupt() {
		if (this.#child) killTree(this.#child)
	}

	protected async runTurn(turn: Turn) {
		const args = [
			'-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
			'--tools', '', '--strict-mcp-config', '--mcp-config', MCP_FILE, '--allowedTools', 'mcp__canvas', '--permission-mode', 'dontAsk',
			'--system-prompt-file', PROMPT_FILE, '--setting-sources', '', '--disable-slash-commands',
		]
		if (this.model && this.model.id !== 'default') args.push('--model', this.model.id)
		if (this.thinking && this.thinking !== 'default') args.push('--effort', this.thinking)
		if (this.native) args.push('--resume', this.native)

		// The user's own CLAUDE.md files and auto-memory are about their coding setup, not this canvas chat.
		const env = { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }
		const child = launch(CLAUDE_BIN, args, { cwd: WORKSPACE, env })
		this.#child = child
		const { promise, resolve, reject } = Promise.withResolvers<void>()
		let stderr = ''
		let failure: string | undefined
		let finished = false
		child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)))
		child.stdin.on('error', () => {})
		child.on('error', (e) => reject(new Error(`Could not start claude: ${e.message}`)))
		child.on('close', (code) => {
			if (failure) reject(new Error(failure))
			else if (finished || this.wasInterrupted) resolve()
			else reject(new Error(`claude exited (code ${code})${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
		})

		const content: unknown[] = [{ type: 'text', text: turn.text }, ...turn.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mimeType, data: i.data } }))]
		child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n')

		// Streamed assistant messages, keyed by the API message id; their blocks arrive by index.
		const live = new Map<string, Part[]>()
		let contextTokens = 0
		const emit = (apiId: string, done: boolean) => {
			const parts = live.get(apiId)
			if (parts) this.put(`a:${apiId}`, { role: 'assistant', blocks: blocks(parts.filter(Boolean)) }, done)
		}

		createInterface({ input: child.stdout }).on('line', (line) => {
			let f: Frame
			try {
				f = JSON.parse(line)
			} catch {
				return
			}
			switch (f.type) {
				case 'system':
					if (f.subtype === 'init') {
						this.native = f.session_id
						if (this.model?.id === 'default') this.model = { ...this.model, name: `Default · ${f.model}` }
						this.ev.changed(false)
					}
					break
				case 'stream_event': {
					const e = f.event
					const id: string = f.api_message_id ?? e?.message?.id
					if (e.type === 'message_start') {
						live.set(id, [])
						const u = e.message?.usage
						contextTokens = (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0)
					} else if (e.type === 'content_block_start') {
						const b = e.content_block
						const parts = live.get(id)
						if (!parts) break
						if (b.type === 'text') parts[e.index] = { type: 'text', text: b.text ?? '' }
						else if (b.type === 'thinking') parts[e.index] = { type: 'thinking', text: b.thinking ?? '' }
						else if (b.type === 'tool_use') parts[e.index] = { type: 'tool', id: b.id, name: toolName('canvas', String(b.name).replace(/^mcp__canvas__/, '')), json: '' }
						emit(id, false)
					} else if (e.type === 'content_block_delta') {
						const p = live.get(id)?.[e.index]
						const d = e.delta
						if (!p) break
						if (d.type === 'text_delta' && p.type === 'text') p.text += d.text
						else if (d.type === 'thinking_delta' && p.type === 'thinking') p.text += d.thinking
						else if (d.type === 'input_json_delta' && p.type === 'tool') p.json += d.partial_json
						else break
						emit(id, false)
					} else if (e.type === 'content_block_stop') {
						const p = live.get(id)?.[e.index]
						if (p?.type === 'tool') p.json = JSON.stringify(safeJson(p.json))
					} else if (e.type === 'message_stop') {
						emit(id, true)
					}
					break
				}
				case 'user':
					for (const b of f.message?.content ?? []) {
						if (b?.type !== 'tool_result') continue
						const parts: Frame[] = typeof b.content === 'string' ? [{ type: 'text', text: b.content }] : Array.isArray(b.content) ? b.content : []
						const out = parts.flatMap((c): WireBlock[] => (c?.type === 'text' ? [{ type: 'text', text: clip(String(c.text ?? ''), 20_000) }] : c?.type === 'image' ? [{ type: 'image' }] : []))
						this.put(`t:${b.tool_use_id}`, { role: 'tool', blocks: out, toolCallId: b.tool_use_id, isError: Boolean(b.is_error) }, true)
					}
					break
				case 'result': {
					finished = true
					if (f.is_error) failure = String(f.result || 'Claude Code reported an error')
					const u = f.usage ?? {}
					const t = this.usage.tokens
					t.input = (t.input ?? 0) + (u.input_tokens ?? 0)
					t.output = (t.output ?? 0) + (u.output_tokens ?? 0)
					t.cacheRead = (t.cacheRead ?? 0) + (u.cache_read_input_tokens ?? 0)
					t.cacheWrite = (t.cacheWrite ?? 0) + (u.cache_creation_input_tokens ?? 0)
					this.usage.cost += f.total_cost_usd ?? 0
					const window = Object.values<Frame>(f.modelUsage ?? {})[0]?.contextWindow
					if (window && contextTokens) this.usage.context = { tokens: contextTokens, contextWindow: window, percent: (contextTokens / window) * 100 }
					this.ev.changed(false)
					break
				}
			}
		})
		return promise.finally(() => {
			if (this.#child === child) this.#child = undefined
		})
	}
}

function safeJson(s: string): unknown {
	try {
		return JSON.parse(s || '{}')
	} catch (e) {
		return { unreadable: errorText(e) }
	}
}

export const claudeDriver: DriverFactory = (events, prefs) => new ClaudeDriver(events, prefs)
