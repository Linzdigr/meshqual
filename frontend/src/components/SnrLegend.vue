<script setup lang="ts">
import { computed } from 'vue'
import { snrBuckets, type SnrPalette } from '@/styles/scale'
import type { LinkKind } from '@/api/types'
import type { ViewMode } from '@/map/lanes'
import WarnIcon from './WarnIcon.vue'

const props = defineProps<{
  thresholds: number[]
  kinds: LinkKind[]
  counts: Record<LinkKind, number>
  mode: ViewMode
  asymOnly: boolean
  asymCount: number
  asymThreshold: number
  palette: SnrPalette
  functionalCount: number
  oneByteHashCount: number
  /** Narrow screens only: whether the details under the mode switch are shown. */
  open: boolean
}>()

const emit = defineEmits<{
  toggle: [LinkKind]
  setMode: [ViewMode]
  toggleAsymOnly: []
  setPalette: [SnrPalette]
  'update:open': [boolean]
}>()

const palettes: { id: SnrPalette; label: string; hint: string }[] = [
  { id: 'blue', label: 'Bleu', hint: 'Une teinte : lisible quelle que soit la vision des couleurs' },
  { id: 'traffic', label: 'Rouge → vert', hint: 'Rouge pour un signal faible, vert pour un signal fort' },
]

const modes: { id: ViewMode; label: string; hint: string }[] = [
  { id: 'quality', label: 'Qualité', hint: 'Une ligne par lien, sens à plus faible SNR retenu.' },
  { id: 'asymmetry', label: 'Par sens', hint: 'Une voie par sens, chacune avec son propre SNR médian.' },
  { id: 'functional', label: 'Fonctionnel', hint: 'Liens considérés utilisables uniquement.' },
]

const ramp = ['var(--snr-1)', 'var(--snr-2)', 'var(--snr-3)', 'var(--snr-4)']

// Strongest first. Each bucket keeps its ramp colour, so the order can change
// without the swatches drifting off the map's colours.
const buckets = computed(() =>
  snrBuckets(props.thresholds)
    .map((b, i) => ({ ...b, color: ramp[i] }))
    .reverse(),
)

const topologyOn = computed(() => props.kinds.includes('topology'))
</script>

<template>
  <div class="legend" :class="{ open }">
    <div class="head">
      <div class="modes" role="radiogroup" aria-label="Représentation des liens">
        <button
          v-for="m in modes"
          :key="m.id"
          type="button"
          role="radio"
          :aria-checked="mode === m.id"
          :class="{ on: mode === m.id }"
          :title="m.hint"
          @click="emit('setMode', m.id)"
        >
          {{ m.label }}
        </button>
      </div>
      <button
        class="fold"
        type="button"
        :aria-expanded="open"
        aria-controls="legend-details"
        :aria-label="open ? 'Masquer la légende' : 'Afficher la légende'"
        @click="emit('update:open', !open)"
      >
        <i class="pi" :class="open ? 'pi-chevron-up' : 'pi-list'" aria-hidden="true" />
      </button>
    </div>

    <!-- On a narrow screen only the mode switch stays up; the rest folds. -->
    <div id="legend-details" class="details">
      <div v-if="mode === 'functional'" class="block">
        <h3>Liens fonctionnels</h3>
        <p class="functional">
          <span class="line" aria-hidden="true" />
          <span>Les deux sens mesurés, chacun ≥ {{ thresholds[1] }} dB</span>
          <span class="mono count">{{ functionalCount }}</span>
        </p>
        <p class="caveat">
          Masqués : les liens plus faibles, ceux mesurés dans un seul sens (rien ne dit que le
          retour passe) et les liens topologiques, sans mesure.
        </p>
      </div>

      <div v-else class="block">
        <h3>{{ mode === 'asymmetry' ? 'SNR médian par sens' : 'SNR — sens le plus faible' }}</h3>
        <div class="palettes" role="radiogroup" aria-label="Palette SNR">
          <button
            v-for="p in palettes"
            :key="p.id"
            type="button"
            role="radio"
            :aria-checked="palette === p.id"
            :class="{ on: palette === p.id }"
            :title="p.hint"
            @click="emit('setPalette', p.id)"
          >
            {{ p.label }}
          </button>
        </div>
        <!-- The ramp is ordinal, so every step carries its dB range: the colour is
             an ordering, not a readable value. -->
        <ul class="ramp">
          <li v-for="b in buckets" :key="b.label">
            <span class="swatch" :style="{ background: b.color }" aria-hidden="true" />
            <span class="mono range">{{ b.label }}</span>
            <span class="note">{{ b.note }}</span>
          </li>
        </ul>
      </div>

      <div v-if="mode === 'asymmetry'" class="block">
        <h3>Voies par sens</h3>
        <ul class="lanes">
          <li>
            <span class="lane pair" aria-hidden="true" />
            <span>une voie par sens, à droite du sens de circulation</span>
          </li>
          <li>
            <span class="lane missing" aria-hidden="true" />
            <span>sens non mesuré</span>
          </li>
        </ul>
        <label class="only">
          <input type="checkbox" :checked="asymOnly" @change="emit('toggleAsymOnly')" />
          <span>Liens déséquilibrés seulement</span>
          <span class="mono count">{{ asymCount }}</span>
        </label>
        <p class="caveat">
          Déséquilibré : les deux sens sont mesurés et leurs SNR diffèrent d'au moins
          {{ asymThreshold }} dB. La case masque tous les autres liens.
        </p>
      </div>

      <div class="block">
      </div>

      <div class="block">
      <p class="hashwarn" title="Ces nœuds émettent des hashs de chemin sur 1 octet : 256 valeurs seulement, d'où des collisions qui empêchent d'attribuer les sauts.">
        <WarnIcon />
        <span>Nœud en hash de chemin 1 octet</span>
        <span class="mono count">{{ oneByteHashCount }}</span>
      </p>
      <p class="caveat">
        Lu dans leurs annonces relayées. Sur 1 octet, les hashs se confondent souvent : passer le
        nœud en 2 octets (<code>set path.hash.mode 1</code>) evite ces collisions.
      </p>
    </div>

    <!-- Measured and trace links are coloured by SNR above; only topology links
           have a look of their own, so only they get a row (and a toggle). -->
      <div v-if="mode !== 'functional'" class="block">
        <ul class="kinds">
          <li>
            <button
              type="button"
              :class="{ off: !topologyOn }"
              :aria-pressed="topologyOn"
              title="Afficher ou masquer les liens sans mesure de signal"
              @click="emit('toggle', 'topology')"
            >
              <span class="mark topology" aria-hidden="true" />
              <span class="label">Liens topologiques</span>
              <span class="mono count">{{ counts.topology ?? 0 }}</span>
            </button>
          </li>
        </ul>
        <p class="caveat">
          Un lien topologique prouve que les deux relais s'entendent, mais le champ
          <code>path</code> ne transporte que des hashs de routage : aucun SNR connu pour le moment.
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.legend {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 12px;
  background: color-mix(in srgb, var(--surface-1) 94%, transparent);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  backdrop-filter: blur(6px);
  max-width: 290px;
}

