<template>
  <div class="max-w-6xl mx-auto px-4 py-12">
    <h2 class="text-3xl font-bold text-center mb-12">JOIN A PROJECT</h2>

    <!-- Loading and Error States -->
    <div v-if="pending" class="text-center py-12">
      <div class="inline-block animate-spin rounded-full h-8 w-8 border-4 border-gray-300 border-t-blue-600"></div>
      <p class="mt-2 text-gray-600">Loading projects...</p>
    </div>

    <div v-else-if="error" class="bg-red-50 border border-red-200 rounded-lg p-4">
      <p class="text-red-700">Error loading projects: {{ error.message }}</p>
    </div>

    <!-- Projects Grid -->
    <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
      <div v-for="project in projects" :key="project.id"
           class="bg-white rounded-lg shadow-sm hover:shadow-md transition-shadow overflow-hidden">
        <!-- Project Logo/Image -->
        <div class="h-48 bg-gray-100 flex items-center justify-center p-4">
          <img v-if="project.logo_url" :src="project.logo_url" :alt="project.title" class="max-h-full">
          <div v-else class="text-gray-400 text-xl">{{ project.title }}</div>
        </div>

        <!-- Project Info -->
        <div class="p-4">
          <h3 class="font-bold text-lg mb-2">{{ project.title }}</h3>
          <p class="text-gray-600 text-sm mb-4 line-clamp-2">{{ project.readme }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Project, Database } from '~/types/supabase'
const { data: projects, pending, error } = await useLazyAsyncData<Project[]>('projects', async () => {
  const client = useSupabaseClient<Database>()
  const { data, error } = await client
    .from('projects')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) {
    throw error
  }

  return data
})
</script>
