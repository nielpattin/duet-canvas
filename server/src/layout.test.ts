import assert from 'node:assert/strict'
import { test } from 'node:test'
import { freeRectNear, isFree, type Rect } from './layout.ts'

// Two marks on one image: the first reply already sits under the image. The second reply must use the free space
// beside it or under its own mark, not queue below the first reply.
test('a second reply on the same target lands near its mark, not below the first reply', () => {
	const image: Rect = { x: 0, y: 0, w: 720, h: 1300 }
	const firstReply: Rect = { x: 0, y: 1412, w: 360, h: 800 }
	const mark: Rect = { x: 1250, y: 650, w: 200, h: 200 }
	const obstacles = [image, firstReply, mark]
	const underImage = { x: 0, y: image.h + 112 }
	const underMark = { x: mark.x, y: mark.y + mark.h + 112 }

	const spot = freeRectNear(obstacles, [], 360, 240, underImage, underMark, 1600)
	assert.ok(spot)
	assert.ok(isFree(obstacles, [], spot))
	assert.ok(spot.y < firstReply.y + firstReply.h, `landed at y=${spot.y}, below the first reply`)
})

test('the spot right under the target wins when it is free', () => {
	const image: Rect = { x: 0, y: 0, w: 720, h: 1300 }
	const mark: Rect = { x: 1250, y: 650, w: 200, h: 200 }
	const underImage = { x: 0, y: 1412 }
	assert.deepEqual(freeRectNear([image, mark], [], 360, 240, underImage, { x: 1250, y: 962 }, 1600), { ...underImage, w: 360, h: 240 })
})