.head {
  display: flex;
  align-items: stretch;
  gap: 6px;
}

.head .modes {
  flex: 1;
}

.details {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* The fold button exists for narrow screens only. */
.fold {
  display: none;
  align-items: center;
  justify-content: center;
  width: 34px;
  padding: 0;
  background: var(--surface-2);
  border: 0;
  border-radius: 5px;
  color: var(--text-secondary);
  cursor: pointer;
}

@media (max-width: 760px) {
  /* Capped here, not on the overlay: a percentage of an auto-height parent is ignored. */
  .legend {
    max-width: none;
    max-height: 45vh;
    max-height: 45dvh;
    overflow-y: auto;
    padding: 8px;
  }

  .fold {
    display: inline-flex;
  }

  .details {
    display: none;
  }

  .legend.open .details {
    display: flex;
  }
}

h3 {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.ramp li {
  display: grid;
  grid-template-columns: 14px auto 1fr;
  align-items: center;
  gap: 8px;
}

.swatch {
  width: 14px;
  height: 10px;
  border-radius: 2px;
  /* A 2px surface ring keeps adjacent swatches from touching. */
  box-shadow: 0 0 0 1px var(--surface-1);
}

.range {
  font-size: 11px;
  color: var(--text-primary);
  white-space: nowrap;
}

.note {
  font-size: 11px;
  color: var(--text-muted);
}

.kinds button {
  display: grid;
  grid-template-columns: 22px 1fr auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 3px 4px;
  background: none;
  border: 0;
  border-radius: 4px;
  color: var(--text-primary);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.kinds button:hover {
  background: var(--surface-2);
}

.kinds button.off {
  opacity: 0.4;
}

.mark {
  height: 0;
  border-top-width: 2px;
  border-top-style: solid;
}

.mark.topology {
  border-top-color: var(--no-data);
  border-top-style: dashed;
}

.count {
  font-size: 11px;
  color: var(--text-muted);
}

.modes {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 2px;
  padding: 2px;
  background: var(--surface-2);
  border-radius: 5px;
}

.modes button {
  padding: 4px 2px;
  background: none;
  border: 0;
  border-radius: 4px;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.functional {
  display: grid;
  grid-template-columns: 22px 1fr auto;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 12px;
  color: var(--text-primary);
}

.functional .line {
  border-top: 3px solid var(--functional);
}

.hashwarn {
  display: grid;
  grid-template-columns: 22px 1fr auto;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 12px;
  color: var(--text-primary);
}

.hashwarn .warn {
  justify-self: center;
}

.palettes {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
}

.palettes button {
  padding: 2px 8px;
  background: none;
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text-secondary);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.palettes button.on {
  border-color: var(--text-secondary);
  color: var(--text-primary);
}

.modes button.on {
  background: var(--surface-0);
  color: var(--text-primary);
  box-shadow: 0 0 0 1px var(--border);
}

.lanes li {
  display: grid;
  grid-template-columns: 22px 1fr;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-secondary);
}

.lane.pair {
  height: 7px;
  border-top: 3px solid var(--snr-4);
  border-bottom: 3px solid var(--snr-1);
}

.lane.missing {
  border-top: 1px dashed var(--no-data);
}

.only {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-primary);
  cursor: pointer;
}

.caveat {
  margin: 8px 0 0;
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--text-muted);
}

code {
  font-family: var(--mono);
  font-size: 10px;
}
</style>
