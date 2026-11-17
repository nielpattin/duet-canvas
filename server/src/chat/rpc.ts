import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

export type Frame = { type: string } & Record<string, any>

type Pending = { resolve: (data: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
type Chunks = { id: string; count: number; byteLength: number; parts: Buffer[] }

const MAX_REASSEMBLED = 64 * 1024 * 1024

// JSONL client for `omp --mode rpc` (omp://rpc.md). Not JSON-RPC: responses carry the request `id`,
// everything else is an event handed to `onFrame`.
export class OmpRpc {
	closed = false
	#child: ChildProcessByStdio<Writable, Readable, null>
	#pending = new Map<string, Pending>()
	#seq = 0
	#chunks: Chunks | undefined
	#onFrame: (f: Frame) => void

	constructor(bin: string, args: string[], cwd: string, onFrame: (f: Frame) => void, onClose: (reason: string) => void) {
		this.#onFrame = onFrame
		// windowsHide: the daemon has no console, so on Windows omp would otherwise open a terminal window of its own.
		const child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
		this.#child = child
		const close = (reason: string) => {
			if (this.closed) return
			this.closed = true
			for (const p of this.#pending.values()) {
				clearTimeout(p.timer)
				p.reject(new Error(reason))
			}
			this.#pending.clear()
			onClose(reason)
		}
		child.on('error', (e) => close(`Could not start omp: ${e.message}`))
		child.on('exit', (code) => close(`omp exited (code ${code})`))
		child.stdin.on('error', () => {}) // a write after exit surfaces through 'exit'
		createInterface({ input: child.stdout }).on('line', (line) => this.#line(line))
		// First thing in the pipe: protocol v2 sends oversized frames (tool results with images) as rpc_chunk
		// sequences instead of cutting them. An omp without v2 answers with an error and we stay on v1.
		this.request('negotiate_protocol', { protocolVersion: 2 }).catch(() => {})
	}

	request<T = any>(type: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
		if (this.closed) return Promise.reject(new Error('omp is not running'))
		const id = `r${++this.#seq}`
		const { promise, resolve, reject } = Promise.withResolvers<T>()
		const timer = setTimeout(() => {
			this.#pending.delete(id)
			reject(new Error(`omp did not answer "${type}" in time`))
		}, timeoutMs)
		this.#pending.set(id, { resolve, reject, timer })
		this.#child.stdin.write(JSON.stringify({ id, type, ...params }) + '\n')
		return promise
	}

	// Closing stdin is omp's graceful shutdown: it finishes pending work and exits.
	close() {
		this.#child.stdin.end()
	}

	#line(line: string) {
		if (!line.trim()) return
		let f: Frame
		try {
			f = JSON.parse(line)
		} catch {
			return
		}
		if (f.type === 'rpc_chunk') this.#chunk(f)
		else this.#dispatch(f)
	}

	#chunk(f: Frame) {
		if (f.index === 0) this.#chunks = { id: f.chunkId, count: f.count, byteLength: f.byteLength, parts: [] }
		const c = this.#chunks
		// Interleaved, interrupted or oversized sequences are dropped, as the protocol requires.
		if (!c || c.id !== f.chunkId || c.parts.length !== f.index || c.byteLength > MAX_REASSEMBLED) {
			this.#chunks = undefined
			return
		}
		c.parts.push(Buffer.from(f.data, 'base64'))
		if (c.parts.length < c.count) return
		this.#chunks = undefined
		const body = Buffer.concat(c.parts)
		if (body.length !== c.byteLength) return
		try {
			this.#dispatch(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)))
		} catch {
			// not valid UTF-8 JSON: drop it
		}
	}

	#dispatch(f: Frame) {
		if (f.type !== 'response' || typeof f.id !== 'string') return this.#onFrame(f)
		const p = this.#pending.get(f.id)
		if (!p) return
		this.#pending.delete(f.id)
		clearTimeout(p.timer)
		if (f.success) p.resolve(f.data)
		else p.reject(new Error(f.error ?? `${f.command} failed`))
	}
}
