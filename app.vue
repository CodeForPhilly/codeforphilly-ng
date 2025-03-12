<template>
  <div class="min-h-screen bg-white">
    <SiteHeader />
    <main>
      <HomeHero />
      <ProjectsList />
      <GetInvolved />
    </main>
  </div>
</template>

<script setup>
// Import components
import SiteHeader from '~/components/SiteHeader.vue'
import HomeHero from '~/components/HomeHero.vue'
import GetInvolved from '~/components/GetInvolved.vue'
</script>
