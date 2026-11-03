// Runs planSites off the main thread: thousands of terrain profiles would
// freeze the map for seconds.
import { planSites, type PlanInput } from './plan'

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<PlanInput>) => void) | null
  postMessage(message: unknown): void
}

ctx.onmessage = (e) => {
  try {
    const result = planSites(e.data, (step, done) => ctx.postMessage({ type: 'progress', step, done }))
    ctx.postMessage({ type: 'done', result })
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
