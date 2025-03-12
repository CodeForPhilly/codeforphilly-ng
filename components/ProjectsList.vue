<template>
  <div class="projects-list">
    <h1 class="text-2xl font-bold mb-4">Code for Philly Projects</h1>

    <div v-if="pending" class="text-center py-4">
      Loading projects...
    </div>

    <div v-else-if="error" class="text-red-500 py-4">
      Error loading projects: {{ error.message }}
    </div>

    <div v-else class="grid gap-4">
      <div v-for="project in projects" :key="project.id"
           class="border rounded-lg p-4 hover:shadow-lg transition-shadow">
        <h2 class="text-xl font-semibold">{{ project.title }}</h2>
        <p class="text-gray-600 mt-2">{{ project.readme }}</p>

        <div class="mt-4 flex gap-2">
          <span class="px-2 py-1 rounded text-sm"
                :class="{
                  'bg-yellow-100 text-yellow-800': project.stage === 'Prototyping',
                  'bg-green-100 text-green-800': project.stage === 'Maintaining',
                  'bg-blue-100 text-blue-800': project.stage === 'Testing',
                  'bg-gray-100 text-gray-800': project.stage === 'Hibernating',
                  'bg-purple-100 text-purple-800': project.stage === 'Commenting',
                  'bg-red-100 text-red-800': project.stage === 'Drifting'
                }">
            {{ project.stage }}
          </span>
        </div>

        <div class="mt-4 flex gap-4">
          <a v-if="project.users_url"
             :href="project.users_url"
             target="_blank"
             class="text-blue-500 hover:text-blue-700">
            View Project
          </a>
          <a v-if="project.developers_url"
             :href="project.developers_url"
             target="_blank"
             class="text-blue-500 hover:text-blue-700">
            View Code
          </a>
          <a v-if="project.chat_channel"
             href="#"
             class="text-blue-500 hover:text-blue-700">
            #{{ project.chat_channel }}
          </a>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
const { data: projects, pending, error } = await useLazyAsyncData('projects', async () => {
  const client = useSupabaseClient()
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
