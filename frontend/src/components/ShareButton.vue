<script setup lang="ts">
import { useShare } from '@/composables/useShare'

const props = defineProps<{ title: string }>()
const { share, state } = useShare()
</script>

<template>
  <button
    class="share"
    type="button"
    :class="state"
    :title="state === 'failed' ? 'Copie impossible : copiez l’adresse de la page' : 'Copier le lien vers cette vue'"
    @click="share(props.title)"
  >
    <i class="pi" :class="state === 'copied' ? 'pi-check' : 'pi-link'" aria-hidden="true" />
    <span>{{ state === 'copied' ? 'Lien copié' : state === 'failed' ? 'Échec' : 'Partager' }}</span>
  </button>
  <!-- Announced to screen readers, since the visible label changes in place. -->
  <span class="sr-only" aria-live="polite">{{ state === 'copied' ? 'Lien copié' : '' }}</span>
</template>

<style scoped>
.share {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  background: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-secondary);
  font: inherit;
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}

.share:hover {
  background: var(--surface-2);
  color: var(--text-primary);
}

.share.copied {
  border-color: var(--status-good);
  color: var(--status-good);
}

.share .pi {
  font-size: 11px;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
