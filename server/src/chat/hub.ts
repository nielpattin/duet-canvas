import { existsSync } from 'node:fs'
import type { WebSocket } from 'ws'
import { z } from 'zod'
import { onTokenChange } from './auth.ts'
import { createDriver, detectAgent } from './agents.ts'
import { deleteChat, findChat, listChats, touchChat } from './chats.ts'
import { AGENTS, type AgentId, type ChatDriver, type DriverEvents, type DriverState, type Restored } from './driver.ts'
import { agentPrefs, selectAgent, selectedAgent } from './prefs.ts'
import { clearPendingReplies, reservePendingReplies } from '../shapes.ts'
import { clip, errorText, saveChatImage } from './wire.ts'

// A canvas hiccup must never take the chat down with it.
function canvasSafely(fn: () => unknown) {
	try {
		fn()
	} catch (e) {
		console.error('canvas pending replies:', errorText(e))
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
	z.object({ t: z.literal('set_agent'), agent: z.enum(AGENTS) }),
	z.object({ t: z.literal('chats') }),
	z.object({ t: z.literal('open_chat'), id: z.string().min(1) }),
	z.object({ t: z.literal('delete_chat'), id: z.string().min(1) }),
	z.object({ t: z.literal('unqueue'), message: z.string(), queue: Queue }),
	z.object({ t: z.literal('promote'), message: z.string() }),
])

const send = (ws: WebSocket, m: unknown) => {
	if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m))
}

const STATE_DEBOUNCE_MS = 1000

