import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const SERVER = 'http://127.0.0.1:5858'

export default defineConfig({
	plugins: [react()],
	server: {
		proxy: {
			'/connect': { target: SERVER, ws: true },
			'/api': SERVER,
			'/uploads': SERVER,
		},
	},
})
