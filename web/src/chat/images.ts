// Screenshots and photos are shrunk before they go to the model: providers cap image size and dimensions,
// and every image stays in the conversation (and its token cost) for the rest of the chat.
export type Attachment = { id: string; mimeType: string; data: string; url: string }

const SUPPORTED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const MAX_SIDE = 2000
const KEEP_AS_IS_BYTES = 1_500_000
export const MAX_IMAGES = 6

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
	new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read the image'))), type, quality))

function toBase64(blob: Blob) {
	const { promise, resolve, reject } = Promise.withResolvers<string>()
	const reader = new FileReader()
	reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
	reader.onerror = () => reject(new Error('Could not read the image'))
	reader.readAsDataURL(blob)
	return promise
}

export async function prepareImage(file: File): Promise<Attachment> {
	if (!SUPPORTED.includes(file.type)) throw new Error(`${file.name || 'That file'} is not a PNG, JPEG, GIF or WebP image`)
	const bitmap = await createImageBitmap(file)
	const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
	let blob: Blob = file
	let mimeType = file.type
	// Small enough already: send the original bytes (keeps animated GIFs and exact screenshots intact).
	if (scale < 1 || file.size > KEEP_AS_IS_BYTES) {
		const canvas = document.createElement('canvas')
		canvas.width = Math.round(bitmap.width * scale)
		canvas.height = Math.round(bitmap.height * scale)
		canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
		blob = await toBlob(canvas, 'image/png')
		mimeType = 'image/png'
		if (blob.size > KEEP_AS_IS_BYTES) {
			blob = await toBlob(canvas, 'image/jpeg', 0.88)
			mimeType = 'image/jpeg'
		}
	}
	bitmap.close()
	return { id: crypto.randomUUID(), mimeType, data: await toBase64(blob), url: URL.createObjectURL(blob) }
}

export function attachmentFromBase64(mimeType: string, data: string): Attachment {
	const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
	return { id: crypto.randomUUID(), mimeType, data, url: URL.createObjectURL(new Blob([bytes], { type: mimeType })) }
}
