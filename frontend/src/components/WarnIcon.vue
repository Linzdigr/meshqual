<!-- The ⚠ sign drawn on the map beside 1-byte-hash nodes (warnImage in
     useMapLibre.ts), as inline SVG so the legend shows the exact same mark. -->
<template>
  <svg class="warn" viewBox="0 0 28 28" width="14" height="14" aria-hidden="true">
    <path d="M14 2.5 L26 24.5 L2 24.5 Z" fill="#fab219" stroke="#1a1a19" stroke-width="2.5" stroke-linejoin="round" />
    <rect x="12.6" y="9" width="2.8" height="8.5" fill="#1a1a19" />
    <rect x="12.6" y="19.5" width="2.8" height="2.8" fill="#1a1a19" />
  </svg>
</template>

<style scoped>
.warn {
  flex: none;
  vertical-align: -2px;
}
</style>
