// Voice Activity Detection — tuned for conversational speech
// Lower threshold = more sensitive = fewer missed words

const SILENCE_THRESHOLD = 150     // Lowered from 300 — catches quieter speech
const SPEECH_FRAMES_TO_TRIGGER = 2 // Faster trigger
const SILENCE_FRAMES_TO_STOP = 30  // ~1.5s of silence before we stop

export class VAD {
  private speechFrames = 0
  private silenceFrames = 0
  private _isSpeaking = false

  get isSpeaking(): boolean {
    return this._isSpeaking
  }

  process(pcmBuffer: Buffer): boolean {
    const rms = computeRMS(pcmBuffer)

    if (rms > SILENCE_THRESHOLD) {
      this.speechFrames++
      this.silenceFrames = 0
      if (!this._isSpeaking && this.speechFrames >= SPEECH_FRAMES_TO_TRIGGER) {
        this._isSpeaking = true
      }
    } else {
      this.silenceFrames++
      this.speechFrames = 0
      if (this._isSpeaking && this.silenceFrames >= SILENCE_FRAMES_TO_STOP) {
        this._isSpeaking = false
      }
    }

    return this._isSpeaking
  }

  reset() {
    this.speechFrames = 0
    this.silenceFrames = 0
    this._isSpeaking = false
  }
}

function computeRMS(buffer: Buffer): number {
  let sum = 0
  const samples = buffer.length / 2
  for (let i = 0; i < buffer.length - 1; i += 2) {
    const sample = buffer.readInt16LE(i)
    sum += sample * sample
  }
  return Math.sqrt(sum / samples)
}
