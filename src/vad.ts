// Simple energy-based Voice Activity Detection
// Prevents sending silence to Whisper, saving cost and battery

const SILENCE_THRESHOLD = 300      // RMS below this = silence
const SPEECH_FRAMES_TO_TRIGGER = 3 // Consecutive loud frames before we consider it speech
const SILENCE_FRAMES_TO_STOP = 40  // Consecutive silent frames before we stop

export class VAD {
  private speechFrames = 0
  private silenceFrames = 0
  private _isSpeaking = false

  get isSpeaking(): boolean {
    return this._isSpeaking
  }

  // Returns true if this chunk should be forwarded to transcription
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
  // PCM 16-bit signed little-endian
  let sum = 0
  const samples = buffer.length / 2
  for (let i = 0; i < buffer.length - 1; i += 2) {
    const sample = buffer.readInt16LE(i)
    sum += sample * sample
  }
  return Math.sqrt(sum / samples)
}
