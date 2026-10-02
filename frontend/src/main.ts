import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primeuix/themes/aura'
import Tooltip from 'primevue/tooltip'

import 'maplibre-gl/dist/maplibre-gl.css'
import 'primeicons/primeicons.css'
import './styles/theme.css'

import App from './App.vue'

createApp(App)
  .use(createPinia())
  .use(PrimeVue, {
    theme: {
      preset: Aura,
      options: {
        // PrimeVue follows the same [data-theme] switch as the CSS tokens, so one
        // toggle drives the whole page.
        darkModeSelector: '[data-theme="dark"]',
        cssLayer: { name: 'primevue', order: 'primevue' },
      },
    },
    ripple: false,
  })
  .directive('tooltip', Tooltip)
  .mount('#app')
