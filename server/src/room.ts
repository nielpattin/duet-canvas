import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import type { TLRecord } from '@tldraw/tlschema'
import { DATA_DIR } from './config.ts'
import { schema } from './mediaCard.ts'

export type CanvasRoom = TLSocketRoom<TLRecord, void>

// One canvas, owned by the server. It stays loaded even when no browser tab is connected,
// so MCP tools can read and edit it at any time. SQLite makes it survive restarts.
const db = new DatabaseSync(join(DATA_DIR, 'canvas.db'))
const storage = new SQLiteSyncStorage<TLRecord>({ sql: new NodeSqliteWrapper(db) })

export const room: CanvasRoom = new TLSocketRoom<TLRecord, void>({ storage, schema })

export function closeRoom() {
	room.close()
	db.close()
}
