<template>
  <div class="min-h-screen bg-gray-50 py-16">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="text-center">
        <h1 class="text-4xl font-bold text-gray-900 mb-4">Coming Soon</h1>
        <p class="text-xl text-gray-600 mb-8">
          The {{ route.params.page.replace(/-/g, ' ') }} page is under development.
        </p>
        <NuxtLink
          to="/"
          class="inline-flex items-center px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
        >
          <i class="bi bi-arrow-left mr-2"></i>
          Return Home
        </NuxtLink>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const route = useRoute()
</script>
