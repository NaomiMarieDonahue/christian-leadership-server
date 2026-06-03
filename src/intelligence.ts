import OpenAI from 'openai'
import { Readable } from 'stream'
import { SYSTEM_PROMPT } from './prompt.js'
import { ConversationMemory } from './memory.js'

// Always fetch the latest available GPT-4 model at startup
// Override via OPENAI_MODEL env variable when a new model drops
let resolvedModel: string | null = null

async function getLatestModel(client: OpenAI): Promise<string> {
  // Allow manual override via env (update this when new models release)
  if (process.env.OPENAI_MODEL) {
    console.log(`Using model override: ${process.env.OPENAI_MODEL}`)
    return process.env.OPENAI_MODEL
  }

  try {
    const models = await client.models.list()
    // Find the most capable GPT-4 class model available
    const gpt4Models = models.data
      .filter(m => m.id.startsWith('gpt-4') || m.id.startsWith('o1') || m.id.startsWith('o3'))
      .map(m => m.id)
      .sort()
      .reverse()

    // Prefer: o3 > gpt-4o > gpt-4-turbo > gpt-4
    const preferred = [
      'o3', 'o3-mini',
      'gpt-4o', 'gpt-4o-mini',
      'gpt-4-turbo', 'gpt-4',
    ]

    for (const prefix of preferred) {
      const match = gpt4Models.find(m => m.startsWith(prefix))
      if (match) {
        console.log(`Auto-selected model: ${match}`)
        return match
      }
    }
  } catch (err) {
    console.warn('Could not fetch model list, falling back to gpt-4o:', err)
  }

  return 'gpt-4o'
}

export class IntelligenceEngine {
  private client: OpenAI
  private memory: ConversationMemory
  private audioBuffer: Buffer[] = []
  private processingAudio = false
  private insightCooldown = false
  private readonly COOLDOWN_MS = 8000  // Min 8s between insights (prevents firehose)

  constructor() {
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    this.memory = new ConversationMemory()
  }

  async initialize() {
    resolvedModel = await getLatestModel(this.client)
  }

  // Called with raw PCM chunks from the glasses mic
  addAudioChunk(chunk: Buffer, isSpeaking: boolean) {
    if (isSpeaking) {
      this.audioBuffer.push(chunk)
    } else if (this.audioBuffer.length > 0 && !this.processingAudio) {
      // Speech just ended — process what we have
      const toProcess = Buffer.concat(this.audioBuffer)
      this.audioBuffer = []
      this.processAudio(toProcess).catch(console.error)
    }
  }

  private async processAudio(pcmData: Buffer) {
    if (this.processingAudio) return
    this.processingAudio = true

    try {
      const transcript = await this.transcribe(pcmData)
      if (transcript) {
        this.memory.add(transcript)
        const insight = await this.generateInsight()
        this.processingAudio = false
        return insight
      }
    } catch (err) {
      console.error('Audio processing error:', err)
    }

    this.processingAudio = false
    return null
  }

  private async transcribe(pcmData: Buffer): Promise<string | null> {
    try {
      // Whisper expects a file-like object — wrap PCM as WAV
      const wavBuffer = pcmToWav(pcmData, 16000, 1, 16)
      const file = new File([wavBuffer], 'audio.wav', { type: 'audio/wav' })

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
    if (!resolvedModel) return null

    const context = this.memory.getContext()
    if (!context) return null

    try {
      const response = await this.client.chat.completions.create({
        model: resolvedModel,
        max_tokens: 120,
        temperature: 0.7,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Conversation so far:\n\n${context}\n\nSurface an insight if warranted. JSON only.`,
          },
        ],
      })

      const raw = response.choices[0]?.message?.content?.trim()
      if (!raw) return null

      const parsed = JSON.parse(raw) as { type: string; text?: string }
      if (parsed.type === 'silence' || !parsed.text) return null

      console.log('Insight:', parsed)

      // Enforce cooldown
      this.insightCooldown = true
      setTimeout(() => { this.insightCooldown = false }, this.COOLDOWN_MS)

      return { type: parsed.type, text: parsed.text }
    } catch (err) {
      console.error('Insight generation error:', err)
      return null
    }
  }

  getSavedInsights() {
    return [] // Populated by server from client save messages
  }

  clearMemory() {
    this.memory.clear()
    this.audioBuffer = []
  }

  // Allow external callers to hook into audio processing results
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
}

// ─── PCM → WAV conversion ─────────────────────────────────────────────────────
function pcmToWav(pcm: Buffer, sampleRate: number, channels: number, bitDepth: number): Buffer {
  const dataSize = pcm.length
  const header = Buffer.alloc(44)

  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)              // PCM chunk size
  header.writeUInt16LE(1, 20)               // PCM format
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * (bitDepth / 8), 28)
  header.writeUInt16LE(channels * (bitDepth / 8), 32)
  header.writeUInt16LE(bitDepth, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)

  return Buffer.concat([header, pcm])
}
