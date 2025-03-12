<template>
  <div class="min-h-screen bg-white flex flex-col">
    <SiteHeader />
    <main class="flex-grow">
      <NuxtPage />
    </main>
    <SiteFooter />
  </div>
</template>

<script setup>
// Import components
import SiteHeader from '~/components/SiteHeader.vue'
import SiteFooter from '~/components/SiteFooter.vue'
</script>
