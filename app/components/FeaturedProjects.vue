<template>
  <UContainer class="py-12">
    <h2 class="text-3xl font-bold text-center mb-12">
      JOIN A PROJECT
    </h2>

    <!-- Loading and Error States -->
    <div v-if="pending" class="text-center py-12">
      <UProgress class="mx-auto" indeterminate />
      <p class="mt-2 text-gray-600">Loading projects...</p>
    </div>

    <UAlert
      v-else-if="error"
      color="error"
      :title="error?.message || 'An error occurred'"
      icon="i-lucide-alert-triangle"
    />

    <!-- Projects Grid -->
    <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
      <NuxtLink v-for="project in projects" :key="project.id"
                :to="`/projects/${project.handle}`"
                class="group">
        <UCard class="h-full hover:shadow-md transition-all duration-200">
          <!-- Project Title Banner -->
          <div class="h-48 bg-gray-100 flex items-center justify-center p-4">
            <span class="text-xl text-gray-600">
              {{ project.title }}
            </span>
          </div>

          <!-- Project Info -->
          <div class="p-4">
            <h3 class="font-bold text-lg mb-2 group-hover:text-(--ui-primary) transition-colors">
              {{ project.title }}
            </h3>
            <p class="text-sm mb-4 line-clamp-2 text-gray-600">
              {{ project.readme }}
            </p>
          </div>
        </UCard>
      </NuxtLink>
    </div>
  </UContainer>
</template>

<script setup lang="ts">
import type { Project, Database } from '~/types/supabase'

// Initialize refs
const projects = ref<Project[]>([])
const pending = ref(true)
const error = ref<Error | null>(null)

// Fetch data
onMounted(async () => {
  try {
    const client = useSupabaseClient<Database>()
    const { data, error: supabaseError } = await client
      .from('projects')
      .select('*')
      .order('created_at', { ascending: false })

    if (supabaseError) throw supabaseError
    if (!data) throw new Error('No data returned')

    projects.value = data
  } catch (e) {
    error.value = e instanceof Error ? e : new Error('An error occurred')
  } finally {
    pending.value = false
  }
})
</script>
