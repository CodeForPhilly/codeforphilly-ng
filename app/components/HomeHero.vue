<template>
  <UContainer class="py-12">
    <div class="grid grid-cols-12 gap-8 items-center">
      <!-- Video -->
      <div class="col-span-12 lg:col-span-7 relative aspect-video overflow-hidden rounded-lg shadow-xl order-2 lg:order-1">
        <video class="w-full h-full object-cover" autoplay muted loop poster="~/assets/videos/video.jpg">
          <source src="~/assets/videos/video.mp4" type="video/mp4">
          <track label="English" kind="subtitles" srclang="en" src="~/assets/videos/video.en.vtt" :default="true">
        </video>
      </div>

      <!-- Content -->
      <div class="col-span-12 lg:col-span-4 text-center lg:text-left order-1 lg:order-2">
        <img
          src="~/assets/img/logo-square.svg"
          alt="Code for Philly"
          class="h-32 mx-auto lg:mx-0 mb-8"
        />
        <div class="space-y-4 mb-6">
          <h2 class="text-2xl font-bold text-(--ui-primary)">
            Contribute towards technology-related projects that benefit the City of Philadelphia.
          </h2>
          <p class="text-xl text-(--ui-cta)">
            No coding experience required.
          </p>
        </div>
        <UButton
          icon="i-lucide-handshake"
          label="Volunteer!"
          color="cta"
          size="lg"
        />
      </div>
    </div>
  </UContainer>
</template>
