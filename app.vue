<template>
  <div class="min-h-screen bg-white flex flex-col">
    <SiteHeader />
    <main class="flex-grow">
      <HomeHero />
      <ProjectsList />
      <GetInvolved />
    </main>
    <SiteFooter />
  </div>
</template>

<script setup>
// Import components
import SiteHeader from '~/components/SiteHeader.vue'
import HomeHero from '~/components/HomeHero.vue'
import GetInvolved from '~/components/GetInvolved.vue'
import SiteFooter from '~/components/SiteFooter.vue'
</script>
