import Fastify from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import { VAD } from './vad.js'
import { IntelligenceEngine } from './intelligence.js'

const PORT = parseInt(process.env.PORT ?? '3000', 10)

const savedInsights: Array<{ type: string; text: string; timestamp: number }> = []

async function start() {
  const app = Fastify({ logger: true })
  await app.register(fastifyWebsocket)

  app.get('/health', async () => ({
    status: 'ok',
    service: 'Christian Leadership',
    timestamp: new Date().toISOString(),
  }))

  app.get('/insights', async () => ({
    insights: savedInsights.slice(-100),
  }))

  app.register(async (fastify) => {
    fastify.get('/stream', { websocket: true }, (socket) => {
      console.log('Glasses connected')

      const vad = new VAD()
      const engine = new IntelligenceEngine()

      engine.initialize().catch(console.error)

      socket.on('message', (rawData: Buffer | string) => {
        // Binary audio from glasses
        if (Buffer.isBuffer(rawData) || (rawData as any) instanceof Uint8Array) {
          const buf = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData)
          const isSpeaking = vad.process(buf)

          engine.onAudioChunkWithCallback(buf, isSpeaking, (insight) => {
            socket.send(JSON.stringify({
              type: 'insight',
              payload: { ...insight, timestamp: Date.now() },
            }))
          })
          return
        }

        // Text control messages
        try {
          const msg = JSON.parse(rawData.toString()) as {
            type: string
            payload?: { type: string; text: string; timestamp: number }
          }

          if (msg.type === 'save' && msg.payload) {
            savedInsights.push(msg.payload)
            console.log('Saved:', msg.payload.text)
          }

          if (msg.type === 'clear_memory') {
            engine.clearMemory()
            vad.reset()
          }
        } catch { /* ignore */ }
      })

      socket.on('close', () => {
        console.log('Glasses disconnected')
        vad.reset()
      })

      socket.on('error', (err: Error) => {
        console.error('WebSocket error:', err.message)
      })
    })
  })

  await app.listen({ port: PORT, host: '0.0.0.0' })
  console.log(`Christian Leadership server running on port ${PORT}`)
}

start().catch((err) => {
  console.error('Server startup failed:', err)
  process.exit(1)
})
