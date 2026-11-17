import { memo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const plugins = [remarkGfm]
// Agent text is untrusted: react-markdown never renders raw HTML and drops unsafe link protocols. Images are removed
// too, so a reply cannot make the browser fetch remote URLs.
const components = {
	a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
		<a href={href} target="_blank" rel="noreferrer noopener">
			{children}
		</a>
	),
}

// Memoized per text: while one message streams, every earlier message keeps its parsed output.
export const Md = memo(function Md({ text }: { text: string }) {
	return (
		<div className="md">
			<Markdown remarkPlugins={plugins} components={components} disallowedElements={['img']}>
				{text}
			</Markdown>
		</div>
	)
})
