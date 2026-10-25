<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { Step } from '@/companion/recommend'

const props = defineProps<{
  nodeName: string
  steps: Step[]
  /** Where the node stands (commune, department, region), or null outside France. */
  area: string | null
  /** Runs one CLI command on the node and returns its reply. */
  run: (command: string) => Promise<string>
}>()

const emit = defineEmits<{ close: [] }>()

type State = 'pending' | 'running' | 'ok' | 'ko' | 'skipped'

const lines = ref(
  props.steps.map((s) => ({ ...s, enabled: true, state: 'pending' as State, reply: '' })),
)
const phase = ref<'review' | 'running' | 'done'>('review')
let stopRequested = false
const stop = () => (stopRequested = true)

/** Replies that mean the node did not take the command. */
const FAILED = /^\s*(err|error|unknown|\?\?)|not supported|not found|unable/i

const counts = computed(() => ({
  ok: lines.value.filter((l) => l.state === 'ok').length,
  ko: lines.value.filter((l) => l.state === 'ko').length,
  todo: lines.value.filter((l) => l.enabled).length,
}))

async function apply() {
  phase.value = 'running'
  stopRequested = false
  for (const l of lines.value) {
    if (stopRequested) break
    if (!l.enabled || !l.command.trim()) {
      l.state = 'skipped'
      continue
    }
    l.state = 'running'
    try {
      l.reply = (await props.run(l.command.trim())).trim() || 'OK'
      l.state = FAILED.test(l.reply) ? 'ko' : 'ok'
    } catch (e) {
      l.reply = e instanceof Error ? e.message : String(e)
      l.state = 'ko'
    }
  }
  for (const l of lines.value) if (l.state === 'pending') l.state = 'skipped'
  phase.value = 'done'
}

function close() {
  if (phase.value === 'running') return
  emit('close')
}

const mark: Record<State, string> = { pending: '·', running: '…', ok: '✓', ko: '✕', skipped: '–' }

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}
onMounted(() => document.addEventListener('keydown', onKey))
onUnmounted(() => document.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div class="backdrop" @click.self="close">
      <section class="sheet" role="dialog" aria-modal="true" :aria-label="`Réglages recommandés pour ${nodeName}`">
        <header>
          <h2>Réglages recommandés · {{ nodeName }}</h2>
          <button type="button" class="x" aria-label="Fermer" :disabled="phase === 'running'" @click="close">✕</button>
        </header>
        <p class="lead">
          Ces commandes vont être envoyées une à une au nœud, à travers le mesh.
          <template v-if="area">Arbre de régions établi d'après la position du nœud : <b>{{ area }}</b>.</template>
          <template v-else>Position du nœud hors de France ou introuvable : rien n'est proposé pour les régions.</template>
          Chaque ligne se décoche ou se modifie avant de lancer.
        </p>

        <ol class="script">
          <li v-for="(l, i) in lines" :key="i" :class="l.state">
            <span class="mark" aria-hidden="true">{{ mark[l.state] }}</span>
            <div class="body">
              <div class="cmd">
                <input
                  v-model="l.enabled"
                  type="checkbox"
                  :aria-label="`Inclure ${l.command}`"
                  :disabled="phase !== 'review'"
                />
                <input
                  v-model="l.command"
                  class="cmd-input"
                  spellcheck="false"
                  autocomplete="off"
                  :disabled="phase !== 'review' || !l.enabled"
                  :aria-label="`Commande ${i + 1}`"
                />
              </div>
              <small class="why">{{ l.why }}</small>
              <small v-if="l.reply" class="reply">{{ l.reply }}</small>
            </div>
          </li>
        </ol>

        <footer>
          <span v-if="phase !== 'review'" class="tally">
            <span class="ok">{{ counts.ok }} OK</span> · <span class="ko">{{ counts.ko }} KO</span>
          </span>
          <button v-if="phase === 'review'" type="button" class="apply" :disabled="!counts.todo" @click="apply">
            Appliquer {{ counts.todo }} commande{{ counts.todo > 1 ? 's' : '' }}
          </button>
          <button v-else-if="phase === 'running'" type="button" class="apply stop" @click="stop">
            Arrêter après la commande en cours
          </button>
          <button v-else type="button" class="apply" @click="emit('close')">Fermer</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgb(0 0 0 / 0.55);
}

/* A terminal: black whatever the theme, its colours fixed with it. */
.sheet {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(720px, 100%);
  max-height: min(86vh, 860px);
  padding: 18px 20px;
  background: #000;
  border: 1px solid #333;
  border-radius: 8px;
  color: #e6e6e6;
  color-scheme: dark;
  box-shadow: 0 12px 40px rgb(0 0 0 / 0.5);
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.x {
  background: none;
  border: 0;
  color: #8a8a8a;
  font-size: 15px;
  cursor: pointer;
}

.lead {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: #a8a8a8;
}

.lead b {
  color: #7db7ff;
}

.script {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
  font-family: var(--mono);
}

.script li {
  display: grid;
  grid-template-columns: 16px 1fr;
  gap: 8px;
  align-items: start;
}

.mark {
  padding-top: 4px;
  text-align: center;
  color: #6b6b6b;
}

li.running .mark {
  color: #7db7ff;
}

li.ok .mark {
  color: #6fd36f;
}

li.ko .mark {
  color: #ff7b7b;
}

li.skipped {
  opacity: 0.5;
}

.body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.cmd {
  display: flex;
  align-items: center;
  gap: 6px;
}

.cmd-input {
  flex: 1;
  min-width: 0;
  padding: 3px 6px;
  background: #0d0d0d;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  color: #7db7ff;
  font: inherit;
  font-size: 12.5px;
}

.cmd-input:disabled {
  border-color: transparent;
  background: transparent;
}

.why {
  font-family: var(--font);
  font-size: 11px;
  color: #8a8a8a;
}

.reply {
  font-size: 11.5px;
  color: #e6e6e6;
  overflow-wrap: anywhere;
}

li.ko .reply {
  color: #ff7b7b;
}

footer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding-top: 4px;
}

.tally {
  font-family: var(--mono);
  font-size: 12px;
}

.tally .ok {
  color: #6fd36f;
}

.tally .ko {
  color: #ff7b7b;
}

.apply {
  padding: 8px 22px;
  background: #2a78d6;
  border: 0;
  border-radius: 6px;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.apply.stop {
  background: #333;
}

.apply:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
