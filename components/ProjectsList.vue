<template>
  <div class="min-h-screen bg-white">
    <!-- Hero Section -->
    <div class="max-w-6xl mx-auto px-4 py-12 text-center">
      <div class="text-red-600 text-6xl font-bold mb-8">
        CODE<br>FOR<br>PHILLY
      </div>
      <div class="max-w-2xl mx-auto">
        <h1 class="text-2xl font-bold text-blue-700 mb-2">
          Contribute towards technology-related projects that benefit the City of Philadelphia.
        </h1>
        <p class="text-xl text-red-600 mb-6">
          No coding experience required.
        </p>
        <button class="bg-red-600 text-white px-6 py-2 rounded hover:bg-red-700">
          Volunteer!
        </button>
      </div>
    </div>

    <!-- Projects Section -->
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

    <!-- Get Involved Section -->
    <div class="bg-gray-50 py-16">
      <div class="max-w-6xl mx-auto px-4">
        <h2 class="text-3xl font-bold text-center mb-4">GET INVOLVED</h2>
        <p class="text-center text-gray-600 mb-12">
          We use tech, data, and design as a mode of civic engagement with our local communities.
        </p>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-8 text-center">
          <!-- Sponsor -->
          <div>
            <div class="text-red-600 mb-4">
              <svg class="h-16 w-16 mx-auto" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-5-9h10v2H7z"/>
              </svg>
            </div>
            <h3 class="font-bold mb-2">Sponsor</h3>
            <p class="text-sm text-gray-600">Sponsor an event</p>
          </div>

          <!-- Start a Project -->
          <div>
            <div class="text-red-600 mb-4">
              <svg class="h-16 w-16 mx-auto" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8l8 5 8-5v10zm-8-7L4 6h16l-8 5z"/>
              </svg>
            </div>
            <h3 class="font-bold mb-2">Start a Project</h3>
            <p class="text-sm text-gray-600">Start or get help on a project</p>
          </div>

          <!-- Volunteer -->
          <div>
            <div class="text-red-600 mb-4">
              <svg class="h-16 w-16 mx-auto" viewBox="0 0 24 24" fill="currentColor">
                <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V18h14v-1.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05.02.01.03.03.04.04 1.14.83 1.93 1.94 1.93 3.41V18h6v-1.5c0-2.33-4.67-3.5-7-3.5z"/>
              </svg>
            </div>
            <h3 class="font-bold mb-2">Volunteer</h3>
            <p class="text-sm text-gray-600">Join our projects</p>
          </div>
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
