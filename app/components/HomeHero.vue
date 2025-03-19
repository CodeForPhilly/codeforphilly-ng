<template>
  <div class="max-w-6xl mx-auto px-4 py-12">
    <div class="grid md:grid-cols-2 gap-8 items-center">
      <!-- Content -->
      <div class="text-center md:text-left">
        <img src="~/assets/img/logo-square.svg" alt="Code for Philly" class="h-32 mx-auto md:mx-0 mb-8">
        <h1 class="text-2xl font-bold text-blue-700 mb-2">
          Contribute towards technology-related projects that benefit the City of Philadelphia.
        </h1>
        <p class="text-xl text-red-600 mb-6">
          No coding experience required.
        </p>
        <UButton
          icon="i-lucide-handshake"
          label="Volunteer!"
          color="error"
          size="lg"
        />
      </div>

      <!-- Video -->
      <div class="relative aspect-video overflow-hidden rounded-lg shadow-xl">
        <video class="w-full h-full object-cover" autoplay muted loop poster="~/assets/videos/video.jpg">
          <source src="~/assets/videos/video.mp4" type="video/mp4">
          <track label="English" kind="subtitles" srclang="en" src="~/assets/videos/video.en.vtt" :default="true">
        </video>
      </div>
    </div>
  </div>
</template>
