<template>
  <div class="relative">
    <!-- Video Background -->
    <div class="absolute inset-0 z-0 overflow-hidden">
      <video class="w-full h-full object-cover" autoplay muted loop poster="~/assets/videos/video.jpg">
        <source src="~/assets/videos/video.mp4" type="video/mp4">
        <track label="English" kind="subtitles" srclang="en" src="/_nuxt/assets/videos/video.en.vtt" default="">
      </video>
      <div class="absolute inset-0 bg-black bg-opacity-50"></div>
    </div>

    <!-- Content -->
    <div class="relative z-10 max-w-6xl mx-auto px-4 py-24 text-center">
      <img src="~/assets/img/logo-square.svg" alt="Code for Philly" class="h-48 mx-auto mb-8">
      <div class="max-w-2xl mx-auto">
        <h1 class="text-2xl font-bold text-white mb-2">
          Contribute towards technology-related projects that benefit the City of Philadelphia.
        </h1>
        <p class="text-xl text-white mb-6">
          No coding experience required.
        </p>
        <button class="bg-red-600 text-white px-6 py-2 rounded hover:bg-red-700">
          Volunteer!
        </button>
      </div>
    </div>
  </div>
</template>
