import OpenAI from 'openai'
import { SYSTEM_PROMPT } from './prompt.js'
import { ConversationMemory } from './memory.js'

const DEFAULT_MODEL = 'gpt-4o'
const CHUNK_INTERVAL_MS = 4000   // Process audio every 4 seconds
const COOLDOWN_MS = 3000          // Min time between insights

export class IntelligenceEngine {
  private client: OpenAI
  private memory: ConversationMemory
  private audioBuffer: Buffer[] = []
  private insightCooldown = false
  private chunkTimer: ReturnType<typeof setTimeout> | null = null
  private model: string
  private onInsightCallback: ((insight: { type: string; text: string }) => void) | null = null

  constructor() {
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    this.memory = new ConversationMemory()
    this.model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL
    console.log(`Using model: ${this.model}`)
  }

  async initialize() {
    try {
      const models = await this.client.models.list()
      const available = models.data.map(m => m.id)
      if (!available.includes(this.model)) {
        console.warn(`Model ${this.model} not found, falling back to gpt-4o`)
        this.model = 'gpt-4o'
      }
      console.log(`Model confirmed: ${this.model}`)
    } catch {
      console.warn('Could not verify model, proceeding with:', this.model)
    }

    // Start the recurring chunk processor
    this.scheduleChunkProcessing()
  }

  // Schedule processing every CHUNK_INTERVAL_MS regardless of silence
  private scheduleChunkProcessing() {
    this.chunkTimer = setTimeout(async () => {
      await this.processCurrentBuffer()
      this.scheduleChunkProcessing() // reschedule
    }, CHUNK_INTERVAL_MS)
  }

  private async processCurrentBuffer() {
    if (this.audioBuffer.length === 0) return

    const toProcess = Buffer.concat(this.audioBuffer)
    this.audioBuffer = []

    if (toProcess.length < 6400) return // Less than ~0.2s — skip

    const transcript = await this.transcribe(toProcess)
    if (transcript) {
      this.memory.add(transcript)
      const insight = await this.generateInsight()
      if (insight && this.onInsightCallback) {
        this.onInsightCallback(insight)
      }
    }
  }

  private async transcribe(pcmData: Buffer): Promise<string | null> {
    try {
      const wavBuffer = pcmToWav(pcmData, 16000, 1, 16)
      const file = new File([new Uint8Array(wavBuffer)], 'audio.wav', { type: 'audio/wav' })

      const response = await this.client.audio.transcriptions.create({
        model: 'whisper-1',
        file,
        language: 'en',
      })

      const text = response.text?.trim()
      if (!text || text.length < 5) return null
      console.log('Transcript:', text)
      return text
    } catch (err) {
      console.error('Transcription error:', err)
      return null
    }
  }

  async generateInsight(): Promise<{ type: string; text: string } | null> {
    if (this.insightCooldown) return null

    const context = this.memory.getContext()
    if (!context) return null

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: this.model,
          max_tokens: 120,
          temperature: 0.7,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: `Conversation so far:\n\n${context}\n\nSurface an insight if warranted. Respond in JSON only.`,
            },
          ],
        })

        const raw = response.choices[0]?.message?.content?.trim()
        if (!raw) return null

        console.log('Model response:', raw)

        const parsed = JSON.parse(raw) as { type: string; text?: string }
        if (parsed.type === 'silence' || !parsed.text) return null

        console.log('Insight surfaced:', parsed)

        this.insightCooldown = true
        setTimeout(() => { this.insightCooldown = false }, COOLDOWN_MS)

        return { type: parsed.type, text: parsed.text }

      } catch (err: any) {
        if (err?.status === 500 && attempt < 3) {
          await new Promise(r => setTimeout(r, 1000 * attempt))
          continue
        }
        console.error('Insight error:', err?.message ?? err)
        return null
      }
    }

    return null
  }

  // Register insight callback and start receiving audio
  setInsightCallback(cb: (insight: { type: string; text: string }) => void) {
    this.onInsightCallback = cb
  }

  // Called with every audio chunk from the glasses
  addAudioChunk(chunk: Buffer) {
    this.audioBuffer.push(chunk)
  }

  clearMemory() {
    this.memory.clear()
    this.audioBuffer = []
  }

  destroy() {
    if (this.chunkTimer) clearTimeout(this.chunkTimer)
  }
}

// ─── PCM → WAV ────────────────────────────────────────────────────────────────
function pcmToWav(pcm: Buffer, sampleRate: number, channels: number, bitDepth: number): Buffer {
  const dataSize = pcm.length
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * (bitDepth / 8), 28)
  header.writeUInt16LE(channels * (bitDepth / 8), 32)
  header.writeUInt16LE(bitDepth, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)
  return Buffer.concat([header, pcm])
}
