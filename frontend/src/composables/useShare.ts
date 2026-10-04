import { onScopeDispose, ref } from 'vue'

/**
 * Shares the current page URL, which App keeps in sync with the selection
 * (?link= or ?node=). Touch devices get the native share sheet; elsewhere the
 * URL goes to the clipboard and `state` reports it for a moment.
 */
export function useShare() {
  const state = ref<'idle' | 'copied' | 'failed'>('idle')
  let timer: number | undefined

  async function share(title: string) {
    const url = window.location.href
    try {
      if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
        await navigator.share({ title, url })
        return
      }
      if (navigator.clipboard) await navigator.clipboard.writeText(url)
      else if (!legacyCopy(url)) throw new Error('copy refused')
      state.value = 'copied'
    } catch (e) {
      // The user closed the share sheet: nothing to report.
      if (e instanceof DOMException && e.name === 'AbortError') return
      state.value = 'failed'
    }
    window.clearTimeout(timer)
    timer = window.setTimeout(() => (state.value = 'idle'), 2000)
  }

  onScopeDispose(() => window.clearTimeout(timer))
  return { share, state }
}

/**
 * The Clipboard API only exists in secure contexts (HTTPS or localhost). On a
 * plain-HTTP LAN address, fall back to selecting a hidden field and copying it.
 */
function legacyCopy(text: string): boolean {
  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.opacity = '0'
  document.body.appendChild(field)
  field.select()
  try {
    return document.execCommand('copy')
  } finally {
    field.remove()
  }
}
