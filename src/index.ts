import Fastify from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import { VAD } from './vad.js'
import { IntelligenceEngine } from './intelligence.js'

const PORT = parseInt(process.env.PORT ?? '3000', 10)

// Saved insights persist in memory (extend to Redis/DB later if needed)
const savedInsights: Array<{ type: string; text: string; timestamp: number }> = []

async function start() {
  const app = Fastify({ logger: true })
  await app.register(fastifyWebsocket)

  // ─── Health check ──────────────────────────────────────────────────────────
  app.get('/health', async () => ({
    status: 'ok',
    service: 'Christian Leadership',
    timestamp: new Date().toISOString(),
  }))

  // ─── Saved insights API (used by Netlify dashboard) ────────────────────────
  app.get('/insights', async () => ({
    insights: savedInsights.slice(-100), // Last 100
  }))

  // ─── WebSocket stream endpoint ─────────────────────────────────────────────
  app.register(async (fastify) => {
    fastify.get('/stream', { websocket: true }, (socket) => {
      console.log('Glasses connected')

      const vad = new VAD()
      const engine = new IntelligenceEngine()

      // Initialize model selection on connect
      engine.initialize().then(() => {
        socket.send(JSON.stringify({
          type: 'status',
          text: '● Listening       Christian Leadership',
        }))
      }).catch(console.error)

      socket.on('message', (rawData: Buffer | string) => {
        // Binary = PCM audio from glasses mic
        if (Buffer.isBuffer(rawData)) {
          const isSpeaking = vad.process(rawData)

          engine.onAudioChunkWithCallback(rawData, isSpeaking, (insight) => {
            // Send insight to glasses
            socket.send(JSON.stringify({
              type: 'insight',
              payload: {
                ...insight,
                timestamp: Date.now(),
              },
            }))
          })
          return
        }

        // Text = control messages from glasses app
        try {
          const msg = JSON.parse(rawData.toString()) as {
            type: string
            payload?: { type: string; text: string; timestamp: number }
          }

          if (msg.type === 'save' && msg.payload) {
            savedInsights.push(msg.payload)
            console.log('Insight saved:', msg.payload.text)
          }

          if (msg.type === 'clear_memory') {
            engine.clearMemory()
            vad.reset()
            console.log('Memory cleared')
          }
        } catch { /* ignore malformed messages */ }
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
