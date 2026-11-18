import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SESSIONS } from './chats.ts'
import type { AgentId, ChatDriver, DriverEvents, DriverState, Image, ModelInfo, PrefsStore, PromptInput, Restored, Usage } from './driver.ts'
import { attachmentNote, errorText, saveChatImage, type WireMessage } from './wire.ts'

export type Turn = { text: string; images: Image[] }
type Stored = { id: string; native?: string; usage: Usage; messages: WireMessage[] }

export const emptyUsage = (): Usage => ({ cost: 0, tokens: {}, context: null })

// The agents that do not keep a transcript the browser can read (Claude Code, Codex, opencode) share this: the driver
// turns the agent's event stream into wire messages, and this class keeps them as the transcript (a JSON file per chat
// in sessions/), runs the turns one after another, and owns the queue. A subclass only runs one turn at a time.
export abstract class SessionDriver implements ChatDriver {
	closed = false
	protected abstract readonly agent: AgentId
	/** The agent's own id for the open chat (Claude session, Codex thread), so the next turn resumes it. */
	protected native: string | undefined
	protected usage = emptyUsage()
	protected model: { provider: string; id: string; name: string } | null = null
	protected thinking: string | null
	#chat: { id: string; file: string } | undefined
	#items: { id: string; message: WireMessage }[] = []
	#open = new Set<string>()
	#queue = { steering: [] as PromptInput[], followUp: [] as PromptInput[] }
	#running = false
	#interrupted = false
	#drained: Promise<void> = Promise.resolve()
	#seq = 0

	protected ev: DriverEvents
	protected prefs: PrefsStore

	constructor(ev: DriverEvents, prefs: PrefsStore) {
		this.ev = ev
		this.prefs = prefs
		const { model, thinking } = prefs.get()
		if (model) this.model = { ...model, name: model.id }
		this.thinking = thinking ?? 'default'
	}

	abstract start(): Promise<void>
	abstract close(): void
	abstract levels(): string[]
	protected abstract listModels(): Promise<ModelInfo[]>
	/** Runs one turn to its end. Reports through `put`; sets `native`, `usage` and `model` as the agent reveals them. */
	protected abstract runTurn(turn: Turn): Promise<void>
	/** Stops the turn in progress; `runTurn` then settles. */
	protected abstract interrupt(): void
	/** Delivers a message into the running turn. False: the agent cannot, so the message waits in the queue. */
	protected steer?(turn: Turn): Promise<boolean>

	protected get isRunning() {
		return this.#running
	}
	protected get wasInterrupted() {
		return this.#interrupted
	}
	protected nextId = () => `m${++this.#seq}`

	/** Inserts or replaces a message of the transcript and shows it in the browser. */
	protected put(id: string, message: WireMessage, done: boolean) {
		const i = this.#items.findIndex((x) => x.id === id)
		if (i < 0) this.#items.push({ id, message })
		else this.#items[i] = { id, message }
		if (done) {
			this.#open.delete(id)
			this.#save()
		} else this.#open.add(id)
		this.ev.message(id, message, done)
	}

