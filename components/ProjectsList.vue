<template>
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <!-- Header with Search and Filters -->
    <div class="mb-8">
      <h1 class="text-3xl font-bold text-gray-900 mb-6">Projects</h1>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="relative">
          <input
            type="text"
            v-model="searchQuery"
            placeholder="Search projects..."
            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <div class="relative">
          <select
            v-model="selectedStage"
            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
          >
            <option value="">All Stages</option>
            <option v-for="stage in stages" :key="stage" :value="stage">
              {{ stage }}
            </option>
          </select>
        </div>
      </div>
    </div>

    <!-- Loading and Error States -->
    <div v-if="pending" class="text-center py-12">
      <div class="inline-block animate-spin rounded-full h-8 w-8 border-4 border-gray-300 border-t-blue-600"></div>
      <p class="mt-2 text-gray-600">Loading projects...</p>
    </div>

    <div v-else-if="error" class="bg-red-50 border border-red-200 rounded-lg p-4">
      <p class="text-red-700">Error loading projects: {{ error.message }}</p>
    </div>

    <!-- Projects List -->
    <div v-else class="space-y-6">
      <div
        v-for="project in filteredProjects"
        :key="project.id"
        class="bg-white rounded-lg shadow-sm hover:shadow-md transition-shadow duration-200 overflow-hidden"
      >
        <div class="p-6">
          <div class="flex items-start justify-between">
            <div class="flex-1">
              <NuxtLink :to="`/projects/${project.handle}`" class="group block">
                <h2 class="text-xl font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">
                  {{ project.title }}
                </h2>
                <div class="mt-2 flex items-center space-x-2">
                  <span
                    :class="[
                      'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium',
                      stageClasses[project.stage] || 'bg-gray-100 text-gray-800'
                    ]"
                  >
                    {{ project.stage }}
                  </span>
                  <span class="text-gray-500 text-sm">
                    Last updated: {{ formatDate(project.modified_at) }}
                  </span>
                </div>
              </NuxtLink>
            </div>
            <div class="flex space-x-3">
              <a
                v-if="project.developers_url"
                :href="project.developers_url"
                target="_blank"
                class="text-gray-600 hover:text-gray-900"
                title="View on GitHub"
              >
                <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.73.083-.73 1.205.085 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.605-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12"/>
                </svg>
              </a>
              <a
                v-if="project.chat_channel"
                :href="`https://codeforphilly.org/chat/${project.chat_channel}`"
                target="_blank"
                class="text-gray-600 hover:text-gray-900"
                title="Join Chat"
              >
                <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </a>
            </div>
          </div>

          <p class="mt-4 text-gray-600 line-clamp-3">{{ project.readme }}</p>

          <div class="mt-4 flex flex-wrap gap-2">
            <span
              v-for="tag in project.tags"
              :key="tag.id"
              class="inline-flex items-center px-2.5 py-0.5 rounded-md text-sm font-medium bg-blue-50 text-blue-700"
            >
              {{ tag.title }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Project, ProjectWithTags, Tag, Database } from '~/types/supabase'

const searchQuery = ref('')
const selectedStage = ref('')

const stages = [
  'Hibernating',
  'Prototyping',
  'Commenting',
  'Testing',
  'Maintaining',
  'Drifting'
]

const stageClasses = {
  'Hibernating': 'bg-gray-100 text-gray-800',
  'Prototyping': 'bg-blue-100 text-blue-800',
  'Commenting': 'bg-green-100 text-green-800',
  'Testing': 'bg-yellow-100 text-yellow-800',
  'Maintaining': 'bg-purple-100 text-purple-800',
  'Drifting': 'bg-red-100 text-red-800'
}

const formatDate = (dateString: string | null) => {
  if (!dateString) return 'N/A'
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

const { data: projects, pending, error } = await useLazyAsyncData<ProjectWithTags[]>('all-projects', async () => {
  const client = useSupabaseClient<Database>()
  const { data, error } = await client
    .from('projects')
    .select(`
      *,
      project_tags (
        tags (
          id,
          title,
          class
        )
      )
    `)
    .order('modified_at', { ascending: false })

  if (error) {
    throw error
  }

  return data?.map((project: Project & { project_tags: { tags: Tag }[] }) => ({
    ...project,
    tags: project.project_tags
      ?.map(pt => pt.tags)
      .filter((tag): tag is Tag => tag.class === 'tech') || []
  }))
})

const filteredProjects = computed(() => {
  if (!projects.value) return []

  return projects.value.filter((project: ProjectWithTags) => {
    const matchesSearch = !searchQuery.value ||
      project.title.toLowerCase().includes(searchQuery.value.toLowerCase()) ||
      project.readme?.toLowerCase().includes(searchQuery.value.toLowerCase())

    const matchesStage = !selectedStage.value ||
      project.stage === selectedStage.value

    return matchesSearch && matchesStage
  })
})
</script>

<style scoped>
.line-clamp-3 {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
