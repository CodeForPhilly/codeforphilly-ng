<template>
  <div class="bg-gray-50 py-16">
    <UContainer>
      <h2 class="text-3xl font-bold text-center mb-4">
        GET INVOLVED
      </h2>
      <p class="text-center mb-12 text-gray-600">
        We use tech, data, and design as a mode of civic engagement with our local communities.
      </p>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-8 text-center">
        <!-- Sponsor -->
        <div>
          <div class="text-(--ui-cta) mb-4">
            <UIcon
              name="i-lucide-heart-handshake"
              class="h-16 w-16 mx-auto"
            />
          </div>
          <h3 class="font-bold mb-2">
            Sponsor
          </h3>
          <p class="text-sm text-gray-600">
            Sponsor an event
          </p>
        </div>

        <!-- Start a Project -->
        <div>
          <div class="text-(--ui-cta) mb-4">
            <UIcon
              name="i-lucide-rocket"
              class="h-16 w-16 mx-auto"
            />
          </div>
          <h3 class="font-bold mb-2">
            Start a Project
          </h3>
          <p class="text-sm text-gray-600">
            Start or get help on a project
          </p>
        </div>

        <!-- Volunteer -->
        <div>
          <div class="text-(--ui-cta) mb-4">
            <UIcon
              name="i-lucide-users"
              class="h-16 w-16 mx-auto"
            />
          </div>
          <h3 class="font-bold mb-2">
            Volunteer
          </h3>
          <p class="text-sm text-gray-600">
            Join our projects
          </p>
        </div>
      </div>
    </UContainer>
  </div>
</template>
