// Maintains a rolling window of conversation context
// Sent to GPT with each insight request so it understands the full conversation arc

export interface Turn {
  role: 'user'
  content: string
  timestamp: number
}

const MAX_TURNS = 30          // Keep last 30 transcript turns
const MAX_CHARS = 6000        // Hard cap on total context size

export class ConversationMemory {
  private turns: Turn[] = []

  add(transcript: string) {
    if (!transcript.trim()) return
    this.turns.push({
      role: 'user',
      content: transcript.trim(),
      timestamp: Date.now(),
    })
    this.prune()
  }

  // Returns the conversation as a single formatted string for the GPT prompt
  getContext(): string {
    if (this.turns.length === 0) return ''
    return this.turns
      .map(t => t.content)
      .join('\n')
  }

  // Returns conversation as GPT message array
  getMessages(): Array<{ role: 'user'; content: string }> {
    return this.turns.map(t => ({ role: t.role, content: t.content }))
  }

  clear() {
    this.turns = []
  }

  private prune() {
    // Trim by count
    if (this.turns.length > MAX_TURNS) {
      this.turns = this.turns.slice(-MAX_TURNS)
    }
    // Trim by total character count (keep most recent)
    while (this.getContext().length > MAX_CHARS && this.turns.length > 1) {
      this.turns.shift()
    }
  }
}
