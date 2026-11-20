export interface MediaInfo {
	kind: 'image' | 'video'
	mimeType: string
	w: number
	h: number
	animated: boolean
}

const img = (mimeType: string, w: number, h: number, animated = false): MediaInfo => ({ kind: 'image', mimeType, w, h, animated })

// MP4 stores the picture size in the 'tkhd' box of the video track (audio tracks have 0x0).
// moov can sit at the end of the file, so search the whole buffer.
function mp4Size(b: Buffer): { w: number; h: number } | null {
	let at = b.indexOf('tkhd', 0, 'ascii')
	while (at !== -1) {
		const body = at + 4 // right after the box type
		const version = b[body]
		const wOffset = body + (version === 1 ? 88 : 76)
		if (wOffset + 8 <= b.length) {
			const w = b.readUInt32BE(wOffset) / 65536
			const h = b.readUInt32BE(wOffset + 4) / 65536
			if (w > 0 && h > 0) return { w: Math.round(w), h: Math.round(h) }
		}
		at = b.indexOf('tkhd', at + 4, 'ascii')
	}
	return null
}

// WebM (Matroska): PixelWidth (0xB0) and PixelHeight (0xBA) elements sit together in the video track header.
function webmSize(b: Buffer): { w: number; h: number } | null {
	const end = Math.min(b.length - 8, 8192)
	for (let i = 0; i < end; i++) {
		if (b[i] === 0xb0 && b[i + 1] === 0x82 && b[i + 4] === 0xba && b[i + 5] === 0x82) {
			return { w: b.readUInt16BE(i + 2), h: b.readUInt16BE(i + 6) }
		}
	}
	return null
}

// Reads type and pixel size straight from the file header, so we need no media library.
// Videos whose size cannot be read come back as 0x0; the caller picks a size.
export function sniffMedia(b: Buffer): MediaInfo | null {
	if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return img('image/png', b.readUInt32BE(16), b.readUInt32BE(20))
	if (b.length > 10 && b.toString('ascii', 0, 3) === 'GIF') return img('image/gif', b.readUInt16LE(6), b.readUInt16LE(8), true)
	if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
		let i = 2
		while (i + 9 < b.length) {
			if (b[i] !== 0xff) {
				i++
				continue
			}
			const marker = b[i + 1]!
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return img('image/jpeg', b.readUInt16BE(i + 7), b.readUInt16BE(i + 5))
			}
			i += 2 + b.readUInt16BE(i + 2)
		}
		return null
	}
	if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
		const kind = b.toString('ascii', 12, 16)
		if (kind === 'VP8X') return img('image/webp', 1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3))
		if (kind === 'VP8 ') return img('image/webp', b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff)
		if (kind === 'VP8L') {
			const bits = b.readUInt32LE(21)
			return img('image/webp', (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
		}
	}
	if (b.length > 12 && b.toString('ascii', 4, 8) === 'ftyp') {
		return { kind: 'video', mimeType: 'video/mp4', animated: true, ...(mp4Size(b) ?? { w: 0, h: 0 }) }
	}
	if (b.length > 4 && b.readUInt32BE(0) === 0x1a45dfa3) {
		return { kind: 'video', mimeType: 'video/webm', animated: true, ...(webmSize(b) ?? { w: 0, h: 0 }) }
	}
	return null
}
