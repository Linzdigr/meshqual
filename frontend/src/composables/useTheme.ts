import { onScopeDispose, ref, watch } from 'vue'

type Mode = 'auto' | 'light' | 'dark'
const KEY = 'meshqual.theme'

/**
 * Theme switch. The map needs to know which mode is active because its dark
 * ramp is a separate set of validated steps, not a filter over the light one.
 */
export function useTheme() {
  const mode = ref<Mode>(read())
  const dark = ref(resolve(mode.value))

  const mq = window.matchMedia('(prefers-color-scheme: dark)')

  function apply() {
    dark.value = resolve(mode.value)
    const root = document.documentElement
    if (mode.value === 'auto') {
      root.removeAttribute('data-theme')
    } else {
      root.setAttribute('data-theme', mode.value)
    }
  }

  function onSystemChange() {
    if (mode.value === 'auto') apply()
  }

  mq.addEventListener('change', onSystemChange)
  watch(mode, () => {
    try {
      localStorage.setItem(KEY, mode.value)
    } catch {
      // Private mode or blocked storage: the preference just does not persist.
    }
    apply()
  })
  apply()

  onScopeDispose(() => mq.removeEventListener('change', onSystemChange))

  function cycle() {
    mode.value = mode.value === 'auto' ? 'light' : mode.value === 'light' ? 'dark' : 'auto'
  }

  return { mode, dark, cycle }
}

function read(): Mode {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'auto') return v
  } catch {
    // ignore
  }
  return 'auto'
}

function resolve(mode: Mode): boolean {
  if (mode === 'dark') return true
  if (mode === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}
