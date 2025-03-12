<template>
  <div v-if="project" class="container py-5">
    <div class="d-flex justify-content-between align-items-center mb-5">
      <h1 class="mb-0 fw-bold">{{ project.title }}</h1>
      <button class="btn btn-info px-4">
        <i class="bi bi-pencil-square me-2"></i>
        Edit Project
      </button>
    </div>

    <div class="row g-4">
      <!-- Main content -->
      <div class="col-md-8">
        <section class="mb-5">
          <h2 class="h4 mb-3">Stage</h2>
          <div class="bg-primary text-white p-3 rounded-3 d-inline-block">
            <i class="bi bi-flag-fill me-2"></i>
            {{ project.stage }}
          </div>
        </section>

        <section class="mb-5">
          <h2 class="h4 mb-3">README</h2>
          <div class="card border-0 shadow-sm">
            <div class="card-body p-4">
              <h3 class="h5 mb-4">Overview</h3>
              <div v-if="project.readme" class="readme-content" v-html="renderedReadme"></div>
              <div v-else class="text-muted fst-italic">No README content available.</div>
            </div>
          </div>
        </section>

        <section v-if="project.tags?.length" class="mb-5">
          <h2 class="h4 mb-3">Tags</h2>
          <div class="d-flex flex-wrap gap-2">
            <span v-for="tag in project.tags" :key="tag.id"
                  class="badge rounded-pill"
                  :class="{
                    'bg-primary': tag.class === 'tech',
                    'bg-success': tag.class === 'topic',
                    'bg-info': tag.class === 'event'
                  }">
              <i :class="{
                'bi-code-slash': tag.class === 'tech',
                'bi-bookmark-fill': tag.class === 'topic',
                'bi-calendar-event': tag.class === 'event'
              }" class="bi me-1"></i>
              {{ tag.title }}
            </span>
          </div>
        </section>
      </div>

      <!-- Sidebar -->
      <div class="col-md-4">
        <div class="card border-0 shadow-sm mb-4">
          <div class="card-header bg-light border-0 py-3">
            <h2 class="h5 mb-0">Project Info</h2>
          </div>
          <div class="card-body p-4">
            <div v-if="project.users_url" class="mb-3">
              <a :href="project.users_url" class="btn btn-primary w-100 py-2" target="_blank">
                <i class="bi bi-people-fill me-2"></i>Users' Site
              </a>
            </div>

            <div v-if="project.developers_url" class="mb-3">
              <a :href="project.developers_url" class="btn btn-success w-100 py-2" target="_blank">
                <i class="bi bi-code-square me-2"></i>Developers' Site
              </a>
            </div>

            <div v-if="project.chat_channel" class="mb-3">
              <a :href="'https://chat.codeforphilly.org/channel/' + project.chat_channel"
                 class="btn btn-success w-100 py-2" target="_blank">
                <i class="bi bi-chat-dots-fill me-2"></i>Chat Channel
                <small class="d-block text-white-50 mt-1">#{{ project.chat_channel }}</small>
              </a>
            </div>
          </div>
        </div>

        <div class="card border-0 shadow-sm">
          <div class="card-header bg-light border-0 py-3">
            <h2 class="h5 mb-0">Members</h2>
          </div>
          <div class="card-body p-4">
            <!-- TODO: Add members list once we have the data structure -->
            <button class="btn btn-success w-100 py-2">
              <i class="bi bi-plus-circle me-2"></i>Add
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div v-else-if="error" class="container py-5">
    <div class="alert alert-danger shadow-sm">
      <i class="bi bi-exclamation-triangle-fill me-2"></i>
      {{ error }}
    </div>
  </div>
  <div v-else class="container py-5">
    <div class="d-flex justify-content-center">
      <div class="spinner-border text-primary" role="status">
        <span class="visually-hidden">Loading...</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { marked } from 'marked'
import type { ProjectWithTags } from '~/types/supabase'

const route = useRoute()
const handle = route.params.handle as string

// Get Supabase client
const client = useSupabaseClient()

// Fetch project data with tags
const { data: project, error } = await useLazyAsyncData<ProjectWithTags>(
  `project-${handle}`,
  async () => {
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
      .eq('handle', handle)
      .maybeSingle()

    if (error) throw error
    if (!data) throw new Error('Project not found')

    // Transform the nested tags data
    const tags = data.project_tags?.map(pt => pt.tags).filter(Boolean) || []
    const projectData = { ...data }
    delete projectData.project_tags
    return { ...projectData, tags }
  },
  {
    default: () => null
  }
)

// Compute rendered README HTML
const renderedReadme = computed(() => {
  if (!project.value?.readme) return ''
  return marked(project.value.readme)
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
