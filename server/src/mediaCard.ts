import { createTLSchema, defaultShapeSchemas } from '@tldraw/tlschema'
import { T } from '@tldraw/validate'

// One shape for an image, GIF or video together with its caption, so the caption can never be left behind.
// The web app defines the same shape (web/src/mediaCard.tsx): keep the two in sync, the sync room rejects a mismatch.
export const MEDIA_CARD = 'media-card'

/** Height of the caption strip under the picture, in page pixels. */
export const CAPTION_H = 48

export interface MediaCardProps {
	/** Picture width. */
	w: number
	/** Picture height (the caption strip comes on top of this). */
	h: number
	kind: 'image' | 'video'
	/** Where the file is served from, e.g. /uploads/<uuid>-name.png */
	src: string
	mimeType: string
	name: string
	caption: string
}

declare module '@tldraw/tlschema' {
	interface TLGlobalShapePropsMap {
		'media-card': MediaCardProps
	}
}

export const mediaCardProps = {
	w: T.number,
	h: T.number,
	kind: T.literalEnum('image', 'video'),
	src: T.string,
	mimeType: T.string,
	name: T.string,
	caption: T.string,
}

// createTLSchema replaces the default shapes when given any, so spread them back in.
export const schema = createTLSchema({ shapes: { ...defaultShapeSchemas, [MEDIA_CARD]: { props: mediaCardProps } } })
