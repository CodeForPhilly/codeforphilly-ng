<template>
  <footer class="bg-gray-900 py-12">
    <UContainer>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
        <!-- Projects -->
        <div class="text-center">
          <UButton
            to="/projects"
            variant="link"
            label="Active Projects"
            color="cta"
            class="block"
          />
          <UButton
            to="/coming-soon/start"
            variant="link"
            label="Start a Project"
            color="cta"
            class="block"
          />
          <UButton
            to="/coming-soon/hackathons"
            variant="link"
            label="Hackathons"
            color="cta"
            class="block"
          />
        </div>

        <!-- About -->
        <div class="text-center">
          <UButton
            to="/coming-soon/mission"
            variant="link"
            label="Mission"
            color="cta"
            class="block"
          />
          <UButton
            to="/coming-soon/code-of-conduct"
            variant="link"
            label="Code of Conduct"
            color="cta"
            class="block"
          />
          <UButton
            to="/coming-soon/leadership"
            variant="link"
            label="Leadership"
            color="cta"
            class="block"
          />
        </div>

        <!-- Connect -->
        <div class="text-center">
          <UButton
            to="/coming-soon/slack"
            variant="link"
            label="Slack"
            color="cta"
            class="block"
          />
          <UButton
            to="/coming-soon/contact"
            variant="link"
            label="Contact"
            color="cta"
            class="block"
          />
          <UButton
            to="/coming-soon/meetups"
            variant="link"
            label="Weekly Meetups"
            color="cta"
            class="block"
          />
        </div>
      </div>

      <div class="mt-12 text-center text-gray-400">
        <p>Copyright © Code For Philly 2011 - {{ new Date().getFullYear() }}</p>
      </div>
    </UContainer>
  </footer>
</template>
