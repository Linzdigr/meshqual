<!-- The clock drawn on the map beside nodes whose clock is off (clockImage in
     map/clock.ts), as inline SVG so the legend shows the exact same mark. -->
<template>
  <svg class="clock" viewBox="0 0 28 28" width="14" height="14" aria-hidden="true">
    <circle cx="14" cy="14" r="11.5" fill="#ffffff" stroke="#1a1a19" stroke-width="2.5" />
    <path d="M14 14 L14 7 M14 14 L19 16.5" stroke="#1a1a19" stroke-width="2.4" stroke-linecap="round" fill="none" />
  </svg>
</template>

<style scoped>
.clock {
  flex: none;
  vertical-align: -2px;
}
</style>
