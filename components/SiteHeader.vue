<template>
  <header class="bg-gray-900">
    <div class="container mx-auto px-4">
      <div class="flex items-center justify-between h-14">
        <!-- Logo -->
        <NuxtLink to="/" class="flex-shrink-0 text-red-600 font-bold text-xl">
          CfP
        </NuxtLink>

        <!-- Navigation -->
        <div class="flex items-center space-x-8">
          <div class="flex items-center space-x-6">
            <button class="text-white hover:text-gray-300">GET INVOLVED</button>
            <NuxtLink to="/chat" class="text-white hover:text-gray-300">
              CHAT (SLACK)
            </NuxtLink>
            <button class="text-white hover:text-gray-300">ABOUT</button>
          </div>

          <!-- Search -->
          <div class="w-64">
            <input
              type="text"
              placeholder="Search"
              class="w-full px-3 py-1 bg-white rounded text-sm"
            >
          </div>

          <!-- Auth -->
          <div class="flex items-center space-x-4">
            <NuxtLink to="/login" class="text-white hover:text-gray-300">
              LOGIN
            </NuxtLink>
            <NuxtLink to="/signup" class="text-white hover:text-gray-300">
              SIGNUP
            </NuxtLink>
          </div>
        </div>
      </div>
    </div>
  </header>
</template>
