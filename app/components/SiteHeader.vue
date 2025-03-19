<template>
  <header class="bg-gray-900 [--ui-primary:theme(colors.white)]">
    <UContainer>
      <div class="flex items-center justify-between h-14">
        <!-- Logo -->
        <NuxtLink to="/" class="flex-shrink-0">
          <img src="~/assets/img/logo-square.svg" alt="Code for Philly" class="h-8">
        </NuxtLink>

        <!-- Navigation -->
        <div class="flex items-center space-x-8">
          <div class="flex items-center space-x-6">
            <UButton
              variant="link"
              label="GET INVOLVED"
              color="primary"
            />
            <UButton
              to="/coming-soon/chat"
              variant="link"
              label="CHAT (SLACK)"
              color="primary"
            />
            <UButton
              to="/coming-soon/about"
              variant="link"
              label="ABOUT"
              color="primary"
            />
          </div>

          <!-- Search -->
          <div class="w-64">
            <UInput
              placeholder="Search"
              icon="i-lucide-search"
              size="sm"
              color="primary"
              variant="outline"
            />
          </div>

          <!-- Auth -->
          <div class="flex items-center space-x-4">
            <UButton
              to="/coming-soon/login"
              variant="link"
              label="LOGIN"
              color="primary"
            />
            <UButton
              to="/coming-soon/signup"
              variant="link"
              label="SIGNUP"
              color="primary"
            />
          </div>
        </div>
      </div>
    </UContainer>
  </header>
</template>
