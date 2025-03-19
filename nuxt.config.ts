// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  devtools: { enabled: true },

  modules: ['@nuxt/ui', '@nuxt/eslint', '@nuxtjs/supabase'],

  css: ['~/assets/css/main.css'],

  ssr: true,

  future: {
    compatibilityVersion: 4
  },

  compatibilityDate: '2024-11-27',

  tailwindcss: {
    exposeConfig: true,
    viewer: true,
  },

  supabase: {
    redirect: false
  },

  vue: {
      transformAssetUrls: {
        track: ['src']
      }
  },
})