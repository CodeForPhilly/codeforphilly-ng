<template>
  <div class="min-h-screen bg-gray-50">
    <div v-if="project" class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div class="flex justify-between items-center mb-8">
        <h1 class="text-3xl font-bold text-gray-900">{{ project.title }}</h1>
        <UButton
          icon="i-lucide-edit"
          label="Edit Project"
          color="primary"
        />
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <!-- Main content -->
        <div class="lg:col-span-2 space-y-8">
          <section>
            <h2 class="text-xl font-semibold text-gray-900 mb-4">Stage</h2>
            <UButton
              :icon="'i-lucide-flag'"
              :label="project.stage"
              color="primary"
            />
          </section>

          <section>
            <h2 class="text-xl font-semibold text-gray-900 mb-4">README</h2>
            <div class="bg-white rounded-lg shadow-sm overflow-hidden">
              <div class="p-6">
                <h3 class="text-lg font-medium text-gray-900 mb-4">Overview</h3>
                <div v-if="project.readme" class="readme-content prose max-w-none" v-html="renderedReadme"></div>
                <div v-else class="text-gray-500 italic">No README content available.</div>
              </div>
            </div>
          </section>

          <section v-if="project.tags?.length">
            <h2 class="text-xl font-semibold text-gray-900 mb-4">Tags</h2>
            <div class="flex flex-wrap gap-2">
              <span v-for="tag in project.tags" :key="tag.id"
                    class="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium"
                    :class="{
                      'bg-blue-100 text-blue-800': tag.class === 'tech',
                      'bg-green-100 text-green-800': tag.class === 'topic',
                      'bg-purple-100 text-purple-800': tag.class === 'event'
                    }">
                <i :class="{
                  'i-lucide-code': tag.class === 'tech',
                  'i-lucide-bookmark': tag.class === 'topic',
                  'i-lucide-calendar': tag.class === 'event'
                }" class="mr-1.5"></i>
                {{ tag.title }}
              </span>
            </div>
          </section>
        </div>

        <!-- Sidebar -->
        <div class="space-y-6">
          <div class="bg-white rounded-lg shadow-sm overflow-hidden">
            <div class="border-b border-gray-200 bg-gray-50 px-4 py-3">
              <h2 class="text-lg font-medium text-gray-900">Project Info</h2>
            </div>
            <div class="p-4 space-y-3">
              <UButton
                v-if="project.users_url"
                :to="project.users_url"
                target="_blank"
                icon="i-lucide-users"
                label="Users' Site"
                color="primary"
                block
              />

              <UButton
                v-if="project.developers_url"
                :to="project.developers_url"
                target="_blank"
                icon="i-lucide-code-2"
                label="Developers' Site"
                color="secondary"
                block
              />

              <UButton
                v-if="project.chat_channel"
                :to="'https://chat.codeforphilly.org/channel/' + project.chat_channel"
                target="_blank"
                icon="i-lucide-message-circle"
                color="secondary"
                block
              >
                <template #default>
                  <div>
                    Chat Channel
                    <div class="text-sm opacity-75 mt-1">#{{ project.chat_channel }}</div>
                  </div>
                </template>
              </UButton>
            </div>
          </div>

          <div class="bg-white rounded-lg shadow-sm overflow-hidden">
            <div class="border-b border-gray-200 bg-gray-50 px-4 py-3">
              <h2 class="text-lg font-medium text-gray-900">Members</h2>
            </div>
            <div class="p-4">
              <!-- TODO: Add members list once we have the data structure -->
              <UButton
                icon="i-lucide-plus-circle"
                label="Add"
                color="secondary"
                block
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-else-if="error" class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <UAlert
        icon="i-lucide-alert-triangle"
        color="error"
        :title="error?.message || 'An error occurred'"
      />
    </div>

    <div v-else class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div class="flex justify-center">
        <div class="animate-spin rounded-full h-8 w-8 border-4 border-gray-300 border-t-blue-600"></div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { marked } from 'marked'
import type { Database, ProjectWithTags, Tag, TagClass } from '~/types/supabase'

const route = useRoute()
const handle = route.params.handle as string

// Get Supabase client
const client = useSupabaseClient<Database>()

// Define project ref with proper type
const project = ref<ProjectWithTags | null>(null)
const error = ref<Error | null>(null)

// Fetch project data
onMounted(async () => {
  try {
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
      .eq('handle', handle)
      .maybeSingle()

    if (supabaseError) throw supabaseError
    if (!data) throw new Error('Project not found')

    // Transform the nested tags data
    const tags = data.project_tags?.map((pt: { tags: Tag }) => pt.tags).filter(Boolean) || []
    const projectData = { ...data }
    delete projectData.project_tags

    project.value = {
      ...projectData,
      tags: tags.sort((a: Tag, b: Tag) => {
        // Sort by tag class: tech first, then topic, then event
        const classOrder: Record<TagClass, number> = { tech: 1, topic: 2, event: 3 }
        return classOrder[a.class] - classOrder[b.class]
      })
    }
  } catch (e) {
    error.value = e instanceof Error ? e : new Error('An error occurred')
  }
})

// Compute rendered README HTML
const renderedReadme = computed(() => {
  if (!project.value?.readme) return ''
  return marked(project.value.readme, { breaks: true })
})
</script>

<style scoped>
.btn i {
  font-size: 1.1em;
}

.badge {
  font-size: 0.9em;
  padding: 0.6em 1.2em;
}

.readme-content {
  line-height: 1.6;
}

.readme-content :deep(h1),
.readme-content :deep(h2),
.readme-content :deep(h3),
.readme-content :deep(h4),
.readme-content :deep(h5),
.readme-content :deep(h6) {
  margin-top: 1.5em;
  margin-bottom: 0.75em;
}

.readme-content :deep(p) {
  margin-bottom: 1em;
}

.readme-content :deep(ul),
.readme-content :deep(ol) {
  margin-bottom: 1em;
  padding-left: 2em;
}

.readme-content :deep(li) {
  margin-bottom: 0.5em;
}

.readme-content :deep(code) {
  background: #f8f9fa;
  padding: 0.2em 0.4em;
  border-radius: 0.25em;
  font-size: 0.9em;
}

.readme-content :deep(pre) {
  background: #f8f9fa;
  padding: 1em;
  border-radius: 0.5em;
  margin-bottom: 1em;
  overflow-x: auto;
}

.readme-content :deep(pre code) {
  background: none;
  padding: 0;
}

.readme-content :deep(blockquote) {
  border-left: 4px solid #dee2e6;
  padding-left: 1em;
  margin-left: 0;
  margin-bottom: 1em;
  color: #6c757d;
}

.readme-content :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 0.5em;
}

.readme-content :deep(table) {
  width: 100%;
  margin-bottom: 1em;
  border-collapse: collapse;
}

.readme-content :deep(th),
.readme-content :deep(td) {
  padding: 0.75em;
  border: 1px solid #dee2e6;
}

.readme-content :deep(th) {
  background: #f8f9fa;
}
</style>
