// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxtjs/supabase',
    '@nuxtjs/tailwindcss'
  ],

  ssr: true,

  supabase: {
    redirect: false
  },

  tailwindcss: {
    exposeConfig: true,
    viewer: true,
  },

  compatibilityDate: '2025-03-11',

  vue: {
      transformAssetUrls: {
        track: ['src']
      }
  }
})
