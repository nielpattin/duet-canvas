import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

// config.ts reads DATA_DIR when it loads, so auth.ts must load after this line: a static import would be hoisted above it.
const dir = mkdtempSync(join(tmpdir(), 'canvas-auth-'))
process.env.DATA_DIR = dir
const { chatToken, rotateToken, tokenOk } = await import('./auth.ts')
after(() => rmSync(dir, { recursive: true, force: true }))

test('a rotated or rewritten token file kills the old token on the next check', () => {
	const first = chatToken()
	assert.equal(chatToken(), first)

	const second = rotateToken()
	assert.notEqual(second, first)
	assert.ok(tokenOk(second))
	assert.ok(!tokenOk(first), 'the old token still works after rotateToken')

	// `cduet rotate` is another process: a running server must see its write without a restart.
	const external = 'f'.repeat(64)
	writeFileSync(join(dir, 'chat-token'), external)
	assert.ok(tokenOk(external))
	assert.ok(!tokenOk(second), 'a cached token outlived a rewrite of the file')
})