	#save() {
		if (!this.#chat) return
		const stored: Stored = { id: this.#chat.id, native: this.native, usage: this.usage, messages: this.#items.map((x) => x.message) }
		try {
			writeFileSync(this.#chat.file, JSON.stringify(stored))
		} catch (e) {
			this.ev.error(`Could not save the chat: ${errorText(e)}`)
		}
	}

	#ensureChat() {
		if (this.#chat) return this.#chat
		mkdirSync(SESSIONS, { recursive: true })
		const id = randomUUID()
		return (this.#chat = { id, file: join(SESSIONS, `${this.agent}-${id}.json`) })
	}

	#addUser(p: PromptInput) {
		const blocks: WireMessage['blocks'] = [{ type: 'text', text: p.text }, ...p.images.map((i) => ({ type: 'image' as const, src: saveChatImage(i.mimeType, i.data)?.url }))]
		this.put(`u${this.nextId()}`, { role: 'user', blocks }, true)
	}

	#emitQueue() {
		this.ev.queue(this.#queue.steering.map((q) => q.text), this.#queue.followUp.map((q) => q.text))
	}

	async prompt(p: PromptInput) {
		const chat = this.#ensureChat()
		const turn = (q: PromptInput): Turn => ({ text: q.text + attachmentNote(q.files), images: q.images })
		if (this.#running) {
			if (p.mode === 'steer' && this.steer && (await this.steer(turn(p)))) this.#addUser(p)
			else {
				this.#queue[p.mode === 'steer' ? 'steering' : 'followUp'].push(p)
				this.#emitQueue()
			}
		} else {
			this.#addUser(p)
			this.#drained = this.#drain(turn(p), turn)
		}
		return chat
	}

	async #drain(first: Turn, toTurn: (q: PromptInput) => Turn) {
		this.#running = true
		this.ev.runStart()
		let turn: Turn | undefined = first
		while (turn) {
			this.#interrupted = false
			try {
				await this.runTurn(turn)
			} catch (e) {
				if (!this.#interrupted) this.ev.error(errorText(e))
			}
			for (const id of this.#open) {
				const m = this.#items.find((x) => x.id === id)?.message
				if (m) this.put(id, m, true)
			}
			// The queue only holds messages the user typed after the last abort, which clears it.
			const next: PromptInput | undefined = this.#queue.steering.shift() ?? this.#queue.followUp.shift()
			if (next) {
				this.#emitQueue()
				this.#addUser(next)
			}
			turn = next && toTurn(next)
		}
		this.#running = false
		this.#save()
		this.ev.runEnd()
	}

	async #idle() {
		this.#interrupted = true
		this.#queue = { steering: [], followUp: [] }
		this.#emitQueue()
		if (this.#running) this.interrupt()
		await this.#drained
	}

	async abort(): Promise<Restored[]> {
		const restored = [...this.#queue.steering, ...this.#queue.followUp].map((q) => ({ text: q.text, images: q.images }))
		this.#queue = { steering: [], followUp: [] }
		this.#emitQueue()
		if (this.#running) {
			this.#interrupted = true
			this.interrupt()
		}
		return restored
	}

	async unqueue(message: string, queue: 'steering' | 'followUp') {
		const list = this.#queue[queue]
		const i = list.findIndex((q) => q.text === message)
		if (i < 0) return undefined
		const [q] = list.splice(i, 1)
		this.#emitQueue()
		return { text: q!.text, images: q!.images }
	}

	async promote(message: string) {
		const i = this.#queue.followUp.findIndex((q) => q.text === message)
		if (i < 0) return
		this.#queue.steering.push(...this.#queue.followUp.splice(i, 1))
		this.#emitQueue()
	}

	#reset(stored?: Stored, file?: string) {
		this.#items = (stored?.messages ?? []).map((message) => ({ id: this.nextId(), message }))
		this.#open.clear()
		this.#chat = stored && file ? { id: stored.id, file } : undefined
		this.native = stored?.native
		this.usage = stored?.usage ?? emptyUsage()
	}

	async newChat() {
		await this.#idle()
		this.#reset()
	}

	async openChat(file: string) {
		const stored: Stored = JSON.parse(readFileSync(file, 'utf8'))
		if (!Array.isArray(stored.messages)) throw new Error('That chat file is damaged')
		await this.#idle()
		this.#reset(stored, file)
	}

	async history() {
		return this.#items.map((x) => x.message)
	}

	async state(): Promise<DriverState> {
		return {
			model: this.model,
			thinking: this.thinking,
			levels: this.levels(),
			running: this.#running,
			queue: { steering: this.#queue.steering.map((q) => q.text), followUp: this.#queue.followUp.map((q) => q.text) },
			usage: this.usage,
			extraTools: [],
			current: this.#chat,
		}
	}

	models() {
		return this.listModels()
	}

	async setModel(provider: string, id: string) {
		const found = (await this.listModels()).find((m) => m.provider === provider && m.id === id)
		this.model = { provider, id, name: found?.name ?? id }
		this.prefs.set({ model: { provider, id } })
		this.ev.changed(false)
	}

	async setThinking(level: string) {
		if (!this.levels().includes(level)) throw new Error(`Unknown effort "${level}"`)
		this.thinking = level
		this.prefs.set({ thinking: level })
		this.ev.changed(false)
	}
}
