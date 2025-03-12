<template>
  <footer class="bg-gray-900 text-white py-12">
    <div class="max-w-6xl mx-auto px-4">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
        <!-- Projects -->
        <div class="text-center">
          <NuxtLink to="/projects" class="block text-red-500 hover:text-red-400">
            Active Projects
          </NuxtLink>
          <NuxtLink to="/start" class="block mt-2 text-red-500 hover:text-red-400">
            Start a Project
          </NuxtLink>
          <NuxtLink to="/hackathons" class="block mt-2 text-red-500 hover:text-red-400">
            Hackathons
          </NuxtLink>
        </div>

        <!-- About -->
        <div class="text-center">
          <NuxtLink to="/mission" class="block text-red-500 hover:text-red-400">
            Mission
          </NuxtLink>
          <NuxtLink to="/code-of-conduct" class="block mt-2 text-red-500 hover:text-red-400">
            Code of Conduct
          </NuxtLink>
          <NuxtLink to="/leadership" class="block mt-2 text-red-500 hover:text-red-400">
            Leadership
          </NuxtLink>
        </div>

        <!-- Connect -->
        <div class="text-center">
          <NuxtLink to="/slack" class="block text-red-500 hover:text-red-400">
            Slack
          </NuxtLink>
          <NuxtLink to="/contact" class="block mt-2 text-red-500 hover:text-red-400">
            Contact
          </NuxtLink>
          <NuxtLink to="/meetups" class="block mt-2 text-red-500 hover:text-red-400">
            Weekly Meetups
          </NuxtLink>
        </div>
      </div>

      <div class="mt-12 text-center text-gray-400">
        <p>Copyright © Code For Philly 2011 - {{ new Date().getFullYear() }}</p>
      </div>
    </div>
  </footer>
</template>
