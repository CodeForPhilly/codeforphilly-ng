<template>
  <UContainer>
    <!-- Header with Search and Filters -->
    <div class="mb-8">
      <h1 class="text-3xl font-bold text-gray-900 mb-6">Projects</h1>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <UInput
          v-model="searchQuery"
          placeholder="Search projects..."
          icon="i-lucide-search"
        />
        <USelect
          v-model="selectedStage"
          :items="stages"
          placeholder="All Stages"
        />
      </div>
    </div>

    <!-- Loading and Error States -->
    <div v-if="pending" class="text-center py-12">
      <ULoader class="mx-auto" />
      <p class="mt-2 text-gray-600">Loading projects...</p>
    </div>

    <UAlert
      v-else-if="error"
      color="error"
      :title="error?.message || 'An error occurred'"
      icon="i-lucide-alert-triangle"
    />

    <!-- Projects List -->
    <div v-else class="space-y-6">
      <UCard
        v-for="project in filteredProjects"
        :key="project.id"
        class="hover:shadow-md transition-shadow duration-200"
      >
        <div class="flex items-start justify-between">
          <div class="flex-1">
            <NuxtLink :to="`/projects/${project.handle}`" class="group block">
              <h2 class="text-xl font-semibold text-gray-900 group-hover:text-primary transition-colors">
                {{ project.title }}
              </h2>
              <div class="mt-2 flex items-center space-x-2">
                <UBadge
                  :color="stageColors[project.stage] || 'neutral'"
                  :label="project.stage"
                  variant="subtle"
                  size="sm"
                />
                <span class="text-gray-500 text-sm">
                  Last updated: {{ formatDate(project.modified_at) }}
                </span>
              </div>
            </NuxtLink>
          </div>
          <div class="flex space-x-2">
            <UButton
              v-if="project.developers_url"
              :to="project.developers_url"
              target="_blank"
              color="neutral"
              variant="ghost"
              icon="i-simple-icons-github"
              title="View on GitHub"
            />
            <UButton
              v-if="project.chat_channel"
              :to="`https://codeforphilly.org/chat/${project.chat_channel}`"
              target="_blank"
              color="neutral"
              variant="ghost"
              icon="i-lucide-message-circle"
              title="Join Chat"
            />
          </div>
        </div>

        <p class="mt-4 text-gray-600 line-clamp-3">{{ project.readme }}</p>

        <div class="mt-4 flex flex-wrap gap-2">
          <UBadge
            v-for="tag in project.tags"
            :key="tag.id"
            :label="tag.title"
            color="primary"
            variant="subtle"
            size="sm"
          />
        </div>
      </UCard>
    </div>
  </UContainer>
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

const stageColors = {
  'Hibernating': 'neutral',
  'Prototyping': 'primary',
  'Commenting': 'success',
  'Testing': 'warning',
  'Maintaining': 'info',
  'Drifting': 'error'
} as const

const formatDate = (dateString: string | null) => {
  if (!dateString) return 'N/A'
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

// Initialize refs
const projects = ref<ProjectWithTags[]>([])
const pending = ref(true)
const error = ref<Error | null>(null)

// Fetch data
onMounted(async () => {
  try {
    const client = useSupabaseClient<Database>()
    const { data, error: supabaseError } = await client
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

    if (supabaseError) throw supabaseError
    if (!data) throw new Error('No data returned')

    projects.value = data.map((project: Project & { project_tags: { tags: Tag }[] }) => ({
      ...project,
      tags: project.project_tags
        ?.map(pt => pt.tags)
        .filter((tag): tag is Tag => tag.class === 'tech') || []
    }))
  } catch (e) {
    error.value = e instanceof Error ? e : new Error('An error occurred')
  } finally {
    pending.value = false
  }
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
