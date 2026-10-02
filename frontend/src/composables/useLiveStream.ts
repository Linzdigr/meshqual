import { onScopeDispose, ref, watch, type Ref } from 'vue'
import { api } from '@/api/client'
import type { Frame } from '@/api/types'

export interface LiveStreamOptions {
  /** Link to follow for the high-rate per-frame stream; null for map-wide only. */
  linkId: Ref<string | null>
  /** Called when the server reports links changed, debounced by the caller. */
  onLinksChanged: (linkIds: string[]) => void
  /** Called for each frame on the followed link. */
  onFrame: (linkId: string, frame: Frame) => void
}

/**
 * EventSource wrapper.
 *
 * SSE rather than polling: a 10s poll is both too slow to feel live and wasteful
 * when nothing moved. The server coalesces changes into one event per push
 * interval, so an idle mesh costs nothing and a busy one still sends one event.
 *
 * EventSource reconnects by itself, but it does NOT reconnect a connection the
 * browser froze on a backgrounded tab, and it keeps the socket open while the
 * tab is hidden. Both are handled here.
 */
export function useLiveStream(opts: LiveStreamOptions) {
  const connected = ref(false)
  const lastEventAt = ref<Date | null>(null)
  const reconnects = ref(0)

  let es: EventSource | null = null
  let stopped = false

  function close() {
    es?.close()
    es = null
    connected.value = false
  }

  function open() {
    if (stopped || document.hidden) return
    close()
    const source = new EventSource(api.streamUrl(opts.linkId.value))
    es = source

    source.addEventListener('open', () => {
      connected.value = true
    })

    source.addEventListener('hello', () => {
      connected.value = true
      lastEventAt.value = new Date()
    })

    source.addEventListener('links:changed', (ev) => {
      lastEventAt.value = new Date()
      try {
        const data = JSON.parse((ev as MessageEvent<string>).data) as { links: string[] }
        opts.onLinksChanged(data.links ?? [])
      } catch {
        // A malformed event is not worth tearing the stream down for.
      }
    })

    source.addEventListener('frame', (ev) => {
      lastEventAt.value = new Date()
      try {
        const data = JSON.parse((ev as MessageEvent<string>).data) as {
          linkId: string
          frame: Frame
        }
        if (data.linkId && data.frame) opts.onFrame(data.linkId, data.frame)
      } catch {
        // ignore
      }
    })

    source.addEventListener('error', () => {
      connected.value = false
      // EventSource retries on its own using the server's `retry:` hint. Only
      // count it, so the UI can show the stream is flapping.
      reconnects.value++
    })
  }

  // Changing the followed link means a new query string, so a new connection.
  watch(opts.linkId, () => open())

  function onVisibility() {
    if (document.hidden) {
      close()
    } else {
      open()
    }
  }
  document.addEventListener('visibilitychange', onVisibility)

  open()

  onScopeDispose(() => {
    stopped = true
    document.removeEventListener('visibilitychange', onVisibility)
    close()
  })

  return { connected, lastEventAt, reconnects }
}