// One agent process (started on first use, kept alive) serves every browser tab. The server owns the chat, as it owns
// the canvas. Which agent that is (omp, Claude Code, Codex, opencode) is a setting the user changes in the chat header.
export class ChatHub {
	#driver: ChatDriver | undefined
	#starting: Promise<ChatDriver> | undefined
	#agent: AgentId = selectedAgent()
	#clients = new Set<WebSocket>()
	#running = false
	#startedAt = 0
	#current: { id: string; file: string } | undefined
	#stateTimer: NodeJS.Timeout | undefined
	// Message ids restart in every driver; the generation keeps them unique for the browser, and silences a driver
	// that was replaced (switching agent) or has died.
	#gen = 0

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
		this.#driver?.close()
	}

	#broadcast(m: unknown) {
		for (const ws of this.#clients) send(ws, m)
	}

	#ensure(): Promise<ChatDriver> {
		if (this.#driver && !this.#driver.closed) return Promise.resolve(this.#driver)
		if (!this.#starting) {
			const starting: Promise<ChatDriver> = this.#start().finally(() => {
				if (this.#starting === starting) this.#starting = undefined
			})
			this.#starting = starting
		}
		return this.#starting
	}

	async #start() {
		const agent = this.#agent
		const found = await detectAgent(agent)
		if (!found.ok) throw new Error(found.message)
		const gen = ++this.#gen
		const live = () => gen === this.#gen
		const events: DriverEvents = {
			runStart: () => {
				if (!live()) return
				canvasSafely(reservePendingReplies)
				this.#startedAt = Date.now()
				this.#running = true
				this.#broadcast({ t: 'running', running: true })
			},
			runEnd: () => {
				if (!live()) return
				canvasSafely(clearPendingReplies)
				this.#running = false
				this.#broadcast({ t: 'running', running: false, ms: Date.now() - this.#startedAt })
				this.#pushState(true)
			},
			message: (id, message, done) => live() && this.#broadcast({ t: 'message', id: `${gen}:${id}`, message, done }),
			queue: (steering, followUp) => live() && this.#broadcast({ t: 'queue', steering, followUp }),
			changed: (touch) => live() && this.#pushState(touch),
			error: (message) => live() && this.#broadcast({ t: 'error', message }),
			closed: (reason) => {
				if (!live()) return
				this.#driver = undefined
				if (this.#running) canvasSafely(clearPendingReplies)
				this.#running = false
				this.#broadcast({ t: 'running', running: false })
				this.#broadcast({ t: 'error', message: reason })
			},
		}
		const driver = createDriver(agent, events, agentPrefs(agent))
		try {
			await driver.start()
		} catch (e) {
			driver.close()
			throw e
		}
		// The user switched agent while this one was still starting: drop it and answer with the new one.
		if (!live()) {
			driver.close()
			return this.#ensure()
		}
		this.#driver = driver
		return driver
	}

	#pushState(touch: boolean) {
		const driver = this.#driver
		if (!driver) return
		clearTimeout(this.#stateTimer)
		this.#stateTimer = setTimeout(
			() => {
				if (this.#driver !== driver) return
				this.#state(driver).then(
					(s) => {
						this.#broadcast(s)
						if (touch && this.#current && existsSync(this.#current.file)) touchChat(this.#agent, this.#current.id, this.#current.file)
					},
					() => {}
				)
			},
			touch ? 0 : STATE_DEBOUNCE_MS
		)
	}

	async #state(driver: ChatDriver) {
		const { current, ...s }: DriverState = await driver.state()
		this.#running = s.running
		this.#current = current
		return { t: 'state', ...s }
	}

	async #sync(ws: WebSocket) {
		send(ws, { t: 'agent', agent: this.#agent })
		try {
			const driver = await this.#ensure()
			send(ws, await this.#state(driver))
			const messages = await driver.history()
			send(ws, { t: 'history', messages })
			// A session that existed before the index (or was reopened by --continue) still shows up in the history list.
			const first = messages.find((m) => m.role === 'user')?.blocks.find((b) => b.type === 'text')
			if (this.#current && first?.type === 'text' && existsSync(this.#current.file)) touchChat(this.#agent, this.#current.id, this.#current.file, clip(first.text.replace(/\s+/g, ' ').trim(), 60))
		} catch (e) {
			send(ws, { t: 'error', message: errorText(e) })
		}
	}

	async #resync(driver: ChatDriver) {
		this.#broadcast(await this.#state(driver))
		this.#broadcast({ t: 'history', messages: await driver.history() })
	}

	#restored(ws: WebSocket, items: Restored[]) {
		if (items.length) send(ws, { t: 'restored', items: items.map((i) => ({ text: i.text ?? '', images: i.images?.map(({ mimeType, data }) => ({ mimeType, data })) })) })
	}

	async #switchAgent(agent: AgentId) {
		if (agent === this.#agent) return
		const found = await detectAgent(agent)
		if (!found.ok) throw new Error(found.message)
		const old = this.#driver
		// Stop the old run first, or the old agent would keep editing the canvas after the user moved on.
		if (old && this.#running) await old.abort().catch(() => {})
		this.#gen++
		old?.close()
		this.#driver = undefined
		this.#starting = undefined
		if (this.#running) canvasSafely(clearPendingReplies)
		this.#running = false
		this.#current = undefined
		this.#agent = agent
		selectAgent(agent)
		this.#broadcast({ t: 'agent', agent })
		this.#broadcast({ t: 'running', running: false })
		await this.#resync(await this.#ensure())
	}

	async #handle(ws: WebSocket, raw: string) {
		try {
			const cmd = Cmd.parse(JSON.parse(raw))
			if (cmd.t === 'set_agent') return await this.#switchAgent(cmd.agent)
			const driver = await this.#ensure()
			switch (cmd.t) {
				case 'prompt': {
					const text = cmd.message.trim() || (cmd.images.length ? 'See the attached image.' : '')
					if (!text) break
					const files = cmd.images.flatMap((i) => saveChatImage(i.mimeType, i.data)?.file ?? [])
					// "steer" is delivered at the next opportunity inside the run, "followUp" after it finishes.
					const chat = await driver.prompt({ text, files, images: cmd.images, mode: cmd.mode })
					if (chat) {
						this.#current = chat
						touchChat(this.#agent, chat.id, chat.file, clip(text.replace(/\s+/g, ' '), 60))
					}
					break
				}
				case 'abort':
					// Stops the run and takes back anything still queued, so nothing the user typed is lost.
					this.#restored(ws, await driver.abort())
					break
				case 'unqueue': {
					const r = await driver.unqueue(cmd.message, cmd.queue)
					if (r) this.#restored(ws, [r])
					break
				}
				case 'promote':
					await driver.promote(cmd.message)
					break
				case 'new_chat':
					await driver.newChat()
					await this.#resync(driver)
					break
				case 'chats':
					send(ws, { t: 'chats', chats: this.#chatList() })
					break
				case 'open_chat': {
					const chat = findChat(cmd.id)
					if (!chat) throw new Error('That chat no longer exists')
					// A chat belongs to the agent that wrote it, so opening one from another agent switches to that agent first.
					const agent = chat.agent ?? 'omp'
					if (agent !== this.#agent) await this.#switchAgent(agent)
					const target = await this.#ensure()
					await target.openChat(chat.file)
					await this.#resync(target)
					break
				}
				case 'delete_chat':
					if (cmd.id === this.#current?.id) throw new Error('Open another chat before deleting this one')
					deleteChat(cmd.id)
					send(ws, { t: 'chats', chats: this.#chatList() })
					break
				case 'models':
					send(ws, { t: 'models', models: await driver.models() })
					break
				case 'set_model':
					await driver.setModel(cmd.provider, cmd.modelId)
					this.#broadcast(await this.#state(driver))
					break
				case 'set_thinking':
					await driver.setThinking(cmd.level)
					this.#broadcast(await this.#state(driver))
					break
			}
		} catch (e) {
			send(ws, { t: 'error', message: e instanceof z.ZodError ? 'Bad chat command' : errorText(e) })
		}
	}

	#chatList() {
		return listChats().map((c) => ({ id: c.id, agent: c.agent ?? 'omp', title: c.title || 'Untitled chat', updatedAt: c.updatedAt, current: c.id === this.#current?.id }))
	}
}
