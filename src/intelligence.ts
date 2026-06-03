import OpenAI from 'openai'
import { SYSTEM_PROMPT } from './prompt.js'
import { ConversationMemory } from './memory.js'

// ─── Model ────────────────────────────────────────────────────────────────────
// Default: gpt-4o. Override via OPENAI_MODEL env variable when new models release.
const DEFAULT_MODEL = 'gpt-4o'

export class IntelligenceEngine {
  private client: OpenAI
  private memory: ConversationMemory
  private audioBuffer: Buffer[] = []
  private processingAudio = false
  private insightCooldown = false
  private readonly COOLDOWN_MS = 3000  // 3s between insights
  private model: string

  constructor() {
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    this.memory = new ConversationMemory()
    this.model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL
    console.log(`Using model: ${this.model}`)
  }

  async initialize() {
    // Verify model is accessible
    try {
      const models = await this.client.models.list()
      const available = models.data.map(m => m.id)
      if (!available.includes(this.model)) {
        console.warn(`Model ${this.model} not found, falling back to gpt-4o`)
        this.model = 'gpt-4o'
      }
      console.log(`Model confirmed: ${this.model}`)
    } catch (err) {
      console.warn('Could not verify model, proceeding with:', this.model)
    }
  }

  private async transcribe(pcmData: Buffer): Promise<string | null> {
    try {
      if (pcmData.length < 3200) return null // Too short — less than 0.1s of audio
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

    // Retry up to 3 times with exponential backoff for 500 errors
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: this.model,
          max_tokens: 120,
          temperature: 0.7,
          response_format: { type: 'json_object' },  // Guaranteed valid JSON
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: `Conversation so far:\n\n${context}\n\nSurface an insight if warranted. Respond in JSON only.`,
            },
          ],
        })

        const raw = response.choices[0]?.message?.content?.trim()
        if (!raw) {
          console.log('Insight: empty response from model')
          return null
        }

        console.log('Model response:', raw)

        const parsed = JSON.parse(raw) as { type: string; text?: string }
        if (parsed.type === 'silence' || !parsed.text) return null

        console.log('Insight surfaced:', parsed)

        this.insightCooldown = true
        setTimeout(() => { this.insightCooldown = false }, this.COOLDOWN_MS)

        return { type: parsed.type, text: parsed.text }

      } catch (err: any) {
        if (err?.status === 500 && attempt < 3) {
          const wait = 1000 * attempt
          console.log(`OpenAI 500, retrying in ${wait}ms (attempt ${attempt}/3)...`)
          await new Promise(r => setTimeout(r, wait))
          continue
        }
        console.error('Insight generation error:', err?.message ?? err)
        return null
      }
    }

    return null
  }

  onAudioChunkWithCallback(
    chunk: Buffer,
    isSpeaking: boolean,
    onInsight: (insight: { type: string; text: string }) => void
  ) {
    if (isSpeaking) {
      this.audioBuffer.push(chunk)
    } else if (this.audioBuffer.length > 0 && !this.processingAudio) {
      const toProcess = Buffer.concat(this.audioBuffer)
      this.audioBuffer = []
      this.processingAudio = true

      this.transcribe(toProcess).then(async (transcript) => {
        if (transcript) {
          this.memory.add(transcript)
          const insight = await this.generateInsight()
          if (insight) onInsight(insight as { type: string; text: string })
        }
        this.processingAudio = false
      }).catch(err => {
        console.error('Processing error:', err)
        this.processingAudio = false
      })
    }
  }

  clearMemory() {
    this.memory.clear()
    this.audioBuffer = []
    this.processingAudio = false
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
