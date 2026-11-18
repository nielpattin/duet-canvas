import { createInterface } from 'node:readline'
import { killTree, type Child } from './proc.ts'

type Pending = { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
export type RpcFrame = { id?: number | string; method?: string; params?: any; result?: unknown; error?: { code: number; message: string } }

export type RpcHandlers = {
	onNotification(method: string, params: any): void
	/** Answers a request the agent sends us (approvals, file access). Throwing answers with a JSON-RPC error. */
	onRequest(method: string, params: any): unknown | Promise<unknown>
	onClose(reason: string): void
}

// Newline-delimited JSON-RPC 2.0 over a child's stdio, the framing Codex app-server and ACP agents (opencode) use.
export class JsonRpc {
	closed = false
	#child: Child
	#pending = new Map<number | string, Pending>()
	#seq = 0
	#stderr = ''

	constructor(child: Child, name: string, handlers: RpcHandlers) {
		this.#child = child
		const close = (reason: string) => {
			if (this.closed) return
			this.closed = true
			const detail = this.#stderr.trim() ? `: ${this.#stderr.trim()}` : ''
			for (const p of this.#pending.values()) {
				clearTimeout(p.timer)
				p.reject(new Error(`${reason}${detail}`))
			}
			this.#pending.clear()
			handlers.onClose(`${reason}${detail}`)
		}
		child.on('error', (e) => close(`Could not start ${name}: ${e.message}`))
		child.on('exit', (code) => close(`${name} exited (code ${code})`))
		child.stdin.on('error', () => {}) // a write after exit surfaces through 'exit'
		child.stderr.on('data', (d) => (this.#stderr = (this.#stderr + d).slice(-2000)))
		createInterface({ input: child.stdout }).on('line', (line) => {
			let f: RpcFrame
			try {
				f = JSON.parse(line)
			} catch {
				return
			}
			if (f.method && f.id !== undefined) void this.#serve(f, handlers)
			else if (f.method) handlers.onNotification(f.method, f.params)
			else if (f.id !== undefined) this.#settle(f)
		})
	}

	#write(f: Record<string, unknown>) {
		if (!this.closed) this.#child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...f }) + '\n')
	}

	#settle(f: RpcFrame) {
		const p = this.#pending.get(f.id!)
		if (!p) return
		this.#pending.delete(f.id!)
		clearTimeout(p.timer)
		if (f.error) p.reject(new Error(f.error.message))
		else p.resolve(f.result)
	}

	async #serve(f: RpcFrame, handlers: RpcHandlers) {
		try {
			this.#write({ id: f.id, result: (await handlers.onRequest(f.method!, f.params)) ?? null })
		} catch (e) {
			this.#write({ id: f.id, error: { code: -32601, message: e instanceof Error ? e.message : String(e) } })
		}
	}

	request<T = any>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
		if (this.closed) return Promise.reject(new Error('The agent is not running'))
		const id = ++this.#seq
		const { promise, resolve, reject } = Promise.withResolvers<T>()
		const timer = setTimeout(() => {
			this.#pending.delete(id)
			reject(new Error(`The agent did not answer "${method}" in time`))
		}, timeoutMs)
		this.#pending.set(id, { resolve: resolve as (d: unknown) => void, reject, timer })
		this.#write({ id, method, params })
		return promise
	}

	notify(method: string, params?: unknown) {
		this.#write({ method, ...(params === undefined ? {} : { params }) })
	}

	close() {
		this.#child.stdin.end()
		const child = this.#child
		// Both agents exit when stdin closes; the tree kill is for a shim or an agent stuck in a run.
		setTimeout(() => killTree(child), 3000).unref()
	}
}
