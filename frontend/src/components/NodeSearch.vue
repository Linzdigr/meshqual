<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { api } from '@/api/client'
import type { NodeSearchHit } from '@/api/types'

const emit = defineEmits<{ select: [NodeSearchHit] }>()

const typeLabel: Record<string, string> = {
  repeater: 'Répéteur',
  companion: 'Compagnon',
  room: 'Room server',
  sensor: 'Capteur',
  none: 'Inconnu',
}

const input = ref<HTMLInputElement | null>(null)
const query = ref('')
const hits = ref<NodeSearchHit[]>([])
const active = ref(0)
const open = ref(false)
const searching = ref(false)
/** The query the shown hits answer, so "aucun nœud" does not flash while typing. */
const answered = ref('')

/** The server searches every node: the map only loads those in view. */
const MIN_CHARS = 2
const DEBOUNCE_MS = 180
let timer: number | undefined
let ac: AbortController | null = null

watch(query, (q) => {
  window.clearTimeout(timer)
  ac?.abort()
  const t = q.trim()
  if (t.length < MIN_CHARS) {
    hits.value = []
    answered.value = ''
    searching.value = false
    return
  }
  searching.value = true
  timer = window.setTimeout(async () => {
    ac = new AbortController()
    try {
      const r = await api.searchNodes(t, ac.signal)
      hits.value = r.nodes
      answered.value = t
      active.value = 0
      open.value = true
    } catch {
      // Aborted by the next keystroke, or the server is away: keep what is shown.
    } finally {
      searching.value = false
    }
  }, DEBOUNCE_MS)
})

const empty = computed(() => open.value && !searching.value && answered.value !== '' && hits.value.length === 0)

function choose(h: NodeSearchHit | undefined) {
  if (!h) return
  emit('select', h)
  open.value = false
  query.value = ''
  input.value?.blur()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!hits.value.length) return
    e.preventDefault()
    open.value = true
    const n = hits.value.length
    active.value = (active.value + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
  } else if (e.key === 'Enter') {
    e.preventDefault()
    choose(hits.value[active.value])
  } else if (e.key === 'Escape') {
    if (query.value) query.value = ''
    else input.value?.blur()
    open.value = false
  }
}

// "/" jumps to the field, unless a key is being typed somewhere.
function onGlobalKey(e: KeyboardEvent) {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
  const t = e.target as HTMLElement | null
  if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return
  e.preventDefault()
  input.value?.focus()
}
onMounted(() => window.addEventListener('keydown', onGlobalKey))
onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKey)
  window.clearTimeout(timer)
  ac?.abort()
})
</script>

<template>
  <div class="search">
    <i class="pi" :class="searching ? 'pi-spin pi-spinner' : 'pi-search'" aria-hidden="true" />
    <input
      ref="input"
      v-model="query"
      type="search"
      placeholder="Rechercher un nœud"
      aria-label="Rechercher un nœud par nom ou clé"
      title="Nom ou début de clé publique (raccourci : /)"
      autocomplete="off"
      spellcheck="false"
      role="combobox"
      aria-controls="node-search-list"
      :aria-expanded="open && hits.length > 0"
      :aria-activedescendant="open && hits.length ? `node-hit-${active}` : undefined"
      @keydown="onKeydown"
      @focus="open = hits.length > 0"
      @blur="open = false"
    />
    <ul v-if="open && hits.length" id="node-search-list" class="list" role="listbox">
      <li
        v-for="(h, i) in hits"
        :id="`node-hit-${i}`"
        :key="h.key"
        role="option"
        :aria-selected="i === active"
        :class="{ active: i === active }"
        @mousedown.prevent="choose(h)"
        @mousemove="active = i"
      >
        <span class="name">{{ h.name || h.key.slice(0, 8) }}</span>
        <span class="meta">
          {{ typeLabel[h.nodeType] ?? h.nodeType }}<template v-if="h.listenOnly"> · écoute seule</template
          ><template v-if="h.regionName"> · {{ h.regionName }}</template>
          · <span class="mono">{{ h.key.slice(0, 4) }}</span>
        </span>
      </li>
    </ul>
    <p v-else-if="empty" class="list none" role="status">Aucun nœud sur la carte pour « {{ answered }} »</p>
  </div>
</template>

<style scoped>
.search {
  position: relative;
  display: flex;
  align-items: center;
  flex: 0 1 240px;
  min-width: 140px;
}

@media (max-width: 760px) {
  .search {
    flex: 1 1 auto;
    min-width: 0;
  }
}

.search > .pi {
  position: absolute;
  left: 8px;
  font-size: 10.5px;
  color: var(--text-muted);
  pointer-events: none;
}

input {
  width: 100%;
  padding: 4px 8px 4px 25px;
  background: var(--surface-0);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text-primary);
  font: inherit;
  font-size: 11.5px;
}

input:focus {
  outline: none;
  border-color: var(--accent);
}

.list {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 20;
  width: max(100%, 280px);
  margin: 0;
  padding: 4px;
  list-style: none;
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 6px 20px rgb(0 0 0 / 0.18);
}

li {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 5px 8px;
  border-radius: 4px;
  cursor: pointer;
}

li.active {
  background: var(--surface-2);
}

.name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.meta {
  font-size: 10.5px;
  color: var(--text-secondary);
}

.mono {
  font-family: var(--mono);
}

.none {
  padding: 8px 10px;
  font-size: 11px;
  color: var(--text-secondary);
}
</style>
