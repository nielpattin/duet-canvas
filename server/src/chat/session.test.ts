import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { DriverEvents, PrefsStore } from './driver.ts'
import type { Turn } from './session.ts'

// config.ts reads DATA_DIR when it loads (session.ts imports it through chats.ts), so load after this line.
const dir = mkdtempSync(join(tmpdir(), 'canvas-session-'))
process.env.DATA_DIR = dir
const { SessionDriver } = await import('./session.ts')
after(() => rmSync(dir, { recursive: true, force: true }))

const prefs: PrefsStore = { get: () => ({}), set: () => {} }

// An agent whose turns finish only when the test says so.
class Fake extends SessionDriver {
	protected readonly agent = 'claude' as const
	turns: string[] = []
	gate = Promise.withResolvers<void>()
	started = Promise.withResolvers<void>()
	ended = Promise.withResolvers<void>()
	constructor() {
		super({ runStart() {}, runEnd: () => this.ended.resolve(), message() {}, queue() {}, changed() {}, error: (m) => assert.fail(m), closed() {} } satisfies DriverEvents, prefs)
	}
	async start() {}
	close() {}
	levels() {
		return ['default']
	}
	protected async listModels() {
		return []
	}
	protected interrupt() {
		this.gate.resolve()
	}
	protected async runTurn(turn: Turn) {
		this.turns.push(turn.text)
		this.started.resolve()
		await this.gate.promise
		this.gate = Promise.withResolvers()
		this.put(this.nextId(), { role: 'assistant', blocks: [{ type: 'text', text: `re: ${turn.text}` }] }, true)
	}
	/** Waits for the next turn to begin, then lets it finish. */
	async finishNext() {
		await this.started.promise
		this.started = Promise.withResolvers()
		this.gate.resolve()
	}
}

const say = (text: string, mode: 'steer' | 'followUp') => ({ text, files: [], images: [], mode })

test('queued messages run after the turn, steering before follow-ups, one turn each', async () => {
	const d = new Fake()
	await d.prompt(say('first', 'steer'))
	await d.prompt(say('later', 'followUp'))
	await d.prompt(say('now', 'steer'))
	assert.deepEqual((await d.state()).queue, { steering: ['now'], followUp: ['later'] })
	for (let i = 0; i < 3; i++) await d.finishNext()
	await d.ended.promise
	assert.deepEqual(d.turns, ['first', 'now', 'later'])
	assert.deepEqual((await d.history()).map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
})

test('abort hands back what was queued, and the chat reopens from its file', async () => {
	const d = new Fake()
	const chat = await d.prompt(say('long', 'steer'))
	await d.prompt(say('typed meanwhile', 'followUp'))
	assert.deepEqual((await d.abort()).map((r) => r.text), ['typed meanwhile'])
	await d.ended.promise
	assert.deepEqual(d.turns, ['long'], 'the restored message must not run')

	const other = new Fake()
	await other.openChat(chat!.file)
	assert.deepEqual(await other.history(), await d.history())
})
