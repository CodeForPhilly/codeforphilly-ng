<template>
  <div class="min-h-screen bg-gray-50 py-16">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="text-center">
        <h1 class="text-4xl font-bold text-gray-900 mb-4">Coming Soon</h1>
        <p class="text-xl text-gray-600 mb-8">
          The {{ pageName }} page is under development.
        </p>
        <UButton
          to="/"
          icon="i-lucide-arrow-left"
          label="Return Home"
          color="primary"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const route = useRoute()
const pageName = computed(() => {
  const page = route.params.page as string
  return page.replace(/-/g, ' ')
})
</script>
